// `npm run verify:m6` - the M6 dress rehearsal (Gate 3, software part). See m6-args.ts for the options and
// docs/adr/0019-dress-rehearsal-verification.md for the design. Phases, in order:
//   a preflight  b virtual visitors + attract loop  c chaos with self-healing  d resets under load
//   e safe-mode round trips  f offline proof (runs through all phases)  g copy check  h leads export/erase
//   i final invariants, per-check table, JSON report, no process left behind.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTerminal, DEFAULT_SUPERVISOR_POLICY, type AnyEvent, type TrialBalance } from '@ct/contracts';
import { scanCopy } from '../booth/copy-check';
import { exportLeads, leadIdsFromCsv, parseCsv } from '../booth/export-leads';
import { runPreflight } from '../booth/preflight';
import { DEFAULT_ROOT_DIR, launch, type LaunchedSystem } from '../launcher/launch';
import { isPortFree } from '../launcher/ports';
import { evaluate, LogAnalyzer, type Check } from './analyze';
import { brokerHttpUrl } from './args';
import { boothStaticCheck } from './m5';
import { analyzeRecoveries, buildReport, maxRestartsInWindow, recoverySummary, renderChecksTable, verdict, visitChecks, type OfflineFinding, type VisitSummary } from './m6-analyze';
import { parseVerifyM6Args, VERIFY_M6_USAGE, type VerifyM6Args } from './m6-args';
import { KILL_CLASSES, planKills, runChaos } from './m6-chaos';
import { check, type Rehearsal, type Urls } from './m6-ctx';
import { http, mapLimit, sleep } from './m6-http';
import { explainPid, nodeDescendants, offlineSnapshot, stillAlive } from './m6-offline';
import { recordBackup, safeRoundTrip } from './m6-safe';
import { makeVisitScripts, runVisit, runVisits, type VisitContext } from './m6-visitors';

const t0 = Date.now();
const say = (msg: string) => console.log(`[verify:m6 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const ATTRACT_IDLE_MS = 8000;

async function pullLog(brokerHttp: string, log: LogAnalyzer): Promise<void> {
  for (;;) {
    const page = await http<{ offset: number; event: AnyEvent }[]>('GET', `${brokerHttp}/events?from=${log.nextOffset}&limit=5000`, undefined, {}, 30_000);
    if (page.status !== 200 || !Array.isArray(page.body)) throw new Error(`broker /events -> ${page.status} ${page.error ?? ''}`);
    for (const { offset, event } of page.body) log.apply(offset, event);
    if (page.body.length < 5000) return;
  }
}

const withPrefix = (prefix: string, checks: Check[]): Check[] => checks.map((c) => ({ ...c, id: `${prefix}.${c.id}` }));

/** Drain: stop ambient, wait until every payment is terminal, then apply the M2 invariants to the whole log. */
async function finalInvariants(rh: Rehearsal, prefix: string, ambientAfter: number): Promise<Check[]> {
  await http('POST', `${rh.urls.orchestrator}/ambient`, { rate: 0 });
  await http('POST', `${rh.urls.orchestrator}/attract`, { enabled: false });
  const log = new LogAnalyzer();
  const d0 = Date.now();
  let open = 0;
  for (;;) {
    await pullLog(rh.urls.brokerHttp, log);
    open = [...log.payments.values()].filter((p) => !isTerminal(p.state.status)).length;
    if (open === 0 || Date.now() - d0 > 120_000) break;
    await sleep(1000);
  }
  await sleep(1500);
  await pullLog(rh.urls.brokerHttp, log);
  const sent = [...log.payments.keys()];
  const tb = (await http<TrialBalance>('GET', `${rh.urls.ledger}/ledger/trial-balance`)).body ?? null;
  const inv = (await http<{ ok: boolean; violations: string[] }>('GET', `${rh.urls.ledger}/ledger/invariants`)).body ?? null;
  const byPayment = new Map<string, number | undefined>();
  await mapLimit(sent.filter((id) => isTerminal(log.payments.get(id)!.state.status)), 32, async (id) => {
    const r = await http<unknown[]>('GET', `${rh.urls.ledger}/ledger/journals?paymentId=${encodeURIComponent(id)}&limit=10`);
    byPayment.set(id, r.status === 200 && Array.isArray(r.body) ? r.body.length : undefined);
  });
  let rejected: number | null = null;
  for (let i = 0; i < 20; i++) {
    const s = await http<{ rejectedEvents: number; total: number }>('GET', `${rh.urls.gateway}/api/stats`);
    if (s.status === 200) {
      rejected = s.body.rejectedEvents;
      if (s.body.total >= log.payments.size) break;
    }
    await sleep(1000);
  }
  const checks = evaluate({ log, sent, trafficErrors: 0, trialBalance: tb, invariants: inv, journals: { byPayment, totalJournals: tb?.journals }, gatewayRejectedEvents: rejected, ownSystem: true });
  rh.details[`${prefix}.log`] = { payments: sent.length, events: log.events, openAtEnd: open };
  if (ambientAfter > 0) await http('POST', `${rh.urls.orchestrator}/ambient`, { rate: ambientAfter });
  return withPrefix(prefix, checks);
}

async function leadsIntact(rh: Rehearsal, id: string, title: string): Promise<Check> {
  const r = await http<{ id: string }[]>('GET', `${rh.urls.gateway}/api/booth/leads`, undefined, { 'x-booth-staff': rh.args.staffPin });
  const have = new Set(Array.isArray(r.body) ? r.body.map((l) => l.id) : []);
  const lost = [...rh.leads.keys()].filter((l) => !have.has(l));
  return check(id, title, r.status === 200 && lost.length === 0, `${rh.leads.size - lost.length}/${rh.leads.size} acknowledged leads stored (list -> ${r.status})`, lost);
}

function record(rh: Rehearsal, visits: VisitSummary[]): void {
  for (const v of visits) {
    rh.visits.push(v);
    if (v.leadId) rh.leads.set(v.leadId, `m6-visit-${v.visit}@example.test`);
  }
}

async function attractCheck(rh: Rehearsal): Promise<Check[]> {
  const gw = rh.urls.gateway;
  const state = async () => (await http<{ attract?: { playing?: boolean; lastStop?: string | null } }>('GET', `${gw}/api/control/orchestrator/state`)).body?.attract;
  await http('POST', `${gw}/api/control/orchestrator/attract/touch`, {});
  await sleep(500);
  const afterTouch = await state();
  let started = false;
  const until = Date.now() + ATTRACT_IDLE_MS + 15_000;
  while (Date.now() < until && !started) {
    started = (await state())?.playing === true;
    if (!started) await sleep(500);
  }
  await http('POST', `${gw}/api/control/orchestrator/attract/touch`, {});
  await sleep(800);
  const stopped = (await state())?.playing === false;
  return [
    check('attract.loop', `Attract loop starts after ${ATTRACT_IDLE_MS / 1000} s of idle and stops on /attract/touch`, afterTouch?.playing === false && started && stopped, `after touch playing=${String(afterTouch?.playing)}; started by itself: ${started}; stopped on touch: ${stopped}`),
  ];
}

async function aliveAfter(rh: Rehearsal, id: string, title: string): Promise<Check> {
  const h = rh.system!.health();
  const down = h.filter((s) => !s.running).map((s) => s.name);
  const g = await http('GET', `${rh.urls.gateway}/health`);
  return check(id, title, down.length === 0 && g.status === 200 && rh.crashed() === null, down.length ? `not running: ${down.join(', ')}` : `${h.length} services running, gateway ${g.status}`);
}

// -------------------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  let args: VerifyM6Args;
  try {
    args = parseVerifyM6Args(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(VERIFY_M6_USAGE);
    return 0;
  }
  const checks: Check[] = [];
  const details: Record<string, unknown> = {};
  let system: LaunchedSystem | null = null;
  let tmpDir: string | null = null;
  let crashed: Error | null = null;
  let stopping = false;
  const p = args.basePort;
  const ports = Array.from({ length: 10 }, (_, i) => p + i);
  const urls: Urls = { gateway: '', brokerHttp: '', orchestrator: '', ledger: '', booth: null, control: null };
  let dataDir = '';
  let reportDir = '';
  const everSeenNodes = new Set<number>();
  const watcher = { stop: false, snapshots: 0, tool: '', findings: [] as OfflineFinding[], done: Promise.resolve() };

  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (system) {
      say('stopping the launched system...');
      await system.stop();
    }
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  const rh: Rehearsal = {
    args,
    system: null,
    urls,
    dataDir,
    checks,
    details,
    visits: [],
    leads: new Map(),
    crashed: () => crashed,
    say,
    visitContext: (tolerant): VisitContext => ({ gateway: urls.gateway, staffPin: args.staffPin, tolerateTransient: tolerant, retryBudgetMs: 45_000, terminalBudgetMs: 90_000 }),
  };

  try {
    // ---- static checks (no system needed)
    checks.push(boothStaticCheck());
    const copy = scanCopy(DEFAULT_ROOT_DIR);
    checks.push(check('copy.clean', 'Copy check: no forbidden claims, brand names, external URLs or consent drift', copy.findings.length === 0, `${copy.summary.files} files scanned, ${copy.findings.length} finding(s)`, copy.findings));

    if (args.url) {
      urls.gateway = args.url;
      urls.control = args.controlUrl ?? null;
      say(`targeting a running system at ${urls.gateway} (limited checks: visitors, booth)`);
    } else {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ct-verify-m6-'));
      dataDir = tmpDir;
      rh.dataDir = tmpDir;
      reportDir = path.resolve(args.reportDir ?? path.join(tmpDir, 'reports'));

      // a. preflight on this setup (warnings are fine, failures are not)
      const pre = await runPreflight({ dataDir: tmpDir, ports, env: { ...process.env, BOOTH_STAFF_PIN: args.staffPin } });
      const fails = pre.checks.filter((c) => c.status === 'fail');
      const warns = pre.checks.filter((c) => c.status === 'warn');
      details.preflight = { ok: pre.ok, warnings: warns.map((c) => c.id), fails: fails.map((c) => c.id) };
      checks.push(check('preflight', 'Preflight finds no failing check', pre.ok && fails.length === 0, `${pre.checks.length} checks, ${warns.length} warning(s)${warns.length ? ` (${warns.map((c) => c.id).join(', ')})` : ''}`, fails));

      say(`launching on ports ${p}-${p + 9} (data ${tmpDir}, supervisor ON, ambient ${args.ambientRate}/s, ASSISTANT_LLM=off)...`);
      system = await launch({
        host: '127.0.0.1',
        ports: { broker: p, paymentApi: p + 1, gateway: p + 2, ledger: p + 3, orchestrator: p + 4, ops: p + 5, assistant: p + 6, booth: p + 7 },
        controlPort: p + 9,
        dataDir: tmpDir,
        ambientRate: args.ambientRate,
        stageDelayMs: args.stageDelayMs,
        settlementDelayMs: args.settlementDelayMs,
        providerFailureScale: 0,
        databaseUrl: '',
        assistantLlm: 'off',
        boothStaffPin: args.staffPin,
        supervisor: { ...DEFAULT_SUPERVISOR_POLICY, enabled: true },
        quiet: !args.verbose,
        buildWeb: false,
        startupTimeoutMs: 60_000,
        env: { BUS: 'local', ASSISTANT_LLM: 'off', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ATTRACT_IDLE_MS: String(ATTRACT_IDLE_MS) },
        log: (line) => {
          if (args.verbose) console.log(line);
        },
        onUnexpectedExit: (err) => {
          crashed = err;
        },
      });
      rh.system = system;
      urls.gateway = system.urls.gateway;
      urls.brokerHttp = brokerHttpUrl(system.urls.broker);
      urls.orchestrator = system.urls.orchestrator;
      urls.ledger = system.urls.ledger;
      urls.booth = system.urls.booth ?? null;
      urls.control = system.urls.control ?? null;
      say(`system up in ${(system.startup.totalMs / 1000).toFixed(1)} s`);

      // f. offline watcher: runs through every phase
      // M6_DEBUG_NO_OFFLINE=1 (timing diagnostics only): no watcher, and the offline check then FAILS by design.
      watcher.done = (async () => {
        while (!watcher.stop && !process.env.M6_DEBUG_NO_OFFLINE) {
          try {
            const s = await offlineSnapshot();
            watcher.snapshots += 1;
            watcher.tool = s.tool;
            for (const v of s.violations) {
              if (watcher.findings.some((f) => f.detail === v.detail)) continue;
              watcher.findings.push({ ...v, detail: `${v.detail} [pid ${v.pid}: ${await explainPid(v.pid)}]` });
            }
            for (const pid of await nodeDescendants()) everSeenNodes.add(pid);
          } catch (err) {
            details.offlineError = (err as Error).message;
          }
          await sleep(2500);
        }
      })();
    }

    // b. virtual visitors (calm) + attract loop
    const all = makeVisitScripts(args.seed, args.visitors);
    const calmN = args.url ? all.length : Math.max(2, Math.round(all.length * 0.4));
    const calmScripts = all.slice(0, calmN);
    const chaosScripts = all.slice(calmN);
    say(`${args.visitors} virtual visitors (seed ${args.seed}): ${calmScripts.length} calm, ${chaosScripts.length} during chaos`);
    const calm = await runVisits(calmScripts, { ...rh.visitContext(() => false), retryBudgetMs: 10_000, terminalBudgetMs: 60_000 }, (v) => say(`  visit ${v.visit}: ${v.status ?? (v.abandoned ? 'abandoned' : '?')}${v.issues.length ? ` ISSUES ${v.issues.map((i) => i.code).join(',')}` : ''}`));
    record(rh, calm);
    checks.push(...visitChecks(calm, 'visitors'));
    if (!args.url) checks.push(...(await attractCheck(rh)));
    checks.push(await leadsIntact(rh, 'visitors.leads-stored', 'Every lead acknowledged to a visitor is stored (staff list)'));

    if (system) {
      // c. chaos with self-healing
      const plan = planKills(args.seed, args.killsPerClass);
      say(`chaos: ${plan.length} kills (${plan.join(', ')}) with ${chaosScripts.length} visitors and ambient traffic; no manual restart`);
      let chaosDone = false;
      const chaosVisitors = (async () => {
        const out: VisitSummary[] = [];
        // Keep visitors coming until the last kill is healed: loop the chaos scripts (new index range each lap).
        let lap = 0;
        while (!chaosDone || lap === 0) {
          const scripts = (lap === 0 ? chaosScripts : makeVisitScripts(args.seed + 100 * lap, Math.max(4, chaosScripts.length)).map((s, i) => ({ ...s, index: 100_000 * lap + i })));
          out.push(...(await runVisits(scripts, rh.visitContext(() => true), undefined, () => chaosDone && lap > 0)));
          lap += 1;
          if (lap > 10) break;
        }
        return out;
      })();
      const chaos = await runChaos(rh, plan);
      chaosDone = true;
      const chaosVisits = await chaosVisitors;
      record(rh, chaosVisits);
      const recoveries = analyzeRecoveries(chaos.kills, chaos.samples, args.recoverBoundMs);
      const summary = recoverySummary(recoveries);
      details.chaos = { plan, summary, recoveries, errors: chaos.errors, restartsInWindow: maxRestartsInWindow(chaos.samples, DEFAULT_SUPERVISOR_POLICY.windowMs), health: system.health() };
      const bad = recoveries.filter((r) => !r.withinBound);
      const classesHit = KILL_CLASSES.filter((c) => chaos.kills.some((k) => (c.services as readonly string[]).includes(k.service))).map((c) => c.name);
      checks.push(check('chaos.self-heal', `Every killed service is back by itself within ${args.recoverBoundMs / 1000} s (no restart() call)`, bad.length === 0 && chaos.errors.length === 0 && recoveries.length === plan.length,
        `${recoveries.length} kills; ` + Object.entries(summary).map(([k, v]) => `${k} max ${v.maxMs ?? 'NONE'} ms`).join(', ') + (chaos.errors.length ? `; errors: ${chaos.errors.join('; ')}` : ''), [...bad, ...chaos.errors]));
      checks.push(check('chaos.classes', 'Every service class was killed, the broker at least once', classesHit.length === KILL_CLASSES.length && chaos.kills.some((k) => k.service === 'broker'), `classes killed: ${classesHit.join(', ')}`));
      const win = maxRestartsInWindow(chaos.samples, DEFAULT_SUPERVISOR_POLICY.windowMs);
      const over = Object.entries(win).filter(([, n]) => n > DEFAULT_SUPERVISOR_POLICY.maxRestarts);
      checks.push(check('chaos.restart-policy', `No service exceeded its restart policy (${DEFAULT_SUPERVISOR_POLICY.maxRestarts} per ${DEFAULT_SUPERVISOR_POLICY.windowMs / 1000} s); the supervisor never gave up`, over.length === 0 && crashed === null, `max restarts in window: ${Object.entries(win).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${crashed ? `; GAVE UP: ${(crashed as Error).message.split('\n')[0]}` : ''}`, over));
      checks.push(await aliveAfter(rh, 'chaos.all-running', 'After chaos every service is running and the gateway is healthy'));
      checks.push(...visitChecks(chaosVisits, 'chaos.visitors'));
      checks.push(await leadsIntact(rh, 'chaos.leads-intact', 'Leads survived the chaos (including the booth crash)'));
      checks.push(...(await finalInvariants(rh, 'chaos', args.ambientRate)));

      // d. resets under load
      for (let i = 1; i <= args.resets; i++) {
        let loading = true;
        const readers = (async () => {
          while (loading) {
            await Promise.all([http('GET', `${urls.gateway}/api/stats`, undefined, {}, 3000), http('GET', `${urls.gateway}/api/control/state`, undefined, {}, 3000), http('GET', `${urls.gateway}/api/payments?limit=20`, undefined, {}, 3000)]);
            await sleep(150);
          }
        })();
        await sleep(1500);
        const w0 = Date.now();
        const r = await http<{ ok?: boolean; durationMs?: number; phases?: unknown; ready?: Record<string, number>; error?: string }>('POST', `${urls.control}/reset`, {}, {}, 90_000);
        const wall = Date.now() - w0;
        loading = false;
        await readers;
        checks.push(check(`reset.${i}.time`, `Demo reset #${i} under load finishes in under ${args.resetBoundMs / 1000} s`, r.status === 200 && wall <= args.resetBoundMs, `POST /reset -> ${r.status} ${r.body?.error ?? ''}; launcher ${r.body?.durationMs} ms, wall ${wall} ms`));
        checks.push(await aliveAfter(rh, `reset.${i}.healthy`, `System healthy after reset #${i}`));
        checks.push(await leadsIntact(rh, `reset.${i}.leads`, `Leads preserved by reset #${i}`));
        const script = { ...makeVisitScripts(args.seed + 2000 + i, 1)[0]!, abandon: null, lead: false, asks: 1, probes: false, mode: 'send' as const, concurrentWithNext: false, idleAfterMs: 0 };
        const v = await runVisit(script, rh.visitContext(() => false));
        checks.push(check(`reset.${i}.payment`, `A visitor payment completes after reset #${i}`, v.issues.length === 0 && v.status === 'reconciled', `${v.paymentId} ${v.status}; ${v.issues.map((x) => x.code).join(', ') || 'no issues'}`, v.issues));
        details[`reset${i}`] = { wallMs: wall, launcherMs: r.body?.durationMs, phases: r.body?.phases, ready: r.body?.ready };
      }

      // e. safe mode round trips on a recorded run
      say(`recording a ${args.recordSeconds} s provider-outage run...`);
      const rec = await recordBackup(rh);
      checks.push(...rec);
      if (rec.every((c) => c.ok)) {
        for (let n = 1; n <= args.safeRoundTrips; n++) {
          say(`safe-mode round trip ${n}/${args.safeRoundTrips}`);
          checks.push(...(await safeRoundTrip(rh, n)));
        }
      }
      checks.push(...(await finalInvariants(rh, 'final', 0)));
    }

    // h. leads: export, formula protection, wrong PIN, erase
    checks.push(...(await leadChecks(rh)));
    if (rh.system) checks.push(await aliveAfter(rh, 'final.all-running', 'At the end every service is running'));
  } catch (err) {
    say(`aborted: ${(err as Error).message.split('\n').slice(0, 6).join(' | ')}`);
    checks.push(check('aborted', 'The rehearsal ran to the end', false, (err as Error).message.split('\n')[0]!));
  } finally {
    watcher.stop = true;
    await watcher.done;
    if (system) {
      checks.push(
        check('offline.no-remote-connections', 'Offline proof: no TCP connection of the launched process tree has a non-loopback peer, no listener is bound off loopback', watcher.snapshots > 0 && watcher.findings.length === 0,
          `${watcher.snapshots} snapshots (${watcher.tool}) across all phases, ${watcher.findings.length} violation(s)${details.offlineError ? `; error: ${String(details.offlineError)}` : ''}`, watcher.findings),
      );
    }
    await cleanup();
    if (system) {
      // No process or port may be left behind.
      let left: number[] = [];
      for (let i = 0; i < 10; i++) {
        left = await stillAlive([...everSeenNodes]);
        if (!left.length) break;
        await sleep(500);
      }
      const busy: number[] = [];
      for (const port of ports) if (!(await isPortFree(port))) busy.push(port);
      checks.push(check('cleanup.nothing-left', 'No orphan node process and no busy port after the run', left.length === 0 && busy.length === 0, `${everSeenNodes.size} node processes seen; alive: ${left.join(',') || 'none'}; busy ports: ${busy.join(',') || 'none'}`));
    }
  }

  const report = buildReport({ checks, mode: args.url ? 'url' : 'launched', quick: args.quick, params: { ...args, help: undefined, staffPin: '(redacted)' }, details: { ...details, urls }, totalDurationS: +((Date.now() - t0) / 1000).toFixed(1) });
  if (!reportDir) reportDir = path.resolve(args.reportDir ?? path.join(os.tmpdir(), 'ct-verify-m6-reports'));
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `verify-m6-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('\nM6 dress rehearsal');
  console.log(renderChecksTable(checks));
  for (const c of checks.filter((x) => !x.ok && x.examples)) console.log(`  examples for ${c.id}: ${JSON.stringify(c.examples).slice(0, 900)}`);
  console.log(`\n${verdict(report)}\n\nreport: ${reportPath}  (${report.totalDurationS} s)`);
  if (tmpDir && !args.keep) {
    for (const entry of readdirSync(tmpDir)) {
      if (path.join(tmpDir, entry) !== reportDir) rmSync(path.join(tmpDir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
  return report.ok ? 0 : 1;
}

const FORMULA_START = /^[=+\-@\t\r]/;

async function leadChecks(rh: Rehearsal): Promise<Check[]> {
  const out: Check[] = [];
  const gw = rh.urls.gateway;
  const dir = rh.dataDir || os.tmpdir();
  const quiet = { log: () => undefined };
  // wrong PIN
  const bad = await exportLeads({ url: gw, pin: `${rh.args.staffPin}x9`, out: path.join(dir, 'leads-badpin.csv'), force: true, ...quiet });
  const direct = await http('GET', `${gw}/api/booth/leads/export.csv`, undefined, { 'x-booth-staff': 'nope' });
  out.push(check('leads.wrong-pin', 'A wrong staff PIN is rejected and nothing is written', !bad.ok && bad.file === null && !existsSync(path.join(dir, 'leads-badpin.csv')) && (direct.status === 401 || direct.status === 403), `export refused: ${!bad.ok}; direct -> ${direct.status}`));

  // formula-injection leads
  const formulas = ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(1)'];
  for (const [i, f] of formulas.entries()) {
    const r = await http<{ id?: string }>('POST', `${gw}/api/booth/leads`, { name: f, company: f, role: f, email: `m6-formula-${i}@example.test`, interest: 'other', consent: true, consentText: 'I agree to be contacted about this demo. (verify:m6 synthetic visitor)' });
    if (r.body?.id) rh.leads.set(r.body.id, `m6-formula-${i}@example.test`);
  }
  const file = path.join(dir, 'leads-export.csv');
  const ok = await exportLeads({ url: gw, pin: rh.args.staffPin, out: file, force: true, ...quiet });
  let csv = '';
  try {
    csv = readFileSync(file, 'utf8');
  } catch {
    /* reported below */
  }
  const ids = new Set(csv ? leadIdsFromCsv(csv) : []);
  const missing = [...rh.leads.keys()].filter((id) => !ids.has(id));
  out.push(check('leads.export', 'With the right PIN the export saves a CSV with every acknowledged lead', ok.ok && ok.count >= rh.leads.size && missing.length === 0, `exported ${ok.count} lead(s), ${rh.leads.size} acknowledged, ${missing.length} missing`, missing));
  const rows = csv ? parseCsv(csv).slice(1) : [];
  const raw = rows.flatMap((r) => r.filter((c) => FORMULA_START.test(c)));
  out.push(check('leads.formula-protection', 'The CSV neutralises spreadsheet formulas (no cell starts with = + - @)', rows.length > 0 && raw.length === 0, `${rows.length} rows, ${raw.length} unprotected cell(s)`, raw));

  // erase: refused without the typed confirmation, works with it
  const refused = await exportLeads({ url: gw, pin: rh.args.staffPin, out: path.join(dir, 'leads-no-erase.csv'), force: true, erase: true, confirm: async () => 'no', ...quiet });
  const stillThere = (await http<unknown[]>('GET', `${gw}/api/booth/leads`, undefined, { 'x-booth-staff': rh.args.staffPin })).body;
  out.push(check('leads.erase-needs-confirmation', 'Erase does nothing without the typed confirmation', refused.erased === 0 && Array.isArray(stillThere) && stillThere.length >= rh.leads.size, `erased ${refused.erased}; ${Array.isArray(stillThere) ? stillThere.length : '?'} leads remain`));
  const erased = await exportLeads({ url: gw, pin: rh.args.staffPin, out: path.join(dir, 'leads-erase.csv'), force: true, erase: true, confirm: async () => 'DELETE', ...quiet });
  const after = (await http<unknown[]>('GET', `${gw}/api/booth/leads`, undefined, { 'x-booth-staff': rh.args.staffPin })).body;
  out.push(check('leads.erase', 'With the confirmation the exported leads are erased from the booth', erased.ok && erased.erased === erased.count && erased.count > 0 && Array.isArray(after) && after.length === 0, `erased ${erased.erased}/${erased.count}; ${Array.isArray(after) ? after.length : '?'} remain`));
  return out;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
