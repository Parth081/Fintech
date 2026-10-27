// `npm run verify:m4` - end-to-end verification of M4 (operations console + risk & compliance).
//
// Launches the whole system on non-default ports in a temp dir (or targets --url), then drives the real
// workflows through the gateway exactly like the console does: demo sign-in as different users, the
// sanctions-hit / fraud-ring / fx-spike scenarios, case decisions with four-eyes, operator retry, refund
// maker-checker, a maker-checker config change, and finally reads the audit trail, the log and the ledger.
// Checks (a)-(j) are listed in m4-args.ts; the pure parts live in m4-analyze.ts and analyze.ts (verify:m2).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORRIDORS,
  deterministicId,
  isTerminal,
  makeControlEvent,
  serviceConfig,
  type BusEvent,
  type CaseView,
  type ChangeRequest,
  type ControlEvent,
  type ControlView,
  type JournalView,
  type OrchestratorState,
  type PaymentStatus,
  type Session,
  type TrialBalance,
} from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { launch, type LaunchedSystem } from '../launcher/launch';
import { generatePayment } from '../traffic/generator';
import { craftedKey } from '../../services/orchestrator/src/scenarios';
import { FRAUD_RING, FX_SPIKE, SANCTIONS_HIT } from '../../services/orchestrator/src/scenarios-m4';
import { evaluate, LogAnalyzer, type Check, type JournalCounts } from './analyze';
import { brokerHttpUrl } from './args';
import {
  check,
  checkAuditCoverage,
  checkAuditEventLinks,
  checkAuditUnchanged,
  checkFxSpreads,
  checkNoRoutingTo,
  checkOperatorEventsHaveActors,
  countBy,
  isMirrorReversal,
  journalBalanced,
  M4Log,
  type AuditRow,
  type MutatingCall,
} from './m4-analyze';
import { parseVerifyM4Args, VERIFY_M4_USAGE, type VerifyM4Args } from './m4-args';

const t0 = Date.now();
const say = (msg: string) => console.log(`[verify:m4 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ HTTP

interface HttpResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function http<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<HttpResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

async function getJson<T>(url: string): Promise<T> {
  const r = await http<T>('GET', url);
  if (r.status !== 200) throw new Error(`GET ${url} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

async function tryJson<T>(url: string): Promise<T | null> {
  try {
    return await getJson<T>(url);
  } catch {
    return null;
  }
}

/** A demo user signed in to the ops API through the gateway. Mutating calls are recorded for check (i). */
class OpsUser {
  token = '';
  constructor(
    readonly gw: string,
    readonly userId: string,
    private readonly calls: MutatingCall[],
  ) {}

  async login(): Promise<Session> {
    const at = new Date().toISOString();
    const r = await http<Session & { error?: string }>('POST', `${this.gw}/api/ops/auth/login`, { userId: this.userId });
    this.calls.push({ userId: this.userId, method: 'POST', path: '/auth/login', status: r.status, targets: [this.userId], at });
    if (r.status !== 200 || !r.body.token) throw new Error(`sign-in as ${this.userId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    return r.body;
  }

  get<T>(p: string): Promise<HttpResult<T>> {
    return http<T>('GET', `${this.gw}/api/ops${p}`, undefined, { authorization: `Bearer ${this.token}` });
  }

  async send<T>(method: string, p: string, body: unknown, targets: string[]): Promise<HttpResult<T>> {
    const at = new Date().toISOString();
    const r = await http<T>(method, `${this.gw}/api/ops${p}`, body, { authorization: `Bearer ${this.token}` });
    this.calls.push({ userId: this.userId, method, path: p, status: r.status, targets, at });
    return r;
  }

  post<T>(p: string, body: unknown, targets: string[]): Promise<HttpResult<T>> {
    return this.send<T>('POST', p, body, targets);
  }

  async list<T>(p: string): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const r = await this.get<T[]>(`${p}${p.includes('?') ? '&' : '?'}limit=500&offset=${offset}`);
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`GET /api/ops${p} as ${this.userId} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      out.push(...r.body);
      const total = Number(r.headers.get('x-total-count') ?? NaN);
      if (r.body.length < 500 || (Number.isFinite(total) && out.length >= total)) return out;
    }
  }
}

type CaseOut = CaseView & { payment?: { status?: PaymentStatus }; actionable?: boolean };

// ------------------------------------------------------------------------------------------------ context

interface Ctx {
  args: VerifyM4Args;
  gw: string;
  brokerUrl: string;
  brokerHttp: string;
  log: LogAnalyzer;
  m4: M4Log;
  calls: MutatingCall[];
  users: Record<string, OpsUser>;
  checks: Check[];
  notes: Record<string, unknown>;
  crashed: () => Error | null;
  stamp: string;
}

async function pull(ctx: Ctx): Promise<void> {
  for (;;) {
    const page = await getJson<{ offset: number; event: BusEvent }[]>(`${ctx.brokerHttp}/events?from=${ctx.log.nextOffset}&limit=5000`);
    for (const { offset, event } of page) {
      ctx.log.apply(offset, event);
      ctx.m4.apply(offset, event);
    }
    if (page.length < 5000) return;
  }
}

async function waitFor<T>(ctx: Ctx, what: string, fn: () => T | undefined | null | false, timeoutMs = ctx.args.stepTimeoutMs): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = ctx.crashed();
    if (c) throw c;
    await pull(ctx);
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(400);
  }
}

const statusOf = (ctx: Ctx, id: string): PaymentStatus | undefined => ctx.log.payments.get(id)?.state.status;

/** Wait until the ops projection has processed the log up to `offset`. */
async function opsCaughtUp(ctx: Ctx, offset = ctx.log.nextOffset - 1): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const h = await tryJson<{ offset?: number }>(`${ctx.gw}/api/ops/health`);
    if (h && typeof h.offset === 'number' && h.offset >= offset) return;
    if (Date.now() > deadline) throw new Error(`ops projection did not reach offset ${offset} (at ${h?.offset ?? 'unknown'})`);
    await sleep(250);
  }
}

async function sendPayment(ctx: Ctx, key: string, body: unknown): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const r = await http<{ paymentId?: string; error?: string }>('POST', `${ctx.gw}/api/payments`, body, { 'idempotency-key': key });
    if (r.status >= 200 && r.status < 300 && r.body?.paymentId) return r.body.paymentId;
    if (r.status === 409 && r.body?.paymentId) return r.body.paymentId;
    if (attempt >= 5 || (r.status < 500 && r.status !== 429)) throw new Error(`POST /api/payments (${key}) -> ${r.status} ${JSON.stringify(r.body)}`);
    await sleep(300 * attempt);
  }
}

/** Ordinary payments shaped like ambient traffic (same generator as `npm run traffic`), on given corridors. */
function ordinary(ctx: Ctx, label: string, n: number, corridorIds: readonly string[]) {
  const corridors = CORRIDORS.filter((c) => corridorIds.includes(c.id));
  return Array.from({ length: n }, (_, i) => {
    const g = generatePayment(4242, i, { corridors });
    // Moderate amounts so nothing here trips manual review by size.
    const amount = { ...g.body.amount, amountMinor: Math.min(g.body.amount.amountMinor, 150_000) };
    return { key: `verify-m4-${ctx.stamp}-${label}-${i}`, body: { ...g.body, amount } };
  });
}

async function orch<T>(ctx: Ctx, method: string, p: string, body?: unknown): Promise<HttpResult<T>> {
  return http<T>(method, `${ctx.gw}/api/control/orchestrator${p}`, body);
}

async function startScenario(ctx: Ctx, id: string): Promise<string> {
  const st = await orch<OrchestratorState>(ctx, 'GET', '/state');
  if (st.status !== 200) throw new Error(`orchestrator state via gateway -> ${st.status}`);
  if (!st.body.scenarios.some((s) => s.id === id)) throw new Error(`orchestrator has no scenario "${id}" (has: ${st.body.scenarios.map((s) => s.id).join(', ')})`);
  if (st.body.activeRun) {
    say(`  stopping active run ${st.body.activeRun.runId} first`);
    await orch(ctx, 'POST', '/scenarios/stop', {});
  }
  const r = await orch<{ runId?: string }>(ctx, 'POST', `/scenarios/${id}/start`, {});
  if (r.status !== 200 || !r.body.runId) throw new Error(`could not start ${id}: ${r.status} ${JSON.stringify(r.body)}`);
  say(`started scenario ${id} (run ${r.body.runId})`);
  return r.body.runId;
}

const runEnded = (ctx: Ctx, runId: string) =>
  ctx.log.controls.some((c) => c.event.type === 'control.scenario.ended' && (c.event.payload as { runId?: string }).runId === runId);

// ------------------------------------------------------------------------------------------------ steps

/** (a) sanctions-hit: both crafted payments held, each with a sanctions alert and a case. */
async function stepSanctions(ctx: Ctx): Promise<{ held: string[] }> {
  const runId = await startScenario(ctx, SANCTIONS_HIT.id);
  const prefix = `scenario-${runId}-`;
  const want = SANCTIONS_HIT.steps.flatMap((s) => s.actions ?? []).reduce((n, a) => n + (a.kind === 'payments.send' ? a.payments.length : 0), 0);
  const ids = await waitFor(ctx, `${want} sanctions-hit payments to be terminal`, () => {
    const ps = ctx.m4.paymentsWithKeyPrefix(prefix);
    return ps.length >= want && ps.every((id) => isTerminal(statusOf(ctx, id) ?? 'initiated')) ? ps : undefined;
  });
  await orch(ctx, 'POST', '/scenarios/stop', {});
  await opsCaughtUp(ctx);
  const daniel = ctx.users['u-daniel']!;
  const rows = [];
  for (const id of ids) {
    const alerts = ctx.m4.alerts.get(id) ?? [];
    const cases = await waitCases(ctx, daniel, id);
    rows.push({ paymentId: id, status: statusOf(ctx, id), sanctionsAlerts: alerts.filter((a) => a.kind === 'sanctions').map((a) => `${a.rule}/${a.severity}`), cases: cases.map((c) => `${c.caseId}/${c.priority}/${c.status}`) });
  }
  ctx.notes.sanctions = { runId, payments: rows };
  ctx.checks.push(
    check('a.sanctions-held', 'sanctions-hit: every crafted payment is held', rows.length === want && rows.every((r) => r.status === 'held'), `${rows.filter((r) => r.status === 'held').length}/${want} held`, rows.filter((r) => r.status !== 'held')),
    check('a.sanctions-alerts', 'sanctions-hit: every crafted payment has a sanctions alert (risk.alert_raised kind sanctions)', rows.length === want && rows.every((r) => r.sanctionsAlerts.length > 0), rows.map((r) => `${r.paymentId}: ${r.sanctionsAlerts.join(', ') || 'none'}`).join('; '), rows.filter((r) => r.sanctionsAlerts.length === 0)),
    check('a.sanctions-cases', 'sanctions-hit: every crafted payment has a case in the ops console', rows.length === want && rows.every((r) => r.cases.length > 0), rows.map((r) => `${r.paymentId}: ${r.cases.join(', ') || 'no case'}`).join('; '), rows.filter((r) => r.cases.length === 0)),
  );
  return { held: rows.filter((r) => r.status === 'held').map((r) => r.paymentId) };
}

async function waitCases(ctx: Ctx, user: OpsUser, paymentId: string, timeoutMs = 15_000): Promise<CaseOut[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await user.get<CaseOut[]>(`/cases?q=${encodeURIComponent(paymentId)}&limit=50`);
    const list = r.status === 200 && Array.isArray(r.body) ? r.body.filter((c) => c.paymentId === paymentId) : [];
    if (list.length > 0 || Date.now() > deadline) return list;
    await sleep(500);
  }
}

/** (b) fraud-ring: AML and fraud alerts on the crafted payments, rolled up into cases. */
async function stepFraudRing(ctx: Ctx): Promise<{ held: string[] }> {
  const runId = await startScenario(ctx, FRAUD_RING.id);
  const prefix = `scenario-${runId}-`;
  const want = FRAUD_RING.steps.flatMap((s) => s.actions ?? []).reduce((n, a) => n + (a.kind === 'payments.send' ? a.payments.length : 0), 0);
  const ids = await waitFor(ctx, `${want} fraud-ring payments to be terminal`, () => {
    const ps = ctx.m4.paymentsWithKeyPrefix(prefix);
    return ps.length >= want && ps.every((id) => isTerminal(statusOf(ctx, id) ?? 'initiated')) ? ps : undefined;
  });
  await orch(ctx, 'POST', '/scenarios/stop', {});
  await opsCaughtUp(ctx);
  const daniel = ctx.users['u-daniel']!;
  const alerts = ids.flatMap((id) => (ctx.m4.alerts.get(id) ?? []).map((a) => ({ ...a, paymentId: id })));
  const riskAlerts = alerts.filter((a) => a.kind === 'aml' || a.kind === 'fraud');
  const withoutCase: unknown[] = [];
  for (const id of new Set(riskAlerts.map((a) => a.paymentId))) {
    const r = await daniel.get<{ alertId: string; caseId: string | null; kind: string }[]>(`/alerts?paymentId=${encodeURIComponent(id)}&limit=100`);
    const views = r.status === 200 && Array.isArray(r.body) ? r.body : [];
    for (const a of riskAlerts.filter((x) => x.paymentId === id)) {
      const v = views.find((x) => x.alertId === a.alertId);
      if (!v || !v.caseId) withoutCase.push({ paymentId: id, alertId: a.alertId, kind: a.kind, rule: a.rule, inOps: Boolean(v) });
    }
  }
  const byStatus = countBy(ids, (id) => statusOf(ctx, id) ?? 'missing');
  ctx.notes.fraudRing = { runId, payments: ids.length, byStatus, alertsByRule: countBy(riskAlerts, (a) => `${a.kind}:${a.rule}:${a.severity}`) };
  const aml = riskAlerts.filter((a) => a.kind === 'aml');
  const fraud = riskAlerts.filter((a) => a.kind === 'fraud');
  ctx.checks.push(
    check('b.aml-alerts', 'fraud-ring: AML typology alerts raised (fan-in / fan-out / structuring / rapid movement)', aml.length > 0, `${aml.length} AML alert(s): ${JSON.stringify(countBy(aml, (a) => a.rule))}`),
    check('b.fraud-alerts', 'fraud-ring: fraud model alerts raised', fraud.length > 0, `${fraud.length} fraud alert(s): ${JSON.stringify(countBy(fraud, (a) => a.rule))}`),
    check('b.held', 'fraud-ring: suspicious payments are held for review', (byStatus.held ?? 0) > 0, `statuses ${JSON.stringify(byStatus)}`),
    check('b.alerts-in-cases', 'fraud-ring: every AML/fraud alert belongs to a case in the ops console', riskAlerts.length > 0 && withoutCase.length === 0, `${riskAlerts.length} alert(s), ${withoutCase.length} without a case`, withoutCase),
  );
  return { held: ids.filter((id) => statusOf(ctx, id) === 'held') };
}

/** Pick an actionable (held) case, preferring high/critical and the given payments. */
async function pickCase(ctx: Ctx, user: OpsUser, prefer: readonly string[], exclude: ReadonlySet<string>): Promise<CaseOut | undefined> {
  await opsCaughtUp(ctx);
  const cases = (await user.list<CaseOut>('/cases?status=open,in_review')).filter((c) => !exclude.has(c.caseId) && statusOf(ctx, c.paymentId) === 'held');
  const high = (c: CaseOut) => c.priority === 'high' || c.priority === 'critical';
  const score = (c: CaseOut) => (high(c) ? 2 : 0) + (prefer.includes(c.paymentId) ? 1 : 0);
  return cases.sort((a, b) => score(b) - score(a))[0];
}

/** (c) analyst proposes release; same analyst cannot approve; a manager approves -> released -> reconciled. */
async function stepRelease(ctx: Ctx, prefer: readonly string[], used: Set<string>): Promise<void> {
  const daniel = ctx.users['u-daniel']!;
  const priya = ctx.users['u-priya']!;
  const c = await pickCase(ctx, daniel, prefer, used);
  if (!c) {
    ctx.checks.push(check('c.case-available', 'A held high/critical case exists to release', false, 'no held case in open/in_review'));
    return;
  }
  used.add(c.caseId);
  const high = c.priority === 'high' || c.priority === 'critical';
  ctx.checks.push(check('c.case-available', 'A held high/critical case exists to release', high, `${c.caseId} priority ${c.priority} payment ${c.paymentId}`));
  const t = [c.caseId, c.paymentId];
  const assign = await daniel.post(`/cases/${c.caseId}/assign`, { userId: 'u-daniel' }, t);
  const note = await daniel.post(`/cases/${c.caseId}/notes`, { text: 'verify:m4 - reviewed the alerts; counterparty documents check out, false positive.' }, t);
  const decide = await daniel.post<CaseOut>(`/cases/${c.caseId}/decide`, { decision: 'release', reason: 'False positive: documented business relationship (verify:m4)' }, t);
  const selfApprove = await daniel.post(`/cases/${c.caseId}/approve`, { comment: 'self-approval attempt' }, t);
  const otherAnalyst = await ctx.users['u-amara']!.post(`/cases/${c.caseId}/approve`, { comment: 'analyst approval attempt' }, t);
  const stillPending = await daniel.get<CaseOut>(`/cases/${c.caseId}`);
  const approve = await priya.post<CaseOut>(`/cases/${c.caseId}/approve`, { comment: 'Approved after reviewing the evidence (verify:m4)' }, t);
  ctx.checks.push(
    check('c.proposal', 'Analyst decision on a high/critical case becomes a proposal (pending_approval)', assign.status === 200 && note.status === 200 && decide.status === 200 && decide.body.status === 'pending_approval', `assign ${assign.status}, note ${note.status}, decide ${decide.status} -> ${decide.body?.status}`),
    check('c.analyst-cannot-approve', 'The proposing analyst (and another analyst) cannot approve; the case stays pending', selfApprove.status === 403 && otherAnalyst.status === 403 && stillPending.body?.status === 'pending_approval', `self ${selfApprove.status}, other analyst ${otherAnalyst.status}, case ${stillPending.body?.status}`),
    check('c.manager-approves', 'A compliance manager approves -> case closed with decision release, approvedBy the manager', approve.status === 200 && approve.body.status === 'closed' && approve.body.decision?.decision === 'release' && approve.body.decision?.approvedBy?.userId === 'u-priya', `approve ${approve.status} -> ${approve.body?.status} ${JSON.stringify(approve.body?.decision ?? null)}`),
  );
  let ok = false;
  let detail = '';
  try {
    await waitFor(ctx, `payment ${c.paymentId} to be reconciled after release`, () => statusOf(ctx, c.paymentId) === 'reconciled' || (isTerminal(statusOf(ctx, c.paymentId)!) && statusOf(ctx, c.paymentId) !== 'held'));
    const rel = ctx.m4.operatorEvents(c.paymentId, 'payment.released')[0];
    const p = rel?.payload as { actor?: { userId: string }; approvedBy?: { userId: string }; caseId?: string } | undefined;
    ok = statusOf(ctx, c.paymentId) === 'reconciled' && p?.actor?.userId === 'u-daniel' && p?.approvedBy?.userId === 'u-priya';
    detail = `payment.released ${rel ? `actor ${p?.actor?.userId} approvedBy ${p?.approvedBy?.userId} case ${p?.caseId}` : 'MISSING'}; status ${statusOf(ctx, c.paymentId)}`;
  } catch (err) {
    detail = `${(err as Error).message}; status ${statusOf(ctx, c.paymentId)}`;
  }
  ctx.checks.push(check('c.released-reconciled', 'payment.released (actor analyst, approvedBy manager) and the payment completes to reconciled', ok, detail));
  ctx.notes.release = { caseId: c.caseId, paymentId: c.paymentId, priority: c.priority };
}

/** (d) reject with four-eyes: a manager proposes, cannot approve their own proposal, a second manager approves. */
async function stepReject(ctx: Ctx, prefer: readonly string[], used: Set<string>): Promise<void> {
  const priya = ctx.users['u-priya']!;
  const tomas = ctx.users['u-tomas']!;
  const c = await pickCase(ctx, priya, prefer, used);
  if (!c) {
    ctx.checks.push(check('d.case-available', 'A held case exists to reject', false, 'no held case in open/in_review'));
    return;
  }
  used.add(c.caseId);
  const t = [c.caseId, c.paymentId];
  const four = c.priority === 'high' || c.priority === 'critical';
  await priya.post(`/cases/${c.caseId}/assign`, { userId: 'u-priya' }, t);
  const decide = await priya.post<CaseOut>(`/cases/${c.caseId}/decide`, { decision: 'reject', reason: 'Confirmed match against the sanctions list entry (verify:m4)' }, t);
  let detail = `${c.caseId} (${c.priority}) decide ${decide.status} -> ${decide.body?.status}`;
  let fourEyesOk = !four;
  if (four) {
    const self = await priya.post(`/cases/${c.caseId}/approve`, { comment: 'self-approval attempt' }, t);
    const approve = await tomas.post<CaseOut>(`/cases/${c.caseId}/approve`, { comment: 'Second approver: reject confirmed (verify:m4)' }, t);
    fourEyesOk = decide.body?.status === 'pending_approval' && self.status === 403 && approve.status === 200 && approve.body.status === 'closed' && approve.body.decision?.decision === 'reject';
    detail += `; self-approve ${self.status}; second manager ${approve.status} -> ${approve.body?.status}`;
  }
  ctx.checks.push(check('d.four-eyes', 'Reject on a high/critical case needs a second manager (proposer gets 403)', four && fourEyesOk, detail));
  let ok = false;
  let rdetail = '';
  try {
    await waitFor(ctx, `payment ${c.paymentId} to be rejected`, () => statusOf(ctx, c.paymentId) === 'rejected', 30_000);
    const rej = ctx.m4.operatorEvents(c.paymentId, 'payment.rejected')[0];
    const p = rej?.payload as { atStage?: string; actor?: { userId: string }; caseId?: string } | undefined;
    const journals = await tryJson<JournalView[]>(`${ctx.gw}/api/ledger/journals?paymentId=${encodeURIComponent(c.paymentId)}`);
    const posted = ctx.log.payments.get(c.paymentId)?.ledgerPosted ?? -1;
    ok = p?.atStage === 'ops' && Boolean(p.actor?.userId) && journals !== null && journals.length === 0 && posted === 0;
    rdetail = `payment.rejected atStage ${p?.atStage} actor ${p?.actor?.userId} case ${p?.caseId}; journals ${journals?.length ?? 'n/a'}, ledger.posted ${posted}`;
  } catch (err) {
    rdetail = `${(err as Error).message}; status ${statusOf(ctx, c.paymentId)}`;
  }
  ctx.checks.push(check('d.rejected-no-journal', 'payment.rejected atStage ops with the actor; no ledger journal and no ledger.posted', ok, rdetail));
  ctx.notes.reject = { caseId: c.caseId, paymentId: c.paymentId, priority: c.priority };
}

/** (e) a payment that failed on every provider is retried by an operator once providers are back and completes. */
async function stepRetry(ctx: Ctx): Promise<void> {
  const maya = ctx.users['u-maya']!;
  // DE-BR is served by orion and vega only: take both down so the payment exhausts its providers.
  const providers = ['orion', 'vega'];
  const bus = await createBus({ ...serviceConfig(), bus: 'local', brokerUrl: ctx.brokerUrl }, 'verify-m4');
  const publish = async (type: 'control.provider_outage.started' | 'control.provider_outage.ended', providerId: string) => {
    const payload = type === 'control.provider_outage.started' ? { providerId, mode: 'down' as const, reason: 'verify:m4 - force a failed payment for the retry check' } : { providerId };
    await bus.publish(makeControlEvent(type, payload as never, { eventId: deterministicId('verify-m4', ctx.stamp, type, providerId), occurredAt: new Date().toISOString(), producer: 'presenter' }) as unknown as BusEvent);
  };
  let paymentId = '';
  try {
    for (const p of providers) await publish('control.provider_outage.started', p);
    const [one] = ordinary(ctx, 'retry', 1, ['DE-BR']);
    paymentId = await sendPayment(ctx, one!.key, one!.body);
    await waitFor(ctx, `payment ${paymentId} to fail while orion and vega are down`, () => isTerminal(statusOf(ctx, paymentId) ?? 'initiated'));
  } finally {
    for (const p of providers) await publish('control.provider_outage.ended', p).catch(() => undefined);
    await bus.close().catch(() => undefined);
  }
  const failed = statusOf(ctx, paymentId) === 'failed';
  ctx.checks.push(check('e.failed', 'A payment fails after every provider refused it', failed, `${paymentId} is ${statusOf(ctx, paymentId)}`));
  if (!failed) return;
  // Circuit breakers opened by the outage need their cool-down before they let a probe through.
  await waitBreakersNotOpen(ctx, providers, 60_000);
  const denied = await ctx.users['u-hiro']!.post(`/payments/${paymentId}/retry`, { reason: 'auditor attempt' }, [paymentId]);
  let r = await maya.post<{ eventId?: string }>(`/payments/${paymentId}/retry`, { reason: 'Providers recovered; retry requested by operations (verify:m4)' }, [paymentId]);
  const eventIds = [r.body?.eventId];
  let status: PaymentStatus | undefined;
  for (let round = 1; round <= 3; round++) {
    status = await waitFor(ctx, `retried payment ${paymentId} to finish`, () => {
      const s = statusOf(ctx, paymentId);
      return s && s !== 'retrying' && isTerminal(s) && ctx.m4.operatorEvents(paymentId, 'payment.retry_requested').length >= round ? s : undefined;
    }).catch(() => statusOf(ctx, paymentId));
    if (status !== 'failed' || round === 3) break;
    say(`  retry ${round} failed again (breaker cool-down?); retrying`);
    await waitBreakersNotOpen(ctx, providers, 60_000);
    r = await maya.post<{ eventId?: string }>(`/payments/${paymentId}/retry`, { reason: `Retry again (round ${round + 1}, verify:m4)` }, [paymentId]);
    eventIds.push(r.body?.eventId);
  }
  const ev = ctx.m4.operatorEvents(paymentId, 'payment.retry_requested');
  const actorOk = ev.length > 0 && ev.every((e) => (e.payload.actor as { userId?: string } | undefined)?.userId === 'u-maya') && eventIds.every((id) => id && ev.some((e) => e.eventId === id));
  ctx.checks.push(
    check('e.rbac', 'An auditor cannot retry a payment (403)', denied.status === 403, `auditor retry -> ${denied.status}`),
    check('e.retry-completes', 'Operator retry (payment.retry_requested, actor = operator, eventId as returned) -> the payment completes', status === 'reconciled' && actorOk, `${ev.length} retry_requested event(s), returned ${eventIds.join(', ')}; final status ${status}`),
  );
  ctx.notes.retry = { paymentId, retries: ev.length, status };
}

async function waitBreakersNotOpen(ctx: Ctx, providers: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await tryJson<ControlView>(`${ctx.gw}/api/control/state?fresh`);
    const open = v?.breakers.filter((b) => providers.includes(b.providerId) && b.state === 'open') ?? [];
    if (v && open.length === 0) return;
    if (Date.now() > deadline) return;
    await sleep(1000);
  }
}

/** (f) refund maker-checker -> payment.refunded, a balanced mirror reversal journal, invariants ok. */
async function stepRefund(ctx: Ctx): Promise<void> {
  const maya = ctx.users['u-maya']!;
  const priya = ctx.users['u-priya']!;
  const [one] = ordinary(ctx, 'refund', 1, ['US-IN']);
  const paymentId = await sendPayment(ctx, one!.key, one!.body);
  await waitFor(ctx, `payment ${paymentId} to be terminal`, () => isTerminal(statusOf(ctx, paymentId) ?? 'initiated'));
  if (statusOf(ctx, paymentId) !== 'reconciled') {
    ctx.checks.push(check('f.refund', 'Refund maker-checker', false, `payment to refund ended ${statusOf(ctx, paymentId)} instead of reconciled`));
    return;
  }
  await opsCaughtUp(ctx);
  const req = await maya.post<{ id?: string; status?: string }>(`/payments/${paymentId}/refunds`, { reason: 'Customer cancelled the order within the cooling-off period (verify:m4)' }, [paymentId]);
  const refundId = req.body?.id ?? '';
  const t = [paymentId, refundId];
  const makerApprove = await maya.post(`/refunds/${refundId}/approve`, { comment: 'maker approval attempt' }, t);
  const analystApprove = await ctx.users['u-daniel']!.post(`/refunds/${refundId}/approve`, { comment: 'analyst approval attempt' }, t);
  const approve = await priya.post<{ eventId?: string; status?: string }>(`/refunds/${refundId}/approve`, { comment: 'Approved (verify:m4)' }, t);
  ctx.checks.push(
    check('f.maker-checker', 'Refund: requested by ops (201), requester and an analyst cannot approve (403), a manager approves (202)', req.status === 201 && makerApprove.status === 403 && analystApprove.status === 403 && approve.status === 202 && Boolean(approve.body?.eventId), `request ${req.status} (${refundId}), maker ${makerApprove.status}, analyst ${analystApprove.status}, manager ${approve.status} ${approve.body?.eventId ?? ''}`),
  );
  let detail = '';
  let ok = false;
  try {
    await waitFor(ctx, `payment ${paymentId} to be refunded`, () => statusOf(ctx, paymentId) === 'refunded', 30_000);
    const reqEv = ctx.m4.operatorEvents(paymentId, 'payment.refund_requested')[0];
    const rp = reqEv?.payload as { actor?: { userId: string }; approvedBy?: { userId: string } } | undefined;
    const journals = (await tryJson<JournalView[]>(`${ctx.gw}/api/ledger/journals?paymentId=${encodeURIComponent(paymentId)}`)) ?? [];
    const refundedEv = ctx.m4.operatorEvents(paymentId, 'payment.refunded')[0];
    const reversal = journals.find((j) => j.journalId === (refundedEv?.payload.journalId as string | undefined)) ?? journals.find((j) => j.kind !== journals[0]?.kind) ?? journals[1];
    const original = journals.find((j) => j !== reversal);
    const mirror = original && reversal ? isMirrorReversal(original, reversal) : { ok: false, why: `${journals.length} journal(s)` };
    ok = reqEv?.eventId === approve.body?.eventId && rp?.actor?.userId === 'u-maya' && rp?.approvedBy?.userId === 'u-priya' && journals.length === 2 && mirror.ok && journals.every(journalBalanced);
    detail = `refund_requested actor ${rp?.actor?.userId} approvedBy ${rp?.approvedBy?.userId}; ${journals.length} journal(s) (${journals.map((j) => j.kind).join(', ')}); mirror ${mirror.ok ? 'ok' : mirror.why}`;
  } catch (err) {
    detail = `${(err as Error).message}; status ${statusOf(ctx, paymentId)}`;
  }
  const tb = await tryJson<TrialBalance>(`${ctx.gw}/api/ledger/trial-balance`);
  const inv = await tryJson<{ ok: boolean; violations: string[] }>(`${ctx.gw}/api/ledger/invariants`);
  ctx.checks.push(
    check('f.refunded', 'payment.refunded with one reversal journal that mirrors the original (balanced)', ok, detail),
    check('f.ledger-after-refund', 'Trial balance balanced and ledger invariants ok after the refund', Boolean(tb?.balanced && inv?.ok), `trial balance ${tb ? (tb.balanced ? 'balanced' : 'UNBALANCED') : 'n/a'}, invariants ${inv ? (inv.ok ? 'ok' : inv.violations.slice(0, 3).join('; ')) : 'n/a'}`),
  );
  ctx.notes.refund = { paymentId, refundId };
}

/** (g) admin disables lyra; the same admin cannot approve; a second admin approves -> no first attempts to lyra. */
async function stepDisableLyra(ctx: Ctx): Promise<void> {
  const sofia = ctx.users['u-sofia']!;
  const ken = ctx.users['u-ken']!;
  const cfg = await sofia.get<{ values: { 'provider.enabled': Record<string, boolean> } }>('/config');
  const enabled = cfg.body?.values?.['provider.enabled'] ?? { orion: true, lyra: true, vega: true };
  const change = async (value: Record<string, boolean>, reason: string) => {
    const req = await sofia.post<ChangeRequest>('/changes', { key: 'provider.enabled', proposedValue: value, reason }, []);
    const id = req.body?.id ?? '';
    // targets of the request call are only known now
    ctx.calls.at(-1)!.targets.push(id);
    const self = await sofia.post(`/changes/${id}/approve`, { comment: 'self-approval attempt' }, [id]);
    const analyst = await ctx.users['u-daniel']!.post(`/changes/${id}/approve`, { comment: 'analyst attempt' }, [id]);
    const approve = await ken.post<ChangeRequest>(`/changes/${id}/approve`, { comment: 'Second admin approval (verify:m4)' }, [id]);
    return { req, id, self, analyst, approve };
  };
  const off = await change({ ...enabled, lyra: false }, 'Lyra maintenance window: stop routing to Lyra (verify:m4)');
  await pull(ctx);
  const upd = ctx.m4.configUpdates.find((u) => u.changeRequestId === off.id);
  const lyraOff = upd && (upd.value as Record<string, boolean>).lyra === false;
  ctx.checks.push(
    check('g.maker-checker', 'Config change: requester and a non-admin cannot approve (403); a second admin approves', off.req.status === 201 && off.self.status === 403 && off.analyst.status === 403 && off.approve.status === 200 && off.approve.body.status === 'approved', `request ${off.req.status} ${off.id}, self ${off.self.status}, analyst ${off.analyst.status}, second admin ${off.approve.status} -> ${off.approve.body?.status} v${off.approve.body?.appliedVersion}`),
    check('g.config-updated', 'control.config.updated on the log (provider.enabled lyra=false, actor requester, approvedBy approver)', Boolean(lyraOff && upd?.actor?.userId === 'u-sofia' && upd?.approvedBy?.userId === 'u-ken'), upd ? `@${upd.offset} v${upd.version} ${JSON.stringify(upd.value)} by ${upd.actor?.userId} approved ${upd.approvedBy?.userId}` : 'not on the log'),
  );
  if (!upd) return;
  // Payments on corridors lyra serves.
  const batch = ordinary(ctx, 'routing', ctx.args.routingSample, ['US-IN', 'GB-PH']);
  const ids = new Set<string>();
  for (const p of batch) ids.add(await sendPayment(ctx, p.key, p.body));
  await waitFor(ctx, `${ids.size} routing-sample payments to be terminal`, () => [...ids].every((id) => isTerminal(statusOf(ctx, id) ?? 'initiated')));
  // Restore before checking so a failed check never leaves lyra off.
  const on = await change({ ...enabled, lyra: true }, 'Lyra maintenance finished: route to Lyra again (verify:m4)');
  await pull(ctx);
  const restored = ctx.m4.configUpdates.find((u) => u.changeRequestId === on.id);
  ctx.checks.push(
    checkNoRoutingTo(ctx.m4, 'lyra', upd.offset, restored?.offset ?? null, ids),
    check('g.restored', 'lyra re-enabled through a second maker-checker change', Boolean(restored && (restored.value as Record<string, boolean>).lyra === true), restored ? `@${restored.offset} v${restored.version}` : `restore failed: request ${on.req.status}, approve ${on.approve.status}`),
  );
  ctx.notes.routing = { changeRequests: [off.id, on.id], payments: ids.size, statuses: countBy([...ids], (id) => statusOf(ctx, id) ?? 'missing') };
}

/** (h) fx-spike: wider spreads during the shock. Runs while `during` (other steps) executes. */
async function stepFxSpike(ctx: Ctx, during: () => Promise<void>): Promise<void> {
  const runId = await startScenario(ctx, FX_SPIKE.id);
  try {
    await during();
  } finally {
    await waitFor(ctx, 'fx-spike to end', () => runEnded(ctx, runId), FX_SPIKE.durationMs + 60_000);
  }
  const keysOf = (stepId: string, label: string) => {
    const step = FX_SPIKE.steps.find((s) => s.id === stepId)!;
    const a = step.actions!.find((x) => x.kind === 'payments.send' && x.label === label);
    const n = a && a.kind === 'payments.send' ? a.payments.length : 0;
    return Array.from({ length: n }, (_, i) => craftedKey(runId, stepId, label, i));
  };
  const idsOf = (keys: string[]) => keys.map((k) => ctx.m4.byKey.get(k)).filter((x): x is string => Boolean(x));
  const all = [...keysOf('baseline', 'before'), ...keysOf('spreads-widen', 'during'), ...keysOf('after', 'after')];
  await waitFor(ctx, 'fx-spike payments to be quoted or terminal', () => idsOf(all).length === all.length && idsOf(all).every((id) => ctx.m4.spreadBps.has(id) || isTerminal(statusOf(ctx, id) ?? 'initiated')), 30_000).catch(() => undefined);
  const groups = { before: idsOf(keysOf('baseline', 'before')), during: idsOf(keysOf('spreads-widen', 'during')), after: idsOf(keysOf('after', 'after')) };
  ctx.checks.push(...checkFxSpreads(ctx.m4, runId, groups));
  ctx.notes.fxSpike = { runId, spreads: Object.fromEntries(Object.entries(groups).map(([k, ids]) => [k, ids.map((id) => ctx.m4.spreadBps.get(id) ?? null)])) };
}

/** (i) audit trail: coverage, actors, links to the log, append-only. */
async function readAudit(ctx: Ctx): Promise<AuditRow[]> {
  return ctx.users['u-hiro']!.list<AuditRow>('/audit');
}

async function stepAuditImmutability(ctx: Ctx, snapshot: AuditRow[]): Promise<void> {
  const hiro = ctx.users['u-hiro']!;
  const sofia = ctx.users['u-sofia']!;
  const id = snapshot[0]?.id ?? 'x';
  const probes: { who: string; method: string; path: string; status: number }[] = [];
  for (const u of [hiro, sofia]) {
    for (const [method, p] of [['DELETE', '/audit'], ['DELETE', `/audit/${id}`], ['PUT', `/audit/${id}`], ['PATCH', `/audit/${id}`], ['POST', '/audit']] as const) {
      const r = await http(method, `${ctx.gw}/api/ops${p}`, method === 'DELETE' ? undefined : { action: 'tampered' }, { authorization: `Bearer ${u.token}` });
      probes.push({ who: u.userId, method, path: p, status: r.status });
    }
  }
  const allowed = probes.filter((p) => p.status >= 200 && p.status < 300);
  const auditorWrite = await hiro.post(`/cases/__none__/notes`, { text: 'auditor write attempt' }, []);
  ctx.checks.push(
    check('i.no-audit-mutation-api', 'No API can change or delete audit rows (DELETE/PUT/PATCH/POST on /audit answer non-2xx)', allowed.length === 0, probes.map((p) => `${p.who} ${p.method} ${p.path} ${p.status}`).join(', '), allowed),
    check('i.auditor-read-only', 'The auditor role cannot perform actions (403)', auditorWrite.status === 403, `auditor POST /cases/:id/notes -> ${auditorWrite.status}`),
  );
}

// ------------------------------------------------------------------------------------------------ main

async function main(): Promise<number> {
  let args: VerifyM4Args;
  try {
    args = parseVerifyM4Args(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(VERIFY_M4_USAGE);
    return 0;
  }
  const config = serviceConfig();
  let system: LaunchedSystem | null = null;
  let tmpDir: string | null = null;
  let crashed: Error | null = null;
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (system) {
      say('stopping the launched system...');
      await system.stop();
    }
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

  let dataDir = path.resolve(config.dataDir);
  const ctx: Ctx = {
    args,
    gw: '',
    brokerUrl: '',
    brokerHttp: '',
    log: new LogAnalyzer(),
    m4: new M4Log(),
    calls: [],
    users: {},
    checks: [],
    notes: {},
    crashed: () => crashed,
    stamp: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14),
  };
  let aborted: string | null = null;
  try {
    if (args.url) {
      ctx.gw = args.url;
      ctx.brokerUrl = args.brokerUrl ?? config.brokerUrl;
      say(`targeting a running system: gateway ${ctx.gw}, broker ${ctx.brokerUrl}`);
    } else {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ct-verify-m4-'));
      dataDir = tmpDir;
      const p = args.basePort;
      say(`launching the system on ports ${p}-${p + 5} (data ${tmpDir}, delays ${args.stageDelayMs}/${args.settlementDelayMs} ms)...`);
      system = await launch({
        host: '127.0.0.1',
        ports: { broker: p, paymentApi: p + 1, gateway: p + 2, ledger: p + 3, orchestrator: p + 4, ops: p + 5 },
        dataDir: tmpDir,
        ambientRate: 0,
        stageDelayMs: args.stageDelayMs,
        settlementDelayMs: args.settlementDelayMs,
        databaseUrl: '',
        quiet: !args.verbose,
        buildWeb: false,
        startupTimeoutMs: 90_000,
        env: { BUS: 'local' },
        log: (line) => {
          if (args.verbose) console.log(line);
        },
        onUnexpectedExit: (err) => {
          crashed = err;
        },
      });
      ctx.gw = system.urls.gateway;
      ctx.brokerUrl = system.urls.broker;
      say(`system up in ${(system.startup.totalMs / 1000).toFixed(1)} s`);
    }
    ctx.brokerHttp = brokerHttpUrl(ctx.brokerUrl);
    await pull(ctx);
    const health = await tryJson<{ ok?: boolean }>(`${ctx.gw}/api/ops/health`);
    if (!health?.ok) throw new Error(`ops service not reachable through the gateway (${ctx.gw}/api/ops/health)`);

    // Demo users (different roles) sign in.
    const roster = await getJson<{ id: string; role: string }[]>(`${ctx.gw}/api/ops/auth/users`);
    for (const id of ['u-maya', 'u-daniel', 'u-amara', 'u-priya', 'u-tomas', 'u-sofia', 'u-ken', 'u-hiro']) {
      if (!roster.some((u) => u.id === id)) throw new Error(`demo user ${id} missing from /auth/users`);
      const u = new OpsUser(ctx.gw, id, ctx.calls);
      await u.login();
      ctx.users[id] = u;
    }
    say(`signed in ${Object.keys(ctx.users).length} demo users`);

    const used = new Set<string>();
    const phase = async (name: string, fn: () => Promise<void>) => {
      say(`${name}...`);
      try {
        await fn();
      } catch (err) {
        say(`  ! ${name} aborted: ${(err as Error).message}`);
        ctx.checks.push(check(`${name.slice(0, 1)}.completed`, `${name} ran to the end`, false, (err as Error).message.split('\n')[0]!));
      }
    };
    let sanctionsHeld: string[] = [];
    let fraudHeld: string[] = [];
    await phase('a sanctions-hit', async () => {
      sanctionsHeld = (await stepSanctions(ctx)).held;
    });
    await phase('b fraud-ring', async () => {
      fraudHeld = (await stepFraudRing(ctx)).held;
    });
    // Case work happens while the currency spike plays out (they do not interfere).
    await phase('h fx-spike', () =>
      stepFxSpike(ctx, async () => {
        await phase('c release with four-eyes', () => stepRelease(ctx, fraudHeld, used));
        await phase('d reject with four-eyes', () => stepReject(ctx, sanctionsHeld, used));
      }),
    );
    await phase('e operator retry', () => stepRetry(ctx));
    await phase('f refund maker-checker', () => stepRefund(ctx));
    await phase('g disable lyra (maker-checker config)', () => stepDisableLyra(ctx));

    // (i) audit
    await phase('i audit trail', async () => {
      const snapshot = await readAudit(ctx);
      await stepAuditImmutability(ctx, snapshot);
      await pull(ctx);
      const end = await readAudit(ctx);
      ctx.checks.push(checkAuditCoverage(ctx.calls, end), checkAuditUnchanged(snapshot, end), checkAuditEventLinks(end, ctx.m4), checkOperatorEventsHaveActors(ctx.m4));
      ctx.notes.audit = { rows: end.length, byAction: countBy(end, (r) => r.action) };
    });

    // (j) log + ledger + gateway
    await phase('j log and ledger integrity', async () => {
      await waitFor(ctx, 'every payment to be terminal', () => [...ctx.log.payments.values()].every((p) => isTerminal(p.state.status)), 120_000).catch((e: Error) => say(`  ! ${e.message}`));
      await sleep(1000);
      await pull(ctx);
      const sent = [...ctx.log.payments.keys()];
      const trialBalance = await tryJson<TrialBalance>(`${ctx.gw}/api/ledger/trial-balance`);
      const invariants = await tryJson<{ ok: boolean; violations: string[] }>(`${ctx.gw}/api/ledger/invariants`);
      const journals: JournalCounts = { byPayment: new Map(), totalJournals: trialBalance?.journals };
      await mapLimit(sent, 16, async (id) => {
        const js = await tryJson<unknown[]>(`${ctx.gw}/api/ledger/journals?paymentId=${encodeURIComponent(id)}&limit=10`);
        journals.byPayment.set(id, js ? js.length : undefined);
      });
      let stats: { rejectedEvents: number; total: number } | null = null;
      for (let i = 0; i < 20; i++) {
        stats = await tryJson<{ rejectedEvents: number; total: number }>(`${ctx.gw}/api/stats`);
        if (!stats || stats.total >= ctx.log.payments.size) break;
        await sleep(500);
      }
      const m2 = evaluate({ log: ctx.log, sent, trafficErrors: 0, trialBalance, invariants, journals, gatewayRejectedEvents: stats?.rejectedEvents ?? null, ownSystem: !args.url });
      for (const id of ['c.no-duplicate-events', 'c.state-machine', 'c.retry-bound', 'a.trial-balance', 'a.invariants', 'b.journals', 'd.all-terminal', 'e.gateway-rejected-events']) {
        const c = m2.find((x) => x.id === id)!;
        ctx.checks.push({ ...c, id: `j.${id.split('.')[1]}` });
      }
    });
  } catch (err) {
    aborted = (err as Error).message;
    say(`aborted: ${aborted.split('\n')[0]}`);
    ctx.checks.push(check('aborted', 'verify:m4 ran to the end', false, aborted.split('\n').slice(0, 3).join(' | ')));
  } finally {
    await cleanup();
  }

  // ---- report
  const ok = ctx.checks.length > 0 && ctx.checks.every((c) => c.ok);
  const byStatus = countBy([...ctx.log.payments.values()], (p) => p.state.status);
  const reportDir = path.resolve(args.reportDir ?? path.join(dataDir, 'reports'));
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `verify-m4-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ok,
        generatedAt: new Date().toISOString(),
        mode: args.url ? 'url' : 'launched',
        gateway: ctx.gw,
        params: { ...args, help: undefined },
        durationS: +((Date.now() - t0) / 1000).toFixed(1),
        payments: ctx.log.payments.size,
        events: ctx.log.events,
        byStatus,
        checks: ctx.checks,
        notes: ctx.notes,
        mutatingCalls: ctx.calls,
        aborted,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('');
  console.log('M4 verification (operations console + risk & compliance)');
  for (const c of ctx.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(32)} ${c.title}`);
    if (!c.ok) console.log(`       ${c.detail}${c.examples ? ` ${JSON.stringify(c.examples).slice(0, 400)}` : ''}`);
  }
  console.log(`  ${ctx.log.payments.size} payments, ${ctx.log.events} events, statuses ${JSON.stringify(byStatus)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`\n${ok ? 'M4 VERIFIED' : 'M4 VERIFICATION FAILED'} - ${ctx.checks.filter((c) => c.ok).length}/${ctx.checks.length} checks passed - report: ${reportPath}`);
  if (tmpDir && !args.keep) {
    for (const entry of readdirSync(tmpDir)) {
      if (path.join(tmpDir, entry) !== reportDir) rmSync(path.join(tmpDir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
  return ok ? 0 : 1;
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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
