// `npm run loadtest -- --rate <pps|ramp> --duration <s> --report <file>`
// Drives synthetic payments at stepped rising rates against the real processes and measures end-to-end
// throughput, latency (payment.initiated -> terminal, from the event log), backlog, errors and the
// saturation point. See args.ts for options and report.ts for the maths. Synthetic, simulated providers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTerminal, serviceConfig, type AnyEvent, type TrialBalance } from '@ct/contracts';
import { launch, type LaunchedSystem } from '../launcher/launch';
import { runTraffic } from '../traffic/run';
import { evaluate, LogAnalyzer, type JournalCounts } from '../verify/analyze';
import { brokerHttpUrl } from '../verify/args';
import { LOAD_USAGE, parseLoadArgs, plannedRates, type LoadArgs } from './args';
import { findSaturation, latencyStats, renderMarkdown, summarizeStep, type LoadReport, type PaymentRecord, type StepResult, type StepWindow } from './report';

const t0 = Date.now();
const say = (msg: string) => console.log(`[loadtest +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }),
  );
}

async function main(): Promise<number> {
  let args: LoadArgs;
  try {
    args = parseLoadArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(LOAD_USAGE);
    return 0;
  }
  const config = serviceConfig();
  const seed = args.seed ?? (args.url ? Date.now() % 1_000_000_000 : 7001);
  const rates = plannedRates(args);

  let system: LaunchedSystem | null = null;
  let tmpDir: string | null = null;
  let crashed: Error | null = null;
  const urls = { gateway: '', api: '', brokerHttp: '', ledger: '' };
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (system) {
      say('stopping the launched system...');
      await system.stop();
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  try {
    if (args.url) {
      urls.gateway = args.url;
      urls.api = args.apiUrl ?? config.paymentApiUrl;
      urls.brokerHttp = brokerHttpUrl(args.brokerUrl ?? config.brokerUrl);
      urls.ledger = args.ledgerUrl ?? config.ledgerUrl;
      say(`attached to a running system: api ${urls.api}, broker ${urls.brokerHttp}, ledger ${urls.ledger}`);
    } else {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ct-loadtest-'));
      const p = args.basePort;
      say(`launching the system on ports ${p}-${p + 3} (temp data dir, stageDelayMs 0, settlementDelayMs 0)...`);
      system = await launch({
        host: '127.0.0.1',
        ports: { broker: p, paymentApi: p + 1, gateway: p + 2, ledger: p + 3 },
        dataDir: tmpDir,
        stageDelayMs: 0,
        settlementDelayMs: 0,
        databaseUrl: '',
        quiet: !args.verbose,
        buildWeb: false,
        startupTimeoutMs: 60_000,
        env: { BUS: 'local' },
        log: (line) => {
          if (args.verbose) console.log(line);
        },
        onUnexpectedExit: (err) => {
          crashed = err;
        },
      });
      urls.gateway = system.urls.gateway;
      urls.api = system.urls.paymentApi;
      urls.brokerHttp = brokerHttpUrl(system.urls.broker);
      urls.ledger = system.urls.ledger;
      say(`system up: ${system.services.join(', ')}`);
    }

    const log = new LogAnalyzer();
    const pullLog = async (): Promise<void> => {
      for (;;) {
        const page = await getJson<{ offset: number; event: AnyEvent }[]>(`${urls.brokerHttp}/events?from=${log.nextOffset}&limit=5000`);
        for (const { offset, event } of page) log.apply(offset, event);
        if (page.length < 5000) return;
      }
    };
    await pullLog();

    // Background log reader so memory of "when did it finish" is the log's own timestamps, not our polling.
    let pulling = true;
    const poller = (async () => {
      while (pulling) {
        try {
          await pullLog();
        } catch {
          /* transient while saturated; the next pull catches up */
        }
        await sleep(500);
      }
    })();

    const sent: string[] = [];
    const sentSet = new Set<string>();
    const records = (): PaymentRecord[] =>
      sent.map((id) => log.payments.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined).map((p) => ({ initiatedAt: p.firstAt, terminalAt: p.terminalAt, status: p.state.status }));

    const windows: StepWindow[] = [];
    const steps: StepResult[] = [];
    let index = 0;
    let requestErrors = 0;
    for (let i = 0; i < rates.length; i++) {
      const rate = rates[i]!;
      const count = Math.max(1, Math.round(rate * args.duration));
      say(`step ${i + 1}/${rates.length}: offering ${rate}/s for ${args.duration} s (${count} payments, concurrency ${args.concurrency})`);
      const startMs = Date.now();
      const summary = await runTraffic({
        url: urls.api,
        seed,
        count,
        start: index,
        rate,
        concurrency: args.concurrency,
        mix: args.mix,
        retries: 0, // a failed request is an error in the report, not hidden by a retry
        shouldStop: () => crashed !== null,
      });
      const endMs = Date.now();
      index += count;
      for (const r of summary.results) {
        const id = r.result.paymentId;
        if (id && !sentSet.has(id)) {
          sentSet.add(id);
          sent.push(id);
        }
      }
      requestErrors += summary.counts.error;
      windows.push({
        index: i,
        offeredRate: rate,
        startMs,
        endMs,
        sent: summary.results.length,
        accepted: summary.counts.accepted + summary.counts.duplicate,
        errors: summary.counts.error,
      });
      if (crashed) throw crashed;
      await pullLog();
      const prov = summarizeStep(windows[i]!, records());
      say(
        `  accepted ${prov.intakeRate.toFixed(1)}/s, completed ${prov.completedRate.toFixed(1)}/s, backlog ${prov.backlogEnd}, ` +
          `errors ${prov.errors}${prov.saturated ? ` -> SATURATED (${prov.saturationReason})` : ''}`,
      );
      if (prov.saturated && !args.noStop) {
        say('saturation reached; stopping the ramp (use --no-stop to continue)');
        break;
      }
    }

    // Drain: wait until every accepted payment is terminal (or no progress / timeout).
    const drainStart = Date.now();
    let lastTerminal = -1;
    let lastProgressAt = Date.now();
    for (;;) {
      if (crashed) throw crashed;
      const recs = records();
      const terminal = recs.filter((r) => r.terminalAt !== undefined).length;
      if (terminal !== lastTerminal) {
        lastTerminal = terminal;
        lastProgressAt = Date.now();
      }
      if (terminal >= sent.length) break;
      if (Date.now() - drainStart > args.drainTimeoutMs) {
        say(`drain timeout: ${sent.length - terminal} payment(s) still not terminal`);
        break;
      }
      if (Date.now() - lastProgressAt > 30_000) {
        say('no progress for 30 s, giving up on the drain');
        break;
      }
      await sleep(500);
    }
    const drainS = (Date.now() - drainStart) / 1000;
    pulling = false;
    await poller;
    await sleep(1500);
    await pullLog();
    say(`drained in ${drainS.toFixed(1)} s; checking ledger integrity...`);

    const finalRecords = records();
    for (const w of windows) steps.push(summarizeStep(w, finalRecords));

    // ---- integrity: same checks as verify:m2 (trial balance, journals, duplicates, state machine, stuck)
    const trialBalance = await getJson<TrialBalance>(`${urls.ledger}/ledger/trial-balance`).catch(() => null);
    const invariants = await getJson<{ ok: boolean; violations: string[] }>(`${urls.ledger}/ledger/invariants`).catch(() => null);
    const journals: JournalCounts = { byPayment: new Map(), totalJournals: trialBalance?.journals };
    const terminalIds = sent.filter((id) => {
      const s = log.payments.get(id)?.state.status;
      return s !== undefined && isTerminal(s);
    });
    await mapLimit(terminalIds, 32, async (id) => {
      try {
        const js = await getJson<unknown[]>(`${urls.ledger}/ledger/journals?paymentId=${encodeURIComponent(id)}&limit=10`);
        journals.byPayment.set(id, js.length);
      } catch {
        journals.byPayment.set(id, undefined);
      }
    });
    const gw = await getJson<{ rejectedEvents: number }>(`${urls.gateway}/api/stats`).catch(() => null);
    const checks = evaluate({
      log,
      sent,
      trafficErrors: requestErrors,
      trialBalance,
      invariants,
      journals,
      gatewayRejectedEvents: gw?.rejectedEvents ?? null,
      ownSystem: system !== null,
    }).map(({ id, title, ok, detail }) => ({ id, title, ok, detail }));

    const byStatus: Record<string, number> = {};
    for (const r of finalRecords) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const reconciledLat = finalRecords.filter((r) => r.status === 'reconciled' && r.terminalAt !== undefined).map((r) => r.terminalAt! - r.initiatedAt);
    const saturation = findSaturation(steps);
    const cpus = os.cpus();
    const report: LoadReport = {
      generatedAt: new Date().toISOString(),
      machine: {
        cpuModel: cpus[0]?.model.trim() ?? 'unknown',
        logicalCpus: cpus.length,
        totalMemGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        platform: os.platform(),
        osRelease: os.release(),
        node: process.version,
      },
      config: {
        stageDelayMs: system ? 0 : 'unknown (attached to a running system)',
        settlementDelayMs: system ? 0 : 'unknown (attached to a running system)',
        bus: system ? 'local broker (append-only file log)' : 'unknown',
        ledger: system ? 'embedded PGlite' : 'unknown',
        seed,
        offeredRates: rates,
        secondsPerStep: args.duration,
        senderConcurrency: args.concurrency,
        scenarioMix: args.mix,
        requestRetries: 0,
        stoppedAtSaturation: !args.noStop,
        latencyDefinition: 'payment.initiated occurredAt to first terminal event occurredAt, same machine clock, reconciled payments only',
      },
      mode: system ? 'launched' : 'attached',
      steps,
      overall: {
        sent: windows.reduce((a, w) => a + w.sent, 0),
        accepted: windows.reduce((a, w) => a + w.accepted, 0),
        requestErrors,
        terminal: finalRecords.filter((r) => r.terminalAt !== undefined).length,
        reconciled: byStatus.reconciled ?? 0,
        notTerminalAtEnd: sent.length - finalRecords.filter((r) => r.terminalAt !== undefined).length,
        byStatus,
        latencyMs: latencyStats(reconciledLat),
        totalS: +((Date.now() - (windows[0]?.startMs ?? t0)) / 1000).toFixed(1),
        drainS: +drainS.toFixed(1),
      },
      saturation,
      checks,
      ok: checks.every((c) => c.ok),
    };

    const jsonPath = path.resolve(args.report ?? path.join(config.dataDir, 'reports', `loadtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    const mdPath = jsonPath.replace(/\.json$/i, '') + '.md';
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
    writeFileSync(mdPath, renderMarkdown(report));

    console.log('');
    console.log(renderMarkdown(report));
    console.log(`reports: ${jsonPath}\n         ${mdPath}`);
    return report.ok ? 0 : 1;
  } catch (err) {
    console.error(`\nloadtest aborted: ${(err as Error).message}`);
    return 1;
  } finally {
    await cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
