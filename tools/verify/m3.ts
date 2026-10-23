// `npm run verify:m3` - Gate 2 for M3 ("first scenario live"): the provider-outage scenario runs
// OFFLINE N times in a row (default 10) and the ledger balances. Everything runs on 127.0.0.1.
//
// Per run: POST /scenarios/<id>/start -> wait for control.scenario.ended (broker /events) -> wait until
// the provider has normal traffic again -> stop ambient traffic and let in-flight payments finish ->
// checks (m3-analyze.ts + analyze.ts) -> POST /reset (launcher control API) and time it.
// See m3-args.ts for options.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTerminal, serviceConfig, type BusEvent, type ControlView, type OrchestratorState, type TrialBalance } from '@ct/contracts';
import { breakerFor } from '@ct/market';
import { launch, type LaunchedSystem } from '../launcher/launch';
import type { ResetResult } from '../launcher/control';
import { evaluate, LogAnalyzer, type Check, type JournalCounts } from './analyze';
import { brokerHttpUrl } from './args';
import {
  checkBreakerOpened,
  checkControlSequence,
  checkNoTrafficWhileOpen,
  checkRecovery,
  checkReset,
  findBreakerOpen,
  findOpenViolations,
  findRecovery,
  recoveryComplete,
  runTimeline,
  ScenarioLog,
  type BreakerStateName,
} from './m3-analyze';
import { parseVerifyM3Args, VERIFY_M3_USAGE, type VerifyM3Args } from './m3-args';

const t0 = Date.now();
const say = (msg: string) => console.log(`[verify:m3 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function tryJson<T>(url: string): Promise<T | null> {
  try {
    return await getJson<T>(url);
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown = {}, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T };
}

/** Both views of the log: payment states (analyze.ts) and the M3 facts (m3-analyze.ts). */
class RunLog {
  readonly log = new LogAnalyzer();
  readonly scen = new ScenarioLog();
  async pull(brokerHttp: string): Promise<number> {
    let added = 0;
    for (;;) {
      const page = await getJson<{ offset: number; event: BusEvent }[]>(`${brokerHttp}/events?from=${this.log.nextOffset}&limit=5000`);
      for (const { offset, event } of page) {
        this.log.apply(offset, event);
        this.scen.apply(offset, event);
      }
      added += page.length;
      if (page.length < 5000) return added;
    }
  }
}

interface Urls {
  gateway: string;
  api: string;
  brokerHttp: string;
  ledger: string;
  orchestrator: string;
  control: string | null;
}

interface BreakerObservation {
  at: string;
  state: BreakerStateName;
  since: string | null;
  reason: string;
}

interface RunReport {
  run: number;
  runId: string | null;
  ok: boolean;
  checks: Check[];
  payments: number;
  events: number;
  byStatus: Record<string, number>;
  durations: { scenarioS: number | null; recoveryWaitS: number; drainS: number; totalS: number };
  breaker: {
    openAfterOutageS: number | null;
    openWindowS: number | null;
    violations: number;
    violationDetails: unknown[];
    recovery: ReturnType<typeof findRecovery>;
    gatewayObservations: BreakerObservation[];
  };
  reset: (ResetResult & { clientMs: number }) | { error: string; clientMs: number } | null;
}

async function main(): Promise<number> {
  let args: VerifyM3Args;
  try {
    args = parseVerifyM3Args(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(VERIFY_M3_USAGE);
    return 0;
  }
  const config = serviceConfig();
  let system: LaunchedSystem | null = null;
  let tmpDir: string | null = null;
  let crashed: Error | null = null;
  let stopping = false;
  const urls: Urls = { gateway: '', api: '', brokerHttp: '', ledger: '', orchestrator: '', control: null };
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (system) {
      say('stopping the launched system...');
      await system.stop();
    }
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  const runs: RunReport[] = [];
  let dataDir = path.resolve(config.dataDir);
  try {
    if (args.url) {
      urls.gateway = args.url;
      urls.api = config.paymentApiUrl;
      urls.brokerHttp = brokerHttpUrl(args.brokerUrl ?? config.brokerUrl);
      urls.ledger = args.ledgerUrl ?? config.ledgerUrl;
      urls.orchestrator = args.orchestratorUrl ?? config.orchestratorUrl;
      urls.control = args.controlUrl ?? (config.launcherControlUrl || null);
      say(`targeting a running system: gateway ${urls.gateway}, broker ${urls.brokerHttp}, orchestrator ${urls.orchestrator}, control ${urls.control ?? '(none: no resets)'}`);
    } else {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ct-verify-m3-'));
      dataDir = tmpDir;
      const p = args.basePort;
      say(`launching the system on ports ${p}-${p + 4}, control ${p + 9} (data ${tmpDir}, ambient ${args.ambientRate}/s, delays ${args.stageDelayMs}/${args.settlementDelayMs} ms)...`);
      system = await launch({
        host: '127.0.0.1',
        ports: { broker: p, paymentApi: p + 1, gateway: p + 2, ledger: p + 3, orchestrator: p + 4 },
        controlPort: p + 9,
        dataDir: tmpDir,
        ambientRate: args.ambientRate,
        stageDelayMs: args.stageDelayMs,
        settlementDelayMs: args.settlementDelayMs,
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
      urls.orchestrator = system.urls.orchestrator;
      urls.control = system.urls.control ?? null;
      say(`system up in ${(system.startup.totalMs / 1000).toFixed(1)} s (slowest: ${slowest(system.startup.ready)})`);
    }

    for (let run = 1; run <= args.runs; run++) {
      if (crashed) throw crashed;
      const report = await oneRun(run, args, urls, () => crashed);
      runs.push(report);
      const failed = report.checks.filter((c) => !c.ok);
      say(
        `run ${run}/${args.runs}: ${report.ok ? 'PASS' : 'FAIL'} - ${report.payments} payments, breaker open +${fmtS(report.breaker.openAfterOutageS)}, ` +
          `open window ${fmtS(report.breaker.openWindowS)}, reset ${report.reset && 'durationMs' in report.reset ? `${(report.reset.durationMs / 1000).toFixed(2)} s` : 'n/a'}` +
          (failed.length ? ` | FAILED: ${failed.map((c) => c.id).join(', ')}` : ''),
      );
      for (const c of failed) say(`    ${c.id}: ${c.detail}${c.examples ? ` ${JSON.stringify(c.examples).slice(0, 600)}` : ''}`);
    }
  } catch (err) {
    say(`aborted: ${(err as Error).message}`);
    runs.push({
      run: runs.length + 1,
      runId: null,
      ok: false,
      checks: [{ id: 'aborted', title: 'The run completed', ok: false, detail: (err as Error).message.split('\n')[0]! }],
      payments: 0,
      events: 0,
      byStatus: {},
      durations: { scenarioS: null, recoveryWaitS: 0, drainS: 0, totalS: 0 },
      breaker: { openAfterOutageS: null, openWindowS: null, violations: 0, violationDetails: [], recovery: { firstAttemptRoutes: 0, probes: 0, settled: 0, firstSettledAfterMs: null }, gatewayObservations: [] },
      reset: null,
    });
  } finally {
    await cleanup();
  }

  // ---- report
  const ok = runs.length === args.runs && runs.every((r) => r.ok);
  const resetMs = runs.flatMap((r) => (r.reset && 'durationMs' in r.reset ? [r.reset.durationMs] : []));
  const summary = {
    runs: runs.length,
    passed: runs.filter((r) => r.ok).length,
    payments: runs.reduce((a, r) => a + r.payments, 0),
    resetMs: resetMs.length ? { min: Math.min(...resetMs), max: Math.max(...resetMs), avg: Math.round(resetMs.reduce((a, b) => a + b, 0) / resetMs.length) } : null,
    breakerOpenAfterOutageS: minMax(runs.map((r) => r.breaker.openAfterOutageS)),
    totalDurationS: +((Date.now() - t0) / 1000).toFixed(1),
  };
  const reportDir = path.resolve(args.reportDir ?? path.join(dataDir, 'reports'));
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `verify-m3-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ok,
        generatedAt: new Date().toISOString(),
        mode: args.url ? 'url' : 'launched',
        urls,
        params: { ...args, help: undefined },
        summary,
        runs,
      },
      null,
      2,
    ) + '\n',
  );

  console.log('');
  console.log(`M3 Gate 2: ${args.scenario} x ${args.runs}`);
  const ids = [...new Set(runs.flatMap((r) => r.checks.map((c) => c.id)))];
  // One column per letter (a)-(h); a letter passes when every check under it passed.
  const letters = [...new Set(ids.map((i) => i.split('.')[0]!))];
  const header = ['run', 'payments', 'open+s', 'window s', 'reset s', ...letters, 'result'];
  const rows = runs.map((r) => [
    String(r.run),
    String(r.payments),
    fmtS(r.breaker.openAfterOutageS),
    fmtS(r.breaker.openWindowS),
    r.reset && 'durationMs' in r.reset ? (r.reset.durationMs / 1000).toFixed(2) : '-',
    ...letters.map((l) => {
      const cs = r.checks.filter((x) => x.id.split('.')[0] === l);
      return cs.length === 0 ? '-' : cs.every((c) => c.ok) ? 'ok' : 'FAIL';
    }),
    r.ok ? 'PASS' : 'FAIL',
  ]);
  console.log(table([header, ...rows]));
  console.log('  open+s = breaker seen open (CIRCUIT_OPEN) after the outage started; window s = open until the first half-open sign');
  for (const l of letters) console.log(`  ${l}: ${ids.filter((i) => i.startsWith(`${l}.`)).map((i) => i.slice(l.length + 1)).join(', ')}`);
  console.log(
    `  summary: ${summary.passed}/${args.runs} runs passed, ${summary.payments} payments; reset ` +
      (summary.resetMs ? `min ${(summary.resetMs.min / 1000).toFixed(2)} s, avg ${(summary.resetMs.avg / 1000).toFixed(2)} s, max ${(summary.resetMs.max / 1000).toFixed(2)} s` : 'n/a') +
      `; breaker open after outage ${summary.breakerOpenAfterOutageS ?? 'n/a'}; total ${summary.totalDurationS} s`,
  );
  console.log(`\n${ok ? 'GATE 2 PASSED' : 'GATE 2 FAILED'} - report: ${reportPath}`);
  if (tmpDir && !args.keep) {
    // Keep only the report (it lives in the temp data dir); the event log and ledger go.
    for (const entry of readdirSync(tmpDir)) {
      if (path.join(tmpDir, entry) !== reportDir) rmSync(path.join(tmpDir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
  return ok ? 0 : 1;
}

async function oneRun(run: number, args: VerifyM3Args, urls: Urls, crashed: () => Error | null): Promise<RunReport> {
  const r0 = Date.now();
  const rl = new RunLog();
  await rl.pull(urls.brokerHttp);

  // 1. Start the scenario.
  const orch = await getJson<OrchestratorState>(`${urls.orchestrator}/state`);
  const info = orch.scenarios.find((s) => s.id === args.scenario);
  if (!info) throw new Error(`orchestrator has no scenario "${args.scenario}" (has: ${orch.scenarios.map((s) => s.id).join(', ')})`);
  if (orch.activeRun) throw new Error(`a scenario run is already active (${orch.activeRun.runId})`);
  const started = await postJson<{ runId?: string; error?: string }>(`${urls.orchestrator}/scenarios/${encodeURIComponent(args.scenario)}/start`, args.seed ? { seed: args.seed } : {});
  if (started.status !== 200 || !started.body.runId) throw new Error(`could not start the scenario: ${started.status} ${JSON.stringify(started.body)}`);
  const runId = started.body.runId;
  say(`run ${run}: started ${args.scenario} (runId ${runId}, ${(info.durationMs / 1000).toFixed(0)} s)`);

  // 2. Wait for scenario.ended, watching the gateway's breaker view on the side.
  const observations: BreakerObservation[] = [];
  const observe = async (providerId: string | null) => {
    if (!providerId) return;
    const view = await tryJson<ControlView>(`${urls.gateway}/api/control/state`);
    const b = view?.breakers.find((x) => x.providerId === providerId);
    if (!b) return;
    const last = observations.at(-1);
    if (!last || last.state !== b.state || last.since !== b.since) observations.push({ at: new Date().toISOString(), state: b.state, since: b.since, reason: b.reason });
  };
  const scenarioDeadline = Date.now() + info.durationMs + 60_000;
  let lastStep = '';
  for (;;) {
    if (crashed()) throw crashed()!;
    await rl.pull(urls.brokerHttp);
    const tl = runTimeline(rl.scen, runId);
    await observe(tl.providerId);
    const step = rl.scen.runControls(runId).filter((c) => c.event.type === 'control.scenario.step').at(-1);
    const stepId = step ? (step.event.payload as { stepId: string }).stepId : '';
    if (stepId && stepId !== lastStep) {
      lastStep = stepId;
      if (args.verbose) say(`run ${run}:   step ${stepId}`);
    }
    if (tl.scenarioEndedOffset !== null) break;
    if (Date.now() > scenarioDeadline) throw new Error(`run ${run}: no control.scenario.ended within ${info.durationMs + 60_000} ms`);
    await sleep(500);
  }
  const scenarioS = (Date.now() - r0) / 1000;

  // 3. Give the provider time to carry normal traffic again (check d), with ambient traffic still on.
  const w0 = Date.now();
  for (;;) {
    const tl = runTimeline(rl.scen, runId);
    if (recoveryComplete(rl.scen, tl) || Date.now() - w0 > args.recoveryTimeoutMs) break;
    await sleep(500);
    await rl.pull(urls.brokerHttp);
    await observe(tl.providerId);
  }
  const recoveryWaitS = (Date.now() - w0) / 1000;

  // 4. Stop ambient traffic, let in-flight payments finish.
  const ambientBefore = (await tryJson<OrchestratorState>(`${urls.orchestrator}/state`))?.ambient.rate ?? null;
  const amb = await postJson(`${urls.orchestrator}/ambient`, { rate: 0 });
  if (amb.status !== 200) say(`run ${run}: ! could not stop ambient traffic (${amb.status})`);
  await sleep(300);
  const d0 = Date.now();
  let lastTerminal = -1;
  let lastProgressAt = Date.now();
  for (;;) {
    if (crashed()) throw crashed()!;
    await rl.pull(urls.brokerHttp);
    const all = [...rl.log.payments.values()];
    const terminal = all.filter((p) => isTerminal(p.state.status)).length;
    if (terminal === all.length) break;
    if (terminal !== lastTerminal) {
      lastTerminal = terminal;
      lastProgressAt = Date.now();
    }
    if (Date.now() - d0 > args.drainTimeoutMs || Date.now() - lastProgressAt > 60_000) {
      say(`run ${run}: ! ${all.length - terminal} payment(s) still in flight after ${((Date.now() - d0) / 1000).toFixed(0)} s`);
      break;
    }
    await sleep(500);
  }
  // Stragglers (a late duplicate would show up here), then the final read.
  await sleep(1000);
  await rl.pull(urls.brokerHttp);
  const drainS = (Date.now() - d0) / 1000;

  // 5. Checks.
  const sent = [...rl.log.payments.keys()];
  const trialBalance = await tryJson<TrialBalance>(`${urls.ledger}/ledger/trial-balance`);
  const invariants = await tryJson<{ ok: boolean; violations: string[] }>(`${urls.ledger}/ledger/invariants`);
  const journals: JournalCounts = { byPayment: new Map(), totalJournals: trialBalance?.journals };
  await mapLimit(sent, 16, async (id) => {
    const js = await tryJson<unknown[]>(`${urls.ledger}/ledger/journals?paymentId=${encodeURIComponent(id)}&limit=10`);
    journals.byPayment.set(id, js ? js.length : undefined);
  });
  let gatewayStats: { rejectedEvents: number; total: number } | null = null;
  for (let i = 0; i < 20; i++) {
    gatewayStats = await tryJson<{ rejectedEvents: number; total: number }>(`${urls.gateway}/api/stats`);
    if (!gatewayStats || gatewayStats.total >= rl.log.payments.size) break;
    await sleep(500);
  }

  const tl = runTimeline(rl.scen, runId);
  const states = [...rl.log.payments.values()].map((p) => p.state);
  const breakerStateAt = (providerId: string, atMs: number): BreakerStateName => breakerFor(states, providerId, atMs).state;
  const m2 = evaluate({
    log: rl.log,
    sent,
    trafficErrors: 0,
    trialBalance,
    invariants,
    journals,
    gatewayRejectedEvents: gatewayStats?.rejectedEvents ?? null,
    // After a reset the ledger holds only this run's journals; in url mode without resets it may hold more.
    ownSystem: urls.control !== null,
  });
  const pick = (id: string) => m2.find((c) => c.id === id)!;
  const prefix = (letter: string, c: Check): Check => ({ ...c, id: `${letter}.${c.id.split('.').slice(1).join('.')}` });
  const checks: Check[] = [
    checkControlSequence(rl.scen, runId, info.steps.map((s) => s.id)),
    checkBreakerOpened(rl.scen, tl, args.breakerBoundMs),
    checkNoTrafficWhileOpen(rl.scen, tl, { breakerStateAt }),
    checkRecovery(rl.scen, tl),
    prefix('e', pick('d.all-terminal')),
    prefix('e', pick('c.no-duplicate-events')),
    prefix('e', pick('c.state-machine')),
    prefix('e', pick('c.retry-bound')),
    prefix('f', pick('a.trial-balance')),
    prefix('f', pick('a.invariants')),
    prefix('f', pick('b.journals')),
    prefix('g', pick('e.gateway-rejected-events')),
  ];

  // 6. Reset (and time it).
  let reset: RunReport['reset'] = null;
  if (urls.control) {
    const c0 = Date.now();
    try {
      const res = await postJson<ResetResult & { error?: string }>(`${urls.control}/reset`, {}, 60_000);
      const clientMs = Date.now() - c0;
      if (res.status !== 200 || !res.body.ok) reset = { error: `${res.status} ${res.body.error ?? JSON.stringify(res.body)}`, clientMs };
      else reset = { ...res.body, clientMs };
    } catch (err) {
      reset = { error: (err as Error).message, clientMs: Date.now() - c0 };
    }
    const health = await tryJson<{ events: number }>(`${urls.brokerHttp}/health`);
    const gw = await fetch(`${urls.gateway}/health`).then((r) => r.status, () => 0);
    const resetOk = reset && 'durationMs' in reset;
    checks.push(
      checkReset(
        {
          durationMs: resetOk ? (reset as ResetResult).durationMs : null,
          error: !resetOk ? (reset as { error: string }).error : gw !== 200 ? `gateway /health answered ${gw} after the reset` : undefined,
          logEventsAfter: health?.events ?? null,
        },
        args.maxResetMs,
      ),
    );
  } else {
    checks.push({ id: 'h.reset', title: 'Reset (skipped: no launcher control URL)', ok: true, detail: 'skipped' });
    // No reset brings the ambient rate back: restore it ourselves.
    if (ambientBefore !== null) await postJson(`${urls.orchestrator}/ambient`, { rate: ambientBefore }).catch(() => undefined);
  }

  const open = findBreakerOpen(rl.scen, tl);
  const viol = findOpenViolations(rl.scen, tl, { breakerStateAt });
  const byStatus: Record<string, number> = {};
  for (const p of rl.log.payments.values()) byStatus[p.state.status] = (byStatus[p.state.status] ?? 0) + 1;
  return {
    run,
    runId,
    ok: checks.every((c) => c.ok),
    checks,
    payments: rl.log.payments.size,
    events: rl.log.events,
    byStatus,
    durations: { scenarioS: +scenarioS.toFixed(1), recoveryWaitS: +recoveryWaitS.toFixed(1), drainS: +drainS.toFixed(1), totalS: +((Date.now() - r0) / 1000).toFixed(1) },
    breaker: {
      openAfterOutageS: open.delayMs !== null ? +(open.delayMs / 1000).toFixed(2) : null,
      openWindowS: viol.window && viol.window.toMs !== null ? +((viol.window.toMs - viol.window.fromMs) / 1000).toFixed(2) : null,
      violations: viol.violations.length,
      violationDetails: viol.violations.slice(0, 10).map((v) => {
        const b = breakerFor(states, v.providerId, v.decidedAtMs);
        return {
          paymentId: v.paymentId,
          offset: v.offset,
          why: v.why,
          decidedAt: new Date(v.decidedAtMs).toISOString(),
          routingSaw: v.tracedBreakers[v.providerId] ?? null,
          reasonCodes: v.reasonCodes,
          recomputed: { state: b.state, since: b.since, trip: b.trip, lastProbe: b.lastProbe, reason: b.reason },
        };
      }),
      recovery: findRecovery(rl.scen, tl),
      gatewayObservations: observations,
    },
    reset,
  };
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

function slowest(ready: Record<string, number>): string {
  const [name, ms] = Object.entries(ready).sort((a, b) => b[1] - a[1])[0] ?? ['-', 0];
  return `${name} ${(ms / 1000).toFixed(1)} s`;
}

function fmtS(s: number | null): string {
  return s === null ? '-' : s.toFixed(1);
}

function minMax(xs: (number | null)[]): string | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? `${Math.min(...v).toFixed(1)}-${Math.max(...v).toFixed(1)} s` : null;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => '  ' + r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n');
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
