// Operations service: the enterprise back office API (contract: @ct/contracts ops-api.ts).
// - The event log is the source of truth for what happened: an ephemeral subscription from offset 0 rebuilds
//   payments, alerts, reconciliation results and configuration in memory on every start.
// - The ops database holds workflow state (cases, notes, proposals, change/refund requests, breaks workflow,
//   sessions, developer settings) and the append-only audit trail.
// - Operator actions on payments are published as events (producer 'ops', payload.actor) with deterministic
//   event ids, so a retried request can never produce a second event.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CONTROL_EVENT_TYPES,
  DEFAULT_CONFIG,
  EVENT_TYPES,
  SCHEMA_VERSION,
  canApply,
  deterministicId,
  isControlEvent,
  makeControlEvent,
  newId,
  unitHash,
  type Actor,
  type AlertView,
  type AnyEvent,
  type BusEvent,
  type CaseDecision,
  type CaseView,
  type ChangeRequest,
  type ControlProducer,
  type DemoUser,
  type EventEnvelope,
  type EventType,
  type OpsOverview,
  type PayloadMap,
  type PaymentState,
  type Permission,
  type ReconBreak,
  type Session,
  type Severity,
} from '@ct/contracts';
import type { EventBus, Subscription } from '@ct/event-bus';
import { isConfigKey, stableJson, validateConfigValue } from './config-validation';
import { toCsv } from './csv';
import { OpsProjection, approxUsd } from './projection';
import type { AuditFilter, BreakRow, CaseRow, NewAudit, OpsStore, RefundRequest } from './store';
import { DEMO_USERS, SEVERITY_RANK, SYSTEM_ACTOR, actorOf, findUser, hasPermission, needsFourEyes, permissionsOf } from './users';

export interface OpsOptions {
  bus: EventBus;
  store: OpsStore;
  host?: string;
  /** 0 = pick a free port. */
  port?: number;
  /** Session lifetime (default 8 h). */
  sessionTtlMs?: number;
  /** Wall clock (tests inject a fixed one). */
  now?: () => Date;
  /** How long startOps waits for the projection to catch up with the log before returning (default 120 s). */
  catchUpTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface OpsHandle {
  port: number;
  projection: OpsProjection;
  /** Resolves once every event published before the call has been processed (tests, verify). */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export const OPS_RULE_VERSION = 'ops-v1';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const API_KEY_SCOPES = ['payments:read', 'payments:write', 'refunds:write', 'webhooks:manage', 'reports:read'] as const;
const RESOLUTION_CODES = ['WRITE_OFF', 'PROVIDER_ADJUSTMENT', 'LEDGER_CORRECTION', 'FALSE_POSITIVE'] as const;
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
const bad = (msg: string, extra?: Record<string, unknown>) => new HttpError(400, msg, extra);
const notFound = (what: string) => new HttpError(404, `${what} not found`);
const conflict = (msg: string, extra?: Record<string, unknown>) => new HttpError(409, msg, extra);
const fourEyes = (msg: string) => new HttpError(403, msg, { code: 'FOUR_EYES' });

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw bad('body must be a JSON object');
  }
}

function text(body: Record<string, unknown>, field: string, opts: { required?: boolean; min?: number; max?: number } = {}): string {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw bad(`"${field}" is required`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`"${field}" must be a string`);
  const s = v.trim();
  if (opts.required && s.length < (opts.min ?? 1)) throw bad(`"${field}" must be at least ${opts.min ?? 1} characters`);
  if (s.length > (opts.max ?? 2000)) throw bad(`"${field}" must be at most ${opts.max ?? 2000} characters`);
  return s;
}

function paging(url: URL): { limit: number; offset: number } {
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 500) : 50,
    offset: Number.isFinite(offset) ? Math.max(Math.floor(offset), 0) : 0,
  };
}

function csvList(v: string | null): string[] | null {
  if (!v) return null;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/** Simple async mutex: mutating requests run one at a time (workflow invariants stay simple and race-free). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

interface Ctx {
  req: IncomingMessage;
  url: URL;
  params: string[];
  body: Record<string, unknown>;
  user: DemoUser;
  actor: Actor;
  tokenHash: string;
  token: string;
  now: string;
}

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: RegExp;
  /** Required permission; null = any signed-in user. */
  perm: Permission | null;
  mutating?: boolean;
  handler: (ctx: Ctx, res: ServerResponse) => Promise<unknown>;
}

const SEGMENT = '([^/]+)';

export async function startOps(options: OpsOptions): Promise<OpsHandle> {
  const { bus, store } = options;
  const log = options.log ?? (() => {});
  const nowDate = options.now ?? (() => new Date());
  const iso = () => nowDate().toISOString();
  const ttl = options.sessionTtlMs ?? SESSION_TTL_MS;
  const projection = new OpsProjection();
  const mutex = new Mutex();
  /** Event ids this process is publishing right now: the log fold must not "repair" them concurrently. */
  const inflight = new Set<string>();
  let webhooks = await store.webhooks();

  // ------------------------------------------------------------------------------------------ log fold

  async function sideEffects(event: BusEvent, offset: number): Promise<void> {
    if (isControlEvent(event)) {
      if (event.type === 'control.config.updated' && !inflight.has(event.eventId)) {
        const cr = await store.change(event.payload.changeRequestId);
        if (cr && cr.status === 'pending') {
          // Crash between publish and the DB write: the log says it was applied, so it was.
          await store.reviewChange(cr.id, { status: 'approved', reviewedBy: event.payload.approvedBy, reviewedAt: event.occurredAt, appliedVersion: event.payload.version, eventId: event.eventId });
          await store.audit({ at: event.occurredAt, actor: SYSTEM_ACTOR, action: 'config.change.reconciled', target: { type: 'config', id: cr.id }, details: { key: cr.key, version: event.payload.version }, eventId: event.eventId, dedupeKey: `cr-repair:${event.eventId}` });
        }
      }
    } else {
      const e = event as AnyEvent;
      switch (e.type) {
        case 'risk.alert_raised': {
          const r = await store.linkAlert({ alertId: e.payload.alertId, paymentId: e.paymentId, severity: e.payload.severity, raisedAt: e.occurredAt });
          if (r.opened) {
            await store.audit({ at: e.occurredAt, actor: SYSTEM_ACTOR, action: 'case.opened', target: { type: 'case', id: r.caseId }, paymentId: e.paymentId, details: { alertId: e.payload.alertId, kind: e.payload.kind, severity: e.payload.severity, rule: e.payload.rule }, eventId: e.eventId, dedupeKey: `case.opened:${r.caseId}` });
          } else if (r.linked) {
            await store.audit({ at: e.occurredAt, actor: SYSTEM_ACTOR, action: 'case.alert_linked', target: { type: 'case', id: r.caseId }, paymentId: e.paymentId, details: { alertId: e.payload.alertId, kind: e.payload.kind, severity: e.payload.severity, rule: e.payload.rule }, eventId: e.eventId, dedupeKey: `case.alert_linked:${e.payload.alertId}` });
          }
          break;
        }
        case 'payment.held': {
          // A payment held again after its case was closed (e.g. re-screened after release): reopen the case.
          // Comparing log offsets keeps this idempotent on replay (the first hold precedes the closing).
          const c = await store.caseByPayment(e.paymentId);
          if (c && c.status === 'closed' && offset > (c.decision?.closedAtOffset ?? Number.POSITIVE_INFINITY)) {
            await store.updateCase(c.caseId, { status: c.assignee ? 'in_review' : 'open', proposal: null, decision: null, eventId: null }, e.occurredAt);
            await store.audit({ at: e.occurredAt, actor: SYSTEM_ACTOR, action: 'case.reopened', target: { type: 'case', id: c.caseId }, paymentId: e.paymentId, details: { reason: e.payload.reason, previousDecision: c.decision }, eventId: e.eventId, dedupeKey: `case.reopened:${e.eventId}` });
          }
          break;
        }
        case 'payment.reconciled': {
          if (!e.payload.matched) {
            const r = await store.ensureBreak({ paymentId: e.paymentId, eventId: e.eventId, detectedAt: e.occurredAt });
            if (r.created) {
              await store.audit({ at: e.occurredAt, actor: SYSTEM_ACTOR, action: 'recon.break_detected', target: { type: 'break', id: r.breakId }, paymentId: e.paymentId, details: { breaks: e.payload.breaks ?? [] }, eventId: e.eventId, dedupeKey: `break:${r.breakId}` });
            }
          }
          break;
        }
        case 'payment.released':
        case 'payment.rejected': {
          const caseId = e.payload.caseId;
          const actor = e.payload.actor;
          if (e.producer === 'ops' && caseId && actor && !inflight.has(e.eventId)) {
            const c = await store.case(caseId);
            if (c && c.status !== 'closed') {
              const decision: CaseDecision = e.type === 'payment.released' ? 'release' : 'reject';
              const approvedBy = e.type === 'payment.released' ? e.payload.approvedBy : undefined;
              await store.updateCase(caseId, { status: 'closed', eventId: e.eventId, decision: { decision, reason: e.payload.reason, by: actor, ...(approvedBy ? { approvedBy } : {}), at: e.occurredAt, closedAtOffset: offset } }, e.occurredAt);
              await store.audit({ at: e.occurredAt, actor: SYSTEM_ACTOR, action: 'case.reconciled', target: { type: 'case', id: caseId }, paymentId: e.paymentId, details: { decision }, eventId: e.eventId, dedupeKey: `case-repair:${e.eventId}` });
            }
          }
          break;
        }
        case 'payment.refund_requested': {
          if (e.producer === 'ops' && !inflight.has(e.eventId)) {
            const [rf] = (await store.refunds({ paymentId: e.paymentId, status: 'pending' })).filter((r) => r.eventId === e.eventId);
            if (rf) {
              await store.reviewRefund(rf.id, { status: 'approved', reviewedBy: e.payload.approvedBy, reviewedAt: e.occurredAt });
              await store.audit({ at: e.occurredAt, actor: SYSTEM_ACTOR, action: 'refund.reconciled', target: { type: 'payment', id: e.paymentId }, paymentId: e.paymentId, details: { refundId: rf.id }, eventId: e.eventId, dedupeKey: `refund-repair:${e.eventId}` });
            }
          }
          break;
        }
        default:
          break;
      }
    }
    // Simulated webhook deliveries: recorded, never sent (the demo stays offline).
    for (const w of webhooks) {
      if (!w.enabled || offset < w.fromOffset || !matchesEvent(w.events, event.type)) continue;
      const id = `whd_${deterministicId('webhook', w.id, event.eventId).replace(/-/g, '').slice(0, 20)}`;
      await store.recordDelivery({ id, endpointId: w.id, eventId: event.eventId, eventType: event.type, at: iso(), status: 'simulated', responseMs: 40 + Math.round(unitHash(id) * 160) });
    }
  }

  const subscription: Subscription = await bus.subscribe({ group: `ops-${newId()}`, from: 'earliest', ephemeral: true }, async (event, meta) => {
    projection.apply(event, meta.offset);
    if (meta.offset <= projection.processed) return;
    await sideEffects(event, meta.offset);
    projection.done(meta.offset);
  });

  async function sync(timeoutMs = 10_000): Promise<void> {
    const head = await bus.head();
    if (head > 0) await projection.waitFor(head - 1, timeoutMs);
  }

  // ------------------------------------------------------------------------------------------ publishing

  async function publishPaymentEvent<T extends EventType>(
    type: T,
    state: PaymentState,
    payload: PayloadMap[T],
    eventId: string,
    trace: { decision: string; reasonCodes: string[]; inputs: Record<string, unknown> },
  ): Promise<number> {
    const event = {
      eventId,
      type,
      schemaVersion: SCHEMA_VERSION,
      paymentId: state.paymentId,
      occurredAt: iso(),
      correlationId: state.paymentId,
      causationId: state.history.at(-1)?.eventId ?? null,
      producer: 'ops',
      payload,
      trace: { stage: 'ops', ...trace, ruleVersion: OPS_RULE_VERSION, latencyMs: 0 },
    } as EventEnvelope<T> as AnyEvent;
    // Already on the log (a retried request): idempotent.
    if (!state.history.some((h) => h.eventId === eventId) && !canApply(state, event)) {
      throw conflict(`payment ${state.paymentId} is ${state.status}; ${type} is not allowed now`, { paymentStatus: state.status });
    }
    inflight.add(eventId);
    try {
      const { offset } = await bus.publish(event);
      await projection.waitFor(offset);
      return offset;
    } finally {
      inflight.delete(eventId);
    }
  }

  // ------------------------------------------------------------------------------------------ views

  function paymentSummary(paymentId: string): AlertView['payment'] & { known: boolean } {
    const p = projection.payments.get(paymentId);
    if (!p) return { known: false, status: 'initiated', corridor: '', amount: { amountMinor: 0, currency: 'USD' }, debtorName: '', creditorName: '' };
    return { known: true, status: p.status, corridor: p.initiated.corridor, amount: p.initiated.amount, debtorName: p.initiated.debtor.name, creditorName: p.initiated.creditor.name };
  }

  function alertView(alertId: string, caseIdByAlert: Map<string, string>): AlertView | undefined {
    const a = projection.alerts.get(alertId);
    if (!a) return undefined;
    const { known: _k, ...payment } = paymentSummary(a.paymentId);
    return {
      alertId,
      paymentId: a.paymentId,
      kind: a.payload.kind,
      severity: a.payload.severity,
      rule: a.payload.rule,
      ...(a.payload.score !== undefined ? { score: a.payload.score } : {}),
      summary: a.payload.summary,
      reasons: a.payload.reasons,
      evidence: a.payload.evidence,
      raisedAt: a.raisedAt,
      caseId: caseIdByAlert.get(alertId) ?? null,
      payment,
    };
  }

  type CaseOut = CaseView & { payment: AlertView['payment']; slaBreached: boolean; actionable: boolean };
  function caseView(c: CaseRow): CaseOut {
    const { known: _k, ...payment } = paymentSummary(c.paymentId);
    const { eventId: _e, decision, ...rest } = c;
    const { closedAtOffset: _o, ...publicDecision } = decision ?? {};
    return {
      ...rest,
      decision: decision ? (publicDecision as CaseView['decision']) : null,
      payment,
      slaBreached: c.status !== 'closed' && Date.parse(c.slaDueAt) < nowDate().getTime(),
      actionable: payment.status === 'held',
    };
  }

  function breakView(b: BreakRow): ReconBreak & { eventId: string } {
    const f = projection.recon.get(b.paymentId);
    return {
      breakId: b.breakId,
      paymentId: b.paymentId,
      providerId: f?.providerId ?? 'unknown',
      detectedAt: b.detectedAt,
      breaks: f?.breaks ?? [],
      expected: f?.expected ?? { amountMinor: 0, currency: 'USD' },
      reported: f?.reported ?? null,
      status: b.status,
      assignee: b.assignee,
      ...(b.resolution ? { resolution: b.resolution } : {}),
      eventId: b.eventId,
    };
  }

  function sessionOf(user: DemoUser, token: string, expiresAt: string): Session {
    return { token, user, permissions: permissionsOf(user.role), expiresAt };
  }

  function audit(ctx: Ctx, entry: Omit<NewAudit, 'at' | 'actor'>): Promise<boolean> {
    return store.audit({ at: ctx.now, actor: ctx.actor, ...entry });
  }

  function heldPayment(paymentId: string): PaymentState {
    const p = projection.payments.get(paymentId);
    if (!p) throw conflict(`payment ${paymentId} is not on the log`);
    if (p.status !== 'held') throw conflict(`payment ${paymentId} is ${p.status}, not held: no decision can take effect`, { paymentStatus: p.status });
    return p;
  }

  async function loadCase(id: string): Promise<CaseRow> {
    const c = await store.case(id);
    if (!c) throw notFound(`case ${id}`);
    return c;
  }

  /** Apply a case decision: publish the payment event (deterministic id per case + decision) and close the case. */
  async function effectDecision(ctx: Ctx, c: CaseRow, decision: CaseDecision, reason: string, by: Actor, approvedBy?: Actor): Promise<string> {
    const state = heldPayment(c.paymentId);
    // Deterministic per (case, hold, decision): a retried request can never publish a second event, and a
    // payment held again later (case reopened) gets a fresh id.
    const holdId = [...state.history].reverse().find((h) => h.type === 'payment.held')?.eventId ?? '';
    const eventId = deterministicId('ops', c.caseId, 'decision', decision, holdId);
    const trace = { decision, reasonCodes: [decision === 'release' ? 'OPERATOR_RELEASE' : 'OPERATOR_REJECT', ...(approvedBy ? ['FOUR_EYES_APPROVED'] : [])], inputs: { caseId: c.caseId, priority: c.priority, alertIds: c.alertIds, by: by.userId, approvedBy: approvedBy?.userId ?? null } };
    const offset =
      decision === 'release'
        ? await publishPaymentEvent('payment.released', state, { actor: by, reason, caseId: c.caseId, ...(approvedBy ? { approvedBy } : {}) }, eventId, trace)
        : await publishPaymentEvent('payment.rejected', state, { reason, atStage: 'ops', actor: by, caseId: c.caseId }, eventId, trace);
    await store.updateCase(c.caseId, { status: 'closed', eventId, decision: { decision, reason, by, ...(approvedBy ? { approvedBy } : {}), at: ctx.now, closedAtOffset: offset } }, ctx.now);
    await audit(ctx, { action: decision === 'release' ? 'payment.released' : 'payment.rejected', target: { type: 'payment', id: c.paymentId }, paymentId: c.paymentId, eventId, details: { caseId: c.caseId, decision, reason, by: by.userId, ...(approvedBy ? { approvedBy: approvedBy.userId } : {}) } });
    await audit(ctx, { action: 'case.closed', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, eventId, details: { decision } });
    return eventId;
  }

  function sameDecision(c: CaseRow, decision: CaseDecision): boolean {
    return c.status === 'closed' && c.decision?.decision === decision && !c.decision.closedWithoutAction;
  }

  // ------------------------------------------------------------------------------------------ routes

  const routes: Route[] = [];
  const route = (method: Route['method'], path: string, perm: Permission | null, handler: Route['handler'], mutating = method !== 'GET') => {
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, SEGMENT)}$`), perm, handler, mutating });
  };

  route('GET', '/me', null, async (ctx) => {
    const s = await store.session(ctx.tokenHash);
    return sessionOf(ctx.user, ctx.token, s?.expiresAt ?? '');
  });

  route('POST', '/auth/logout', null, async (ctx) => {
    await store.revokeSession(ctx.tokenHash, ctx.now);
    await audit(ctx, { action: 'auth.logout', target: { type: 'user', id: ctx.user.id }, details: {} });
    return { ok: true };
  });

  // -------- overview
  route('GET', '/overview', 'payments.read', async (ctx): Promise<OpsOverview> => {
    const today = ctx.now.slice(0, 10);
    let todayCount = 0, volume = 0, ok = 0, nok = 0, inFlight = 0, held = 0, failed = 0;
    for (const p of projection.payments.values()) {
      if (p.createdAt.slice(0, 10) === today) {
        todayCount += 1;
        volume += approxUsd(p.initiated.amount);
      }
      if (p.status === 'reconciled' || p.status === 'refund_requested' || p.status === 'refunded') ok += 1;
      else if (p.status === 'failed' || p.status === 'rejected') nok += 1;
      else if (p.status === 'held') held += 1;
      else inFlight += 1;
      if (p.status === 'failed') failed += 1;
    }
    const cases = await store.cases();
    const closedCase = new Set(cases.filter((c) => c.status === 'closed').map((c) => c.caseId));
    const caseIdByAlert = await store.caseIdsByAlert();
    const bySeverity: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    let openAlerts = 0;
    for (const a of projection.alerts.values()) {
      const cid = caseIdByAlert.get(a.payload.alertId);
      if (cid && closedCase.has(cid)) continue;
      openAlerts += 1;
      bySeverity[a.payload.severity] += 1;
    }
    const nowMs = nowDate().getTime();
    const open = cases.filter((c) => c.status !== 'closed');
    let reconTotal = 0, matched = 0;
    for (const r of projection.recon.values()) {
      reconTotal += 1;
      if (r.matched) matched += 1;
    }
    const breaks = await store.breaks();
    return {
      asOf: ctx.now,
      payments: { today: todayCount, volumeUsdToday: Math.round(volume * 100) / 100, successRate: ok + nok === 0 ? 1 : ok / (ok + nok), inFlight, held, failed },
      alerts: { open: openAlerts, bySeverity },
      cases: {
        open: open.length,
        pendingApproval: open.filter((c) => c.status === 'pending_approval').length,
        breachingSla: open.filter((c) => Date.parse(c.slaDueAt) < nowMs).length,
        myAssigned: open.filter((c) => c.assignee?.userId === ctx.user.id).length,
      },
      recon: { openBreaks: breaks.filter((b) => b.status !== 'resolved').length, matchRate: reconTotal === 0 ? 1 : matched / reconTotal },
      changes: { pending: (await store.changes('pending')).length },
    };
  });

  // -------- alerts
  route('GET', '/alerts', 'alerts.read', async (ctx, res) => {
    const u = ctx.url.searchParams;
    const status = u.get('status');
    const kinds = csvList(u.get('kind'));
    const severities = csvList(u.get('severity'));
    const paymentId = u.get('paymentId');
    const q = (u.get('q') ?? '').trim().toLowerCase();
    const caseIdByAlert = await store.caseIdsByAlert();
    const closed = new Set((await store.cases()).filter((c) => c.status === 'closed').map((c) => c.caseId));
    let list = [...projection.alerts.keys()].map((id) => alertView(id, caseIdByAlert)).filter((a): a is AlertView => a !== undefined);
    if (status === 'open') list = list.filter((a) => !a.caseId || !closed.has(a.caseId));
    if (status === 'closed') list = list.filter((a) => a.caseId !== null && closed.has(a.caseId));
    if (kinds) list = list.filter((a) => kinds.includes(a.kind));
    if (severities) list = list.filter((a) => severities.includes(a.severity));
    if (paymentId) list = list.filter((a) => a.paymentId === paymentId);
    if (q) list = list.filter((a) => [a.alertId, a.paymentId, a.caseId ?? '', a.rule, a.summary, a.payment.debtorName, a.payment.creditorName, a.payment.corridor].some((s) => s.toLowerCase().includes(q)));
    list.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const { limit, offset } = paging(ctx.url);
    res.setHeader('X-Total-Count', String(list.length));
    return list.slice(offset, offset + limit);
  });

  // -------- cases
  route('GET', '/cases', 'alerts.read', async (ctx, res) => {
    const u = ctx.url.searchParams;
    const statuses = csvList(u.get('status'));
    const priorities = csvList(u.get('priority'));
    const assignee = u.get('assignee');
    const q = (u.get('q') ?? '').trim().toLowerCase();
    let list = (await store.cases()).map(caseView);
    if (statuses) list = list.filter((c) => statuses.includes(c.status) || (statuses.includes('active') && c.status !== 'closed'));
    if (priorities) list = list.filter((c) => priorities.includes(c.priority));
    if (assignee) {
      const who = assignee === 'me' ? ctx.user.id : assignee;
      list = assignee === 'unassigned' ? list.filter((c) => c.assignee === null) : list.filter((c) => c.assignee?.userId === who);
    }
    if (q) list = list.filter((c) => [c.caseId, c.paymentId, c.payment.debtorName, c.payment.creditorName, c.payment.corridor, ...c.alertIds].some((s) => s.toLowerCase().includes(q)));
    list.sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.slaDueAt.localeCompare(b.slaDueAt) || a.caseId.localeCompare(b.caseId));
    const { limit, offset } = paging(ctx.url);
    res.setHeader('X-Total-Count', String(list.length));
    return list.slice(offset, offset + limit);
  });

  route('GET', '/cases/:id', 'alerts.read', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    const caseIdByAlert = new Map(c.alertIds.map((a) => [a, c.caseId]));
    return { ...caseView(c), alerts: c.alertIds.map((a) => alertView(a, caseIdByAlert)).filter((a): a is AlertView => a !== undefined) };
  });

  route('POST', '/cases/:id/assign', 'cases.work', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    if (!('userId' in ctx.body)) throw bad('"userId" is required (a user id, or null to unassign)');
    const userId = ctx.body.userId;
    if (c.status === 'closed') throw conflict(`case ${c.caseId} is closed`);
    let assignee: Actor | null = null;
    if (userId !== null) {
      if (typeof userId !== 'string') throw bad('"userId" must be a string or null');
      const target = findUser(userId === 'me' ? ctx.user.id : userId);
      if (!target) throw bad(`unknown user ${userId}`);
      if (!hasPermission(target, 'cases.work')) throw bad(`${target.name} (${target.role}) cannot work cases`);
      assignee = actorOf(target);
    }
    const status = c.status === 'pending_approval' ? c.status : assignee ? 'in_review' : 'open';
    await store.updateCase(c.caseId, { assignee, status }, ctx.now);
    await audit(ctx, { action: assignee ? 'case.assigned' : 'case.unassigned', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, details: { from: c.assignee?.userId ?? null, to: assignee?.userId ?? null } });
    return caseView(await loadCase(c.caseId));
  });

  route('POST', '/cases/:id/notes', 'cases.work', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    const t = text(ctx.body, 'text', { required: true, max: 4000 });
    await store.addNote(c.caseId, { at: ctx.now, actor: ctx.actor, text: t });
    if (c.status === 'open') await store.updateCase(c.caseId, { status: 'in_review' }, ctx.now);
    await audit(ctx, { action: 'case.note_added', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, details: { text: t } });
    return caseView(await loadCase(c.caseId));
  });

  route('POST', '/cases/:id/decide', 'cases.decide', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    const decision = ctx.body.decision;
    if (decision !== 'release' && decision !== 'reject') throw bad('"decision" must be "release" or "reject"');
    const reason = text(ctx.body, 'reason', { required: true, min: 3 });
    // Idempotent replays of the same request.
    if (sameDecision(c, decision)) return caseView(c);
    if (c.status === 'pending_approval' && c.proposal?.decision === decision && c.proposal.by.userId === ctx.user.id) return caseView(c);
    if (c.status === 'closed') throw conflict(`case ${c.caseId} is already closed`);
    if (c.status === 'pending_approval') throw conflict(`case ${c.caseId} has a proposal awaiting approval`);
    heldPayment(c.paymentId);
    if (needsFourEyes(c.priority)) {
      const proposal = { decision: decision as CaseDecision, reason, by: ctx.actor, at: ctx.now };
      await store.updateCase(c.caseId, { status: 'pending_approval', proposal }, ctx.now);
      await audit(ctx, { action: 'case.decision_proposed', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, details: { decision, reason, priority: c.priority } });
    } else {
      await effectDecision(ctx, c, decision, reason, ctx.actor);
    }
    return caseView(await loadCase(c.caseId));
  });

  route('POST', '/cases/:id/approve', 'cases.approve', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    const comment = text(ctx.body, 'comment');
    if (c.status === 'closed' && c.decision?.approvedBy?.userId === ctx.user.id) return caseView(c); // idempotent replay
    if (c.status !== 'pending_approval' || !c.proposal) throw conflict(`case ${c.caseId} has no proposal awaiting approval (status ${c.status})`);
    if (c.proposal.by.userId === ctx.user.id) throw fourEyes('four-eyes: you cannot approve your own proposal; another approver is required');
    if (comment) await store.addNote(c.caseId, { at: ctx.now, actor: ctx.actor, text: `Approved: ${comment}` });
    await effectDecision(ctx, c, c.proposal.decision, c.proposal.reason, c.proposal.by, ctx.actor);
    await audit(ctx, { action: 'case.approved', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, details: { decision: c.proposal.decision, proposedBy: c.proposal.by.userId, comment } });
    return caseView(await loadCase(c.caseId));
  });

  route('POST', '/cases/:id/return', 'cases.approve', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    const comment = text(ctx.body, 'comment', { required: true });
    if (c.status !== 'pending_approval' || !c.proposal) throw conflict(`case ${c.caseId} has no proposal awaiting approval (status ${c.status})`);
    await store.addNote(c.caseId, { at: ctx.now, actor: ctx.actor, text: `Returned for review: ${comment}` });
    await store.updateCase(c.caseId, { status: 'in_review', proposal: null }, ctx.now);
    await audit(ctx, { action: 'case.returned', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, details: { proposal: c.proposal, comment } });
    return caseView(await loadCase(c.caseId));
  });

  // Extra: close a case whose payment was never held (informational alert) — nothing to release or reject.
  route('POST', '/cases/:id/close', 'cases.decide', async (ctx) => {
    const c = await loadCase(ctx.params[0]!);
    const reason = text(ctx.body, 'reason', { required: true, min: 3 });
    if (c.status === 'closed') throw conflict(`case ${c.caseId} is already closed`);
    const p = projection.payments.get(c.paymentId);
    if (p?.status === 'held') throw conflict(`payment ${c.paymentId} is held: decide release or reject instead`, { paymentStatus: p.status });
    await store.updateCase(c.caseId, { status: 'closed', proposal: null, decision: { decision: 'release', reason, by: ctx.actor, at: ctx.now, closedWithoutAction: true, closedAtOffset: (await bus.head()) - 1 } }, ctx.now);
    await audit(ctx, { action: 'case.closed_no_action', target: { type: 'case', id: c.caseId }, paymentId: c.paymentId, details: { reason, paymentStatus: p?.status ?? null } });
    return caseView(await loadCase(c.caseId));
  });

  // -------- payments
  route('POST', '/payments/:id/retry', 'payments.retry', async (ctx, res) => {
    const id = ctx.params[0]!;
    const reason = text(ctx.body, 'reason', { required: true, min: 3 });
    const p = projection.payments.get(id);
    if (!p) throw notFound(`payment ${id}`);
    // Deterministic per failed state: a retried request for the same failure never duplicates the event.
    const failedAt = [...p.history].reverse().find((h) => h.type === 'payment.failed')?.eventId ?? p.history.at(-1)?.eventId ?? '';
    const eventId = deterministicId('ops', id, 'retry', failedAt);
    if (p.status !== 'failed' && !p.history.some((h) => h.eventId === eventId)) throw conflict(`payment ${id} is ${p.status}; only failed payments can be retried`, { paymentStatus: p.status });
    const already = p.history.some((h) => h.eventId === eventId);
    await publishPaymentEvent('payment.retry_requested', p, { actor: ctx.actor, reason }, eventId, { decision: 'retry', reasonCodes: ['OPERATOR_RETRY'], inputs: { previousFailure: failedAt } });
    if (!already) await audit(ctx, { action: 'payment.retry_requested', target: { type: 'payment', id }, paymentId: id, eventId, details: { reason } });
    res.statusCode = 202;
    return { eventId };
  });

  route('POST', '/payments/:id/refunds', 'payments.refund.request', async (ctx, res) => {
    const id = ctx.params[0]!;
    const reason = text(ctx.body, 'reason', { required: true, min: 3 });
    const p = projection.payments.get(id);
    if (!p) throw notFound(`payment ${id}`);
    if (p.status !== 'reconciled') throw conflict(`payment ${id} is ${p.status}; only reconciled payments can be refunded`, { paymentStatus: p.status });
    if ((await store.refunds({ paymentId: id, status: 'pending' })).length) throw conflict(`payment ${id} already has a pending refund request`);
    const rf = await store.createRefund({ paymentId: id, amount: p.initiated.amount, reason, requestedBy: ctx.actor, requestedAt: ctx.now }, (rid) => deterministicId('ops', 'refund', id, rid));
    await audit(ctx, { action: 'refund.requested', target: { type: 'payment', id }, paymentId: id, details: { refundId: rf.id, reason, amount: rf.amount } });
    res.statusCode = 201;
    return rf;
  });

  route('GET', '/refunds', 'payments.read', async (ctx) => {
    return store.refunds({ status: ctx.url.searchParams.get('status') ?? undefined, paymentId: ctx.url.searchParams.get('paymentId') ?? undefined });
  });

  async function loadRefund(id: string): Promise<RefundRequest> {
    const r = await store.refund(id);
    if (!r) throw notFound(`refund request ${id}`);
    return r;
  }

  route('POST', '/refunds/:id/approve', 'payments.refund.approve', async (ctx, res) => {
    const rf = await loadRefund(ctx.params[0]!);
    const comment = text(ctx.body, 'comment');
    if (rf.status === 'approved' && rf.reviewedBy?.userId === ctx.user.id) {
      res.statusCode = 202;
      return { ...rf, eventId: rf.eventId };
    }
    if (rf.status !== 'pending') throw conflict(`refund request ${rf.id} is ${rf.status}`);
    if (rf.requestedBy.userId === ctx.user.id) throw fourEyes('four-eyes: the requester cannot approve their own refund');
    const p = projection.payments.get(rf.paymentId);
    if (!p) throw conflict(`payment ${rf.paymentId} is not on the log`);
    await publishPaymentEvent('payment.refund_requested', p, { actor: rf.requestedBy, reason: rf.reason, approvedBy: ctx.actor }, rf.eventId, { decision: 'refund', reasonCodes: ['OPERATOR_REFUND', 'FOUR_EYES_APPROVED'], inputs: { refundId: rf.id, amount: rf.amount } });
    await store.reviewRefund(rf.id, { status: 'approved', reviewedBy: ctx.actor, reviewedAt: ctx.now, reviewComment: comment || undefined });
    await audit(ctx, { action: 'refund.approved', target: { type: 'payment', id: rf.paymentId }, paymentId: rf.paymentId, eventId: rf.eventId, details: { refundId: rf.id, requestedBy: rf.requestedBy.userId, comment } });
    res.statusCode = 202;
    return { ...(await loadRefund(rf.id)), eventId: rf.eventId };
  });

  route('POST', '/refunds/:id/reject', 'payments.refund.approve', async (ctx) => {
    const rf = await loadRefund(ctx.params[0]!);
    const comment = text(ctx.body, 'comment', { required: true });
    if (rf.status !== 'pending') throw conflict(`refund request ${rf.id} is ${rf.status}`);
    if (rf.requestedBy.userId === ctx.user.id) throw fourEyes('four-eyes: the requester cannot review their own refund (withdraw it instead)');
    await store.reviewRefund(rf.id, { status: 'rejected', reviewedBy: ctx.actor, reviewedAt: ctx.now, reviewComment: comment });
    await audit(ctx, { action: 'refund.rejected', target: { type: 'payment', id: rf.paymentId }, paymentId: rf.paymentId, details: { refundId: rf.id, comment } });
    return loadRefund(rf.id);
  });

  route('POST', '/refunds/:id/withdraw', 'payments.refund.request', async (ctx) => {
    const rf = await loadRefund(ctx.params[0]!);
    if (rf.status !== 'pending') throw conflict(`refund request ${rf.id} is ${rf.status}`);
    if (rf.requestedBy.userId !== ctx.user.id) throw new HttpError(403, 'only the requester can withdraw a refund request');
    await store.reviewRefund(rf.id, { status: 'withdrawn', reviewedAt: ctx.now });
    await audit(ctx, { action: 'refund.withdrawn', target: { type: 'payment', id: rf.paymentId }, paymentId: rf.paymentId, details: { refundId: rf.id } });
    return loadRefund(rf.id);
  });

  route('GET', '/payments/:id/activity', 'payments.read', async (ctx) => {
    return (await store.auditQuery({ paymentId: ctx.params[0]!, limit: 500 })).rows;
  });

  // -------- config (maker-checker)
  route('GET', '/config', 'config.read', async () => {
    const s = projection.control.current();
    return { values: s.config, versions: s.configVersions, defaults: DEFAULT_CONFIG };
  });

  route('GET', '/changes', 'config.read', async (ctx) => store.changes(ctx.url.searchParams.get('status') ?? undefined));

  async function loadChange(id: string): Promise<ChangeRequest> {
    const c = await store.change(id);
    if (!c) throw notFound(`change request ${id}`);
    return c;
  }

  route('POST', '/changes', 'config.request', async (ctx, res) => {
    const key = ctx.body.key;
    if (!isConfigKey(key)) throw bad(`unknown config key ${JSON.stringify(key)}`);
    if (!('proposedValue' in ctx.body)) throw bad('"proposedValue" is required');
    const reason = text(ctx.body, 'reason', { required: true, min: 3 });
    const current = projection.control.current().config;
    const v = validateConfigValue(key, ctx.body.proposedValue, current);
    if (!v.ok) throw bad(`invalid value for ${key}: ${v.errors.join('; ')}`, { errors: v.errors });
    if (stableJson(v.value) === stableJson(current[key])) throw bad(`proposed value for ${key} equals the current value`);
    if ((await store.changes('pending')).some((c) => c.key === key)) throw conflict(`a change to ${key} is already pending review`);
    const cr = await store.createChange({ key, currentValue: current[key], proposedValue: v.value, reason, requestedBy: ctx.actor, requestedAt: ctx.now });
    await audit(ctx, { action: 'config.change.requested', target: { type: 'config', id: cr.id }, details: { key, currentValue: cr.currentValue, proposedValue: cr.proposedValue, reason } });
    res.statusCode = 201;
    return cr;
  });

  route('POST', '/changes/:id/approve', 'config.approve', async (ctx) => {
    const cr = await loadChange(ctx.params[0]!);
    const comment = text(ctx.body, 'comment');
    if (cr.status === 'approved' && cr.reviewedBy?.userId === ctx.user.id) return cr; // idempotent replay
    if (cr.status !== 'pending') throw conflict(`change request ${cr.id} is ${cr.status}`);
    if (cr.requestedBy.userId === ctx.user.id) throw fourEyes('four-eyes: the requester cannot approve their own change');
    const state = projection.control.current();
    const v = validateConfigValue(cr.key, cr.proposedValue, state.config);
    if (!v.ok) throw conflict(`change ${cr.id} is no longer valid against the current configuration: ${v.errors.join('; ')}`, { errors: v.errors });
    const version = (state.configVersions[cr.key] ?? 0) + 1;
    const eventId = deterministicId('ops', 'config', cr.id);
    const event = makeControlEvent('control.config.updated', { key: cr.key, value: v.value, version, changeRequestId: cr.id, actor: cr.requestedBy, approvedBy: ctx.actor }, { eventId, occurredAt: ctx.now, producer: 'ops' as ControlProducer });
    inflight.add(eventId);
    try {
      const { offset } = await bus.publish(event);
      await projection.waitFor(offset);
    } finally {
      inflight.delete(eventId);
    }
    const applied = projection.control.current().configVersions[cr.key] ?? version;
    await store.reviewChange(cr.id, { status: 'approved', reviewedBy: ctx.actor, reviewedAt: ctx.now, reviewComment: comment || undefined, appliedVersion: applied, eventId });
    await audit(ctx, { action: 'config.change.approved', target: { type: 'config', id: cr.id }, eventId, details: { key: cr.key, version: applied, value: v.value, requestedBy: cr.requestedBy.userId, comment } });
    return loadChange(cr.id);
  });

  route('POST', '/changes/:id/reject', 'config.approve', async (ctx) => {
    const cr = await loadChange(ctx.params[0]!);
    const comment = text(ctx.body, 'comment', { required: true });
    if (cr.status !== 'pending') throw conflict(`change request ${cr.id} is ${cr.status}`);
    if (cr.requestedBy.userId === ctx.user.id) throw fourEyes('four-eyes: the requester cannot review their own change (withdraw it instead)');
    await store.reviewChange(cr.id, { status: 'rejected', reviewedBy: ctx.actor, reviewedAt: ctx.now, reviewComment: comment });
    await audit(ctx, { action: 'config.change.rejected', target: { type: 'config', id: cr.id }, details: { key: cr.key, comment } });
    return loadChange(cr.id);
  });

  route('POST', '/changes/:id/withdraw', 'config.request', async (ctx) => {
    const cr = await loadChange(ctx.params[0]!);
    if (cr.status !== 'pending') throw conflict(`change request ${cr.id} is ${cr.status}`);
    if (cr.requestedBy.userId !== ctx.user.id) throw new HttpError(403, 'only the requester can withdraw a change request');
    await store.reviewChange(cr.id, { status: 'withdrawn', reviewedAt: ctx.now });
    await audit(ctx, { action: 'config.change.withdrawn', target: { type: 'config', id: cr.id }, details: { key: cr.key } });
    return loadChange(cr.id);
  });

  // -------- reconciliation breaks
  route('GET', '/recon/breaks', 'recon.read', async (ctx) => (await store.breaks(ctx.url.searchParams.get('status') ?? undefined)).map(breakView));

  async function loadBreak(id: string): Promise<BreakRow> {
    const b = await store.break(id);
    if (!b) throw notFound(`break ${id}`);
    return b;
  }

  route('POST', '/recon/breaks/:id/assign', 'recon.resolve', async (ctx) => {
    const b = await loadBreak(ctx.params[0]!);
    if (!('userId' in ctx.body)) throw bad('"userId" is required (a user id, or null to unassign)');
    const userId = ctx.body.userId;
    if (b.status === 'resolved') throw conflict(`break ${b.breakId} is resolved`);
    let assignee: Actor | null = null;
    if (userId !== null) {
      if (typeof userId !== 'string') throw bad('"userId" must be a string or null');
      const target = findUser(userId === 'me' ? ctx.user.id : userId);
      if (!target) throw bad(`unknown user ${userId}`);
      if (!hasPermission(target, 'recon.resolve')) throw bad(`${target.name} (${target.role}) cannot resolve breaks`);
      assignee = actorOf(target);
    }
    await store.updateBreak(b.breakId, { status: assignee ? 'investigating' : 'open', assignee });
    await audit(ctx, { action: assignee ? 'recon.break_assigned' : 'recon.break_unassigned', target: { type: 'break', id: b.breakId }, paymentId: b.paymentId, details: { from: b.assignee?.userId ?? null, to: assignee?.userId ?? null } });
    return breakView(await loadBreak(b.breakId));
  });

  route('POST', '/recon/breaks/:id/resolve', 'recon.resolve', async (ctx) => {
    const b = await loadBreak(ctx.params[0]!);
    const code = ctx.body.code;
    if (typeof code !== 'string' || !(RESOLUTION_CODES as readonly string[]).includes(code)) throw bad(`"code" must be one of ${RESOLUTION_CODES.join(', ')}`);
    const note = text(ctx.body, 'note', { required: true, min: 3 });
    if (b.status === 'resolved') throw conflict(`break ${b.breakId} is already resolved`);
    const resolution = { code: code as (typeof RESOLUTION_CODES)[number], note, by: ctx.actor, at: ctx.now };
    await store.updateBreak(b.breakId, { status: 'resolved', assignee: b.assignee ?? ctx.actor, resolution });
    await audit(ctx, { action: 'recon.break_resolved', target: { type: 'break', id: b.breakId }, paymentId: b.paymentId, details: { code, note } });
    return breakView(await loadBreak(b.breakId));
  });

  // -------- audit
  function auditFilter(url: URL, withPaging: boolean): AuditFilter {
    const u = url.searchParams;
    const f: AuditFilter = {
      actor: u.get('actor') ?? undefined,
      action: u.get('action') ?? undefined,
      targetType: u.get('targetType') ?? undefined,
      targetId: u.get('targetId') ?? undefined,
      paymentId: u.get('paymentId') ?? undefined,
      from: u.get('from') ?? undefined,
      to: u.get('to') ?? undefined,
    };
    if (withPaging) Object.assign(f, paging(url));
    else f.limit = 100_000;
    return f;
  }

  route('GET', '/audit', 'audit.read', async (ctx, res) => {
    const { total, rows } = await store.auditQuery(auditFilter(ctx.url, true));
    res.setHeader('X-Total-Count', String(total));
    return rows;
  });

  route(
    'GET',
    '/audit/export.csv',
    'audit.read',
    async (ctx, res) => {
      const f = auditFilter(ctx.url, false);
      const { rows } = await store.auditQuery(f);
      await audit(ctx, { action: 'audit.exported', target: { type: 'user', id: ctx.user.id }, details: { rows: rows.length, filter: Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== undefined && k !== 'limit')) } });
      const csv = toCsv(
        ['id', 'at', 'actor_id', 'actor_name', 'actor_role', 'action', 'target_type', 'target_id', 'payment_id', 'event_id', 'details'],
        rows.map((r) => [r.id, r.at, r.actor.userId, r.actor.name, r.actor.role, r.action, r.target.type, r.target.id, r.paymentId ?? '', r.eventId ?? '', JSON.stringify(r.details)]),
      );
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-${ctx.now.slice(0, 10)}.csv"`, 'cache-control': 'no-store' });
      res.end(csv);
      return RAW;
    },
    true,
  );

  route('GET', '/users', 'users.read', async () => DEMO_USERS.map((u) => ({ ...u, permissions: permissionsOf(u.role) })));

  // -------- developer
  const keyView = ({ secretHash: _s, ...k }: Awaited<ReturnType<OpsStore['apiKeys']>>[number]) => k;
  route('GET', '/developer/keys', 'developer.manage', async () => (await store.apiKeys()).map(keyView));

  route('POST', '/developer/keys', 'developer.manage', async (ctx, res) => {
    const name = text(ctx.body, 'name', { required: true, max: 80 });
    const scopesIn = ctx.body.scopes ?? ['payments:read'];
    if (!Array.isArray(scopesIn) || scopesIn.length === 0 || !scopesIn.every((s) => typeof s === 'string' && (API_KEY_SCOPES as readonly string[]).includes(s))) {
      throw bad(`"scopes" must be a non-empty list of ${API_KEY_SCOPES.join(', ')}`);
    }
    const secret = `ctk_test_${randomBytes(24).toString('base64url')}`;
    const key = { id: `key_${randomBytes(6).toString('hex')}`, name, prefix: secret.slice(0, 13), secretHash: sha256(secret), scopes: [...new Set(scopesIn as string[])], createdAt: ctx.now, createdBy: ctx.actor, lastUsedAt: null, revokedAt: null };
    await store.createApiKey(key);
    await audit(ctx, { action: 'apikey.created', target: { type: 'apikey', id: key.id }, details: { name, prefix: key.prefix, scopes: key.scopes } });
    res.statusCode = 201;
    return { ...keyView(key), secret };
  });

  route('POST', '/developer/keys/:id/revoke', 'developer.manage', async (ctx) => {
    const id = ctx.params[0]!;
    const k = (await store.apiKeys()).find((x) => x.id === id);
    if (!k) throw notFound(`api key ${id}`);
    if (k.revokedAt) return keyView(k);
    await store.revokeApiKey(id, ctx.now);
    await audit(ctx, { action: 'apikey.revoked', target: { type: 'apikey', id }, details: { name: k.name, prefix: k.prefix } });
    return keyView((await store.apiKeys()).find((x) => x.id === id)!);
  });

  const webhookView = ({ createdBy: _c, fromOffset: _f, deletedAt: _d, ...w }: (typeof webhooks)[number]) => w;

  function webhookUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) throw bad('"url" must be an absolute http(s) URL');
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw bad('"url" must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw bad('"url" must be an absolute http(s) URL');
    return parsed.toString();
  }

  function webhookEvents(events: unknown): string[] {
    if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string' && validEventPattern(e))) {
      throw bad('"events" must be a non-empty list of event types (wildcards like "payment.*" or "*" allowed)');
    }
    return [...new Set(events as string[])];
  }

  async function loadWebhook(id: string) {
    const w = (await store.webhooks()).find((x) => x.id === id);
    if (!w) throw notFound(`webhook ${id}`);
    return w;
  }
  route('GET', '/developer/webhooks', 'developer.manage', async () => (await store.webhooks()).map(webhookView));

  route('POST', '/developer/webhooks', 'developer.manage', async (ctx, res) => {
    const url = webhookUrl(ctx.body.url);
    const events = webhookEvents(ctx.body.events);
    const w = { id: `wh_${randomBytes(6).toString('hex')}`, url, events, enabled: true, createdAt: ctx.now, createdBy: ctx.actor, fromOffset: await bus.head(), deletedAt: null };
    await store.createWebhook(w);
    webhooks = await store.webhooks();
    await audit(ctx, { action: 'webhook.created', target: { type: 'webhook', id: w.id }, details: { url: w.url, events: w.events } });
    res.statusCode = 201;
    return webhookView(w);
  });

  for (const action of ['enable', 'disable'] as const) {
    route('POST', `/developer/webhooks/:id/${action}`, 'developer.manage', async (ctx) => {
      const id = ctx.params[0]!;
      const w = await loadWebhook(id);
      await store.setWebhookEnabled(id, action === 'enable');
      webhooks = await store.webhooks();
      await audit(ctx, { action: `webhook.${action}d`, target: { type: 'webhook', id }, details: { url: w.url } });
      return webhookView(webhooks.find((x) => x.id === id)!);
    });
  }

  route('PUT', '/developer/webhooks/:id', 'developer.manage', async (ctx) => {
    const w = await loadWebhook(ctx.params[0]!);
    const next = {
      url: ctx.body.url === undefined ? w.url : webhookUrl(ctx.body.url),
      events: ctx.body.events === undefined ? w.events : webhookEvents(ctx.body.events),
      enabled: ctx.body.enabled === undefined ? w.enabled : ctx.body.enabled,
    };
    if (typeof next.enabled !== 'boolean') throw bad('"enabled" must be true or false');
    await store.updateWebhook(w.id, next as { url: string; events: string[]; enabled: boolean });
    webhooks = await store.webhooks();
    await audit(ctx, { action: 'webhook.updated', target: { type: 'webhook', id: w.id }, details: { from: { url: w.url, events: w.events, enabled: w.enabled }, to: next } });
    return webhookView(await loadWebhook(w.id));
  });

  route('DELETE', '/developer/webhooks/:id', 'developer.manage', async (ctx) => {
    const w = await loadWebhook(ctx.params[0]!);
    await store.deleteWebhook(w.id, ctx.now);
    webhooks = await store.webhooks();
    await audit(ctx, { action: 'webhook.deleted', target: { type: 'webhook', id: w.id }, details: { url: w.url, events: w.events } });
    return { ok: true, id: w.id };
  });

  // Send a test event to the endpoint — SIMULATED: recorded as a delivery, nothing leaves the machine.
  route('POST', '/developer/webhooks/:id/test', 'developer.manage', async (ctx, res) => {
    const w = await loadWebhook(ctx.params[0]!);
    const eventId = `evt_test_${randomBytes(8).toString('hex')}`;
    const id = `whd_${deterministicId('webhook', w.id, eventId).replace(/-/g, '').slice(0, 20)}`;
    const delivery = { id, endpointId: w.id, eventId, eventType: 'webhook.test', at: ctx.now, status: 'simulated' as const, responseMs: 40 + Math.round(unitHash(id) * 160) };
    await store.recordDelivery(delivery);
    await audit(ctx, { action: 'webhook.tested', target: { type: 'webhook', id: w.id }, details: { deliveryId: id, simulated: true } });
    res.statusCode = 201;
    return delivery;
  });

  route('GET', '/developer/webhooks/deliveries', 'developer.manage', async (ctx) => {
    const limit = Number(ctx.url.searchParams.get('limit') ?? '100');
    return store.deliveries({ endpointId: ctx.url.searchParams.get('endpointId') ?? undefined, limit: Number.isFinite(limit) ? limit : 100 });
  });

  // ------------------------------------------------------------------------------------------ http

  async function authenticate(req: IncomingMessage): Promise<{ user: DemoUser; tokenHash: string; token: string }> {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw new HttpError(401, 'sign in required (Authorization: Bearer <token>)');
    const tokenHash = sha256(m[1]!);
    const s = await store.session(tokenHash);
    if (!s || s.revokedAt || Date.parse(s.expiresAt) <= nowDate().getTime()) throw new HttpError(401, 'session expired or signed out');
    const user = findUser(s.userId);
    if (!user) throw new HttpError(401, 'unknown user');
    return { user, tokenHash, token: m[1]! };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ops.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (path === '/health' && method === 'GET') {
      const head = await bus.head();
      return send(res, 200, { ok: true, service: 'ops', driver: store.kind, offset: projection.processed, head, caughtUp: projection.processed >= head - 1, payments: projection.payments.size, alerts: projection.alerts.size });
    }
    if (path === '/auth/users' && method === 'GET') return send(res, 200, DEMO_USERS);
    if (path === '/auth/login' && method === 'POST') {
      const body = await readJson(req);
      const userId = body.userId;
      const user = typeof userId === 'string' ? findUser(userId) : undefined;
      if (!user) return send(res, 400, { error: `unknown user ${JSON.stringify(userId ?? null)}` });
      const token = randomBytes(32).toString('base64url');
      const now = iso();
      const expiresAt = new Date(nowDate().getTime() + ttl).toISOString();
      await store.createSession(sha256(token), user.id, now, expiresAt);
      await store.audit({ at: now, actor: actorOf(user), action: 'auth.login', target: { type: 'user', id: user.id }, details: { role: user.role } });
      return send(res, 200, sessionOf(user, token, expiresAt));
    }

    const r = routes.find((x) => x.method === method && x.pattern.test(path));
    if (!r) {
      const any = routes.some((x) => x.pattern.test(path));
      return send(res, any ? 405 : 404, { error: any ? 'method not allowed' : 'not found' });
    }
    const { user, tokenHash, token } = await authenticate(req);
    if (r.perm && !hasPermission(user, r.perm)) {
      return send(res, 403, { error: `forbidden: ${user.role} lacks ${r.perm}`, missingPermission: r.perm, role: user.role });
    }
    const params = (r.pattern.exec(path) ?? []).slice(1).map((p) => decodeURIComponent(p));
    const body = method === 'POST' || method === 'PUT' ? await readJson(req) : {};
    const run = async () => {
      const ctx: Ctx = { req, url, params, body, user, actor: actorOf(user), tokenHash, token, now: iso() };
      return r.handler(ctx, res);
    };
    const result = r.mutating ? await mutex.run(run) : await run();
    if (result === RAW) return;
    send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, result);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) return send(res, err.status, { error: err.message, ...err.extra });
        return void res.end();
      }
      log(`[ops] http error ${req.method} ${req.url}: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  try {
    await sync(options.catchUpTimeoutMs ?? 120_000);
  } catch (err) {
    log(`[ops] still catching up with the log: ${(err as Error).message}`);
  }

  let closing: Promise<void> | undefined;
  return {
    port,
    projection,
    sync: () => sync(),
    close: () =>
      (closing ??= (async () => {
        await subscription.unsubscribe();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })()),
  };
}

const RAW = Symbol('raw-response');

const ALL_TYPES: readonly string[] = [...EVENT_TYPES, ...CONTROL_EVENT_TYPES];
function validEventPattern(p: string): boolean {
  if (p === '*') return true;
  if (p.endsWith('.*')) return ALL_TYPES.some((t) => t.startsWith(p.slice(0, -1)));
  return ALL_TYPES.includes(p);
}
export function matchesEvent(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}
