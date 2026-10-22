// `npm run verify:m2` - proves the M2 "done when" (10,000 payments: debits = credits, no duplicates on
// retry) against the real processes. See args.ts for options and analyze.ts for the checks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTerminal, serviceConfig, type AnyEvent, type TrialBalance } from '@ct/contracts';
import { launch, STAGES, type LaunchedSystem, type ServiceName } from '../launcher/launch';
import { mulberry32 } from '../traffic/generator';
import { runTraffic, type TrafficSummary } from '../traffic/run';
import { breakdown, evaluate, LogAnalyzer, type Check, type JournalCounts } from './analyze';
import { brokerHttpUrl, parseVerifyArgs, VERIFY_USAGE, type VerifyArgs } from './args';

const t0 = Date.now();
const say = (msg: string) => console.log(`[verify +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function tryJson<T>(url: string): Promise<T | null> {
  try {
    return await getJson<T>(url);
  } catch (err) {
    say(`  ! ${(err as Error).message}`);
    return null;
  }
}

/** Reads every new event from the broker's /events (pages of 5000) into the analyzer. */
async function pullLog(brokerHttp: string, log: LogAnalyzer): Promise<number> {
  let added = 0;
  for (;;) {
    const page = await getJson<{ offset: number; event: AnyEvent }[]>(`${brokerHttp}/events?from=${log.nextOffset}&limit=5000`);
    for (const { offset, event } of page) log.apply(offset, event);
    added += page.length;
    if (page.length < 5000) return added;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

interface Chaos {
  stop(): Promise<void>;
  kills: { at: string; service: string; downMs: number; restartMs: number; error?: string }[];
}

/** Kills a random stage process or the ledger, waits a bit, restarts it, repeats. Seeded. */
function startChaos(system: LaunchedSystem, seed: number, meanIntervalMs: number): Chaos {
  const rand = mulberry32(seed ^ 0xc4a05);
  const victims: ServiceName[] = [...STAGES, 'ledger'];
  const kills: Chaos['kills'] = [];
  let stopped = false;
  let wake: (() => void) | null = null;
  const nap = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
  const loop = (async () => {
    while (!stopped) {
      await nap(meanIntervalMs * (0.5 + rand()));
      if (stopped) break;
      const service = victims[Math.floor(rand() * victims.length)]!;
      const downMs = Math.round(200 + rand() * 1300);
      const k: Chaos['kills'][number] = { at: new Date().toISOString(), service, downMs, restartMs: 0 };
      kills.push(k);
      say(`chaos: kill -9 ${service}, restart in ${downMs} ms`);
      try {
        await system.kill(service);
        await sleep(downMs);
        const r0 = Date.now();
        await system.restart(service);
        k.restartMs = Date.now() - r0;
        say(`chaos: ${service} back (ready in ${k.restartMs} ms)`);
      } catch (err) {
        k.error = (err as Error).message.split('\n')[0];
        say(`chaos: ${service} restart FAILED: ${k.error}`);
      }
    }
  })();
  return {
    kills,
    stop: async () => {
      stopped = true;
      (wake as (() => void) | null)?.();
      await loop;
      // Leave everything running for the final checks.
      for (const v of victims) if (!system.isRunning(v)) await system.restart(v);
    },
  };
}

async function main(): Promise<number> {
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(VERIFY_USAGE);
    return 0;
  }
  const config = serviceConfig();
  const seed = args.seed ?? (args.url ? Date.now() % 1_000_000_000 : 42);
  const timeoutMs = args.timeoutMs ?? 120_000 + args.count * 60;

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
    if (tmpDir && !args.keep) rmSync(tmpDir, { recursive: true, force: true });
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  try {
    if (args.url) {
      urls.gateway = args.url;
      urls.api = args.apiUrl ?? config.paymentApiUrl;
      urls.brokerHttp = brokerHttpUrl(args.brokerUrl ?? config.brokerUrl);
      urls.ledger = args.ledgerUrl ?? config.ledgerUrl;
      say(`targeting a running system: gateway ${urls.gateway}, api ${urls.api}, broker ${urls.brokerHttp}, ledger ${urls.ledger}`);
    } else {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ct-verify-'));
      const p = args.basePort;
      say(`launching the system on ports ${p}-${p + 3} (data ${tmpDir}, delays 0)...`);
      const logTail: string[] = [];
      system = await launch({
        host: '127.0.0.1',
        ports: { broker: p, paymentApi: p + 1, gateway: p + 2, ledger: p + 3 },
        dataDir: tmpDir,
        stageDelayMs: 0,
        settlementDelayMs: 0,
        providerFailureScale: args.providerFailureScale,
        databaseUrl: '',
        quiet: !args.verbose,
        buildWeb: false,
        startupTimeoutMs: 60_000,
        env: { BUS: 'local' },
        log: (line) => {
          if (args.verbose) console.log(line);
          logTail.push(line);
          if (logTail.length > 50) logTail.shift();
        },
        onUnexpectedExit: (err) => {
          crashed = err;
        },
      });
      urls.gateway = system.urls.gateway;
      urls.api = system.urls.paymentApi;
      urls.brokerHttp = brokerHttpUrl(system.urls.broker);
      urls.ledger = system.urls.ledger;
      say(`system up in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${system.services.join(', ')}`);
    }

    const log = new LogAnalyzer();
    await pullLog(urls.brokerHttp, log); // existing history (url mode)
    const chaos = args.chaos && system ? startChaos(system, seed, args.chaosIntervalMs) : null;

    // ---- traffic
    const mixText = Object.entries(args.mix).map(([k, v]) => `${k} ${((v ?? 0) * 100).toFixed(1)}%`).join(', ') || 'none';
    say(`sending ${args.count} payments (seed ${seed}, rate ${args.rate || 'unlimited'}/s, concurrency ${args.concurrency}, mix ${mixText}${chaos ? ', CHAOS on' : ''})`);
    let sentSoFar = 0;
    const trafficStart = Date.now();
    const sendProgress = setInterval(() => say(`  sent ${sentSoFar}/${args.count}`), 2000);
    let traffic: TrafficSummary;
    try {
      traffic = await runTraffic({
        url: urls.api,
        seed,
        count: args.count,
        rate: args.rate,
        concurrency: args.concurrency,
        mix: args.mix,
        retries: 5,
        shouldStop: () => crashed !== null,
        onResult: () => {
          sentSoFar += 1;
        },
      });
    } finally {
      clearInterval(sendProgress);
    }
    const sent = [...new Set(traffic.results.map((r) => r.result.paymentId).filter((x): x is string => Boolean(x)))];
    say(
      `traffic done: ${traffic.counts.accepted} accepted, ${traffic.counts.duplicate} duplicate, ${traffic.counts.error} error(s), ` +
        `${traffic.retried} retried request(s), ${traffic.achievedRate.toFixed(1)} payments/s`,
    );
    const firstErrors = traffic.results.filter((r) => r.result.outcome === 'error').slice(0, 5);
    for (const e of firstErrors) say(`  ! #${e.payment.index}: ${e.result.status ?? ''} ${e.result.detail ?? ''}`);

    // ---- wait for every payment to be terminal
    const deadline = Date.now() + timeoutMs;
    let lastProgress = -1;
    let lastProgressAt = Date.now();
    let lastPrint = 0;
    let terminal = 0;
    for (;;) {
      if (crashed) throw crashed;
      await pullLog(urls.brokerHttp, log);
      terminal = 0;
      const byStatus: Record<string, number> = {};
      for (const id of sent) {
        const st = log.payments.get(id)?.state.status ?? 'missing';
        byStatus[st] = (byStatus[st] ?? 0) + 1;
        if (st !== 'missing' && isTerminal(st)) terminal += 1;
      }
      if (terminal !== lastProgress) {
        lastProgress = terminal;
        lastProgressAt = Date.now();
      }
      if (Date.now() - lastPrint > 2000 || terminal === sent.length) {
        lastPrint = Date.now();
        const parts = Object.entries(byStatus).sort().map(([k, v]) => `${k} ${v}`).join(', ');
        say(`  terminal ${terminal}/${sent.length} | log ${log.events} events | ${parts}`);
      }
      if (terminal === sent.length) break;
      if (Date.now() > deadline) {
        say(`TIMEOUT after ${timeoutMs} ms waiting for terminal statuses`);
        break;
      }
      if (Date.now() - lastProgressAt > 120_000 && !chaos) {
        say('no progress for 120 s, giving up waiting');
        break;
      }
      await sleep(1000);
    }
    const pipelineMs = Date.now() - trafficStart;
    if (chaos) {
      say(`stopping chaos (${chaos.kills.length} kill(s))...`);
      await chaos.stop();
    }
    // Let stragglers land (e.g. a duplicate a restarted stage might still publish), then read the final log.
    await sleep(1500);
    await pullLog(urls.brokerHttp, log);

    // ---- ledger + gateway
    say('checking the ledger and the gateway...');
    const trialBalance = await tryJson<TrialBalance>(`${urls.ledger}/ledger/trial-balance`);
    const invariants = await tryJson<{ ok: boolean; violations: string[] }>(`${urls.ledger}/ledger/invariants`);
    let journals: JournalCounts | null = { byPayment: new Map(), totalJournals: trialBalance?.journals };
    let journalErrors = 0;
    const terminalIds = sent.filter((id) => {
      const s = log.payments.get(id)?.state.status;
      return s !== undefined && isTerminal(s);
    });
    const j0 = Date.now();
    await mapLimit(terminalIds, 32, async (id) => {
      try {
        const js = await getJson<unknown[]>(`${urls.ledger}/ledger/journals?paymentId=${encodeURIComponent(id)}&limit=10`);
        journals!.byPayment.set(id, js.length);
      } catch {
        journalErrors += 1;
        journals!.byPayment.set(id, undefined);
      }
    });
    say(`  looked up journals for ${terminalIds.length} payments in ${((Date.now() - j0) / 1000).toFixed(1)} s${journalErrors ? ` (${journalErrors} failed)` : ''}`);
    if (journalErrors === terminalIds.length && terminalIds.length > 0) journals = null;

    // The gateway projection may trail the log by a moment.
    let gatewayStats: { rejectedEvents: number; total: number } | null = null;
    for (let i = 0; i < 30; i++) {
      gatewayStats = await tryJson<{ rejectedEvents: number; total: number }>(`${urls.gateway}/api/stats`);
      if (!gatewayStats || gatewayStats.total >= log.payments.size) break;
      await sleep(1000);
    }

    const checks: Check[] = evaluate({
      log,
      sent,
      trafficErrors: traffic.counts.error + (args.count - traffic.results.length),
      trialBalance,
      invariants,
      journals,
      gatewayRejectedEvents: gatewayStats?.rejectedEvents ?? null,
      ownSystem: system !== null,
    });
    if (crashed) checks.push({ id: 'system', title: 'No service crashed unexpectedly', ok: false, detail: String((crashed as Error).message).split('\n')[0]! });
    if (chaos) {
      const failedRestarts = chaos.kills.filter((k) => k.error);
      checks.push({
        id: 'chaos.restarts',
        title: 'Every chaos-killed service came back',
        ok: failedRestarts.length === 0,
        detail: `${chaos.kills.length} kill(s), ${failedRestarts.length} failed restart(s)`,
        examples: failedRestarts.length ? failedRestarts : undefined,
      });
    }
    const stats = breakdown(log, sent);
    const ok = checks.every((c) => c.ok);
    const durationMs = Date.now() - t0;
    const report = {
      ok,
      generatedAt: new Date().toISOString(),
      mode: system ? 'launched' : 'url',
      urls,
      params: { count: args.count, seed, rate: args.rate, concurrency: args.concurrency, mix: args.mix, chaos: args.chaos, chaosIntervalMs: args.chaos ? args.chaosIntervalMs : undefined },
      checks,
      counts: stats,
      throughput: {
        totalDurationS: +(durationMs / 1000).toFixed(1),
        trafficDurationS: +(traffic.durationMs / 1000).toFixed(1),
        intakePaymentsPerS: +traffic.achievedRate.toFixed(1),
        pipelineDurationS: +(pipelineMs / 1000).toFixed(1),
        endToEndPaymentsPerS: +((sent.length * 1000) / pipelineMs).toFixed(1),
        logEvents: log.events,
        eventsPerS: +((log.events * 1000) / pipelineMs).toFixed(1),
        requestRetries: traffic.retried,
      },
      ledger: trialBalance ? { journals: trialBalance.journals, entries: trialBalance.entries, byCurrency: trialBalance.byCurrency } : null,
      gateway: gatewayStats,
      chaos: chaos ? { kills: chaos.kills } : undefined,
    };

    const reportDir = path.resolve(args.reportDir ?? path.join(config.dataDir, 'reports'));
    mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `verify-m2-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

    // ---- print
    console.log('');
    console.log(`M2 verification: ${sent.length} payments, ${log.events} events, ${(durationMs / 1000).toFixed(1)} s total`);
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.title}\n        ${c.detail}`);
    for (const c of checks.filter((x) => !x.ok && x.examples)) console.log(`  examples for ${c.id}: ${JSON.stringify(c.examples).slice(0, 1500)}`);
    console.log(`  status:    ${JSON.stringify(stats.byStatus)}`);
    console.log(`  corridor:  ${Object.entries(stats.byCorridor).map(([k, v]) => `${k} ${v.total}`).join(', ')}`);
    console.log(`  provider:  ${Object.entries(stats.byProvider).map(([k, v]) => `${k} ${v.total}`).join(', ')}`);
    console.log(`  scenario:  ${Object.entries(stats.byScenario).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join('; ')}`);
    console.log(`  retries:   ${JSON.stringify(stats.retries)}; recon breaks ${stats.reconBreaks}`);
    console.log(`  latency:   initiated->terminal p50 ${stats.latencyMs.p50} ms, p95 ${stats.latencyMs.p95} ms, max ${stats.latencyMs.max} ms`);
    console.log(
      `  throughput: intake ${report.throughput.intakePaymentsPerS}/s, end-to-end ${report.throughput.endToEndPaymentsPerS} payments/s, ${report.throughput.eventsPerS} events/s`,
    );
    if (chaos) console.log(`  chaos:     ${chaos.kills.length} kills: ${chaos.kills.map((k) => k.service).join(', ')}`);
    console.log(`\n${ok ? 'ALL CHECKS PASSED' : 'VERIFICATION FAILED'} - report: ${reportPath}`);
    return ok ? 0 : 1;
  } catch (err) {
    console.error(`\nverify:m2 aborted: ${(err as Error).message}`);
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
