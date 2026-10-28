// Pure analysis for `npm run verify:m4` (M4: operations console + risk & compliance). Folds the payment
// log into the M4 facts the checks need (alerts, quotes, routing decisions, operator events, config
// updates, FX shocks) and turns observations into pass/fail checks. No I/O here: m4.ts drives the system.
import { isControlEvent, type AnyEvent, type BusEvent, type JournalView } from '@ct/contracts';
import type { Check } from './analyze';

export interface AlertFact {
  offset: number;
  alertId: string;
  kind: 'sanctions' | 'fraud' | 'aml';
  severity: 'low' | 'medium' | 'high' | 'critical';
  rule: string;
}

export interface OperatorFact {
  offset: number;
  eventId: string;
  type: 'payment.released' | 'payment.rejected' | 'payment.retry_requested' | 'payment.refund_requested' | 'payment.refunded';
  paymentId: string;
  producer: string;
  payload: Record<string, unknown>;
}

export interface RoutedDecision {
  offset: number;
  paymentId: string;
  providerId: string;
  /** 1-based; payloads without an attempt are first attempts (M1). */
  attempt: number;
}

export interface ConfigUpdateFact {
  offset: number;
  eventId: string;
  key: string;
  value: unknown;
  version: number;
  changeRequestId: string;
  actor?: { userId: string };
  approvedBy?: { userId: string };
}

const OPERATOR_TYPES = new Set(['payment.released', 'payment.rejected', 'payment.retry_requested', 'payment.refund_requested', 'payment.refunded']);

/** Incremental: feed events in offset order. */
export class M4Log {
  nextOffset = 0;
  readonly keyOf = new Map<string, string>();
  readonly byKey = new Map<string, string>();
  readonly corridorOf = new Map<string, string>();
  readonly alerts = new Map<string, AlertFact[]>();
  readonly spreadBps = new Map<string, number>();
  readonly routed: RoutedDecision[] = [];
  readonly operator: OperatorFact[] = [];
  readonly configUpdates: ConfigUpdateFact[] = [];
  readonly fxShocks: { offset: number; type: 'started' | 'ended'; shockId: string; runId?: string; corridorId?: string }[] = [];
  readonly eventsById = new Map<string, { offset: number; type: string; paymentId: string; payload: Record<string, unknown> }>();

  apply(offset: number, event: AnyEvent | BusEvent): void {
    this.nextOffset = offset + 1;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (!this.eventsById.has(event.eventId)) this.eventsById.set(event.eventId, { offset, type: event.type, paymentId: event.paymentId, payload: slim(payload) });
    if (isControlEvent(event)) {
      if (event.type === 'control.config.updated') {
        const p = event.payload;
        this.configUpdates.push({ offset, eventId: event.eventId, key: p.key, value: p.value, version: p.version, changeRequestId: p.changeRequestId, actor: p.actor, approvedBy: p.approvedBy });
      } else if (event.type === 'control.fx_shock.started') {
        this.fxShocks.push({ offset, type: 'started', shockId: event.payload.shockId, runId: event.payload.runId, corridorId: event.payload.corridorId });
      } else if (event.type === 'control.fx_shock.ended') {
        this.fxShocks.push({ offset, type: 'ended', shockId: event.payload.shockId, runId: event.payload.runId });
      }
      return;
    }
    const e = event as AnyEvent;
    switch (e.type) {
      case 'payment.initiated':
        if (!this.keyOf.has(e.paymentId)) {
          this.keyOf.set(e.paymentId, e.payload.idempotencyKey);
          this.byKey.set(e.payload.idempotencyKey, e.paymentId);
          this.corridorOf.set(e.paymentId, e.payload.corridor);
        }
        return;
      case 'risk.alert_raised': {
        const list = this.alerts.get(e.paymentId) ?? [];
        if (!list.some((a) => a.alertId === e.payload.alertId)) list.push({ offset, alertId: e.payload.alertId, kind: e.payload.kind, severity: e.payload.severity, rule: e.payload.rule });
        this.alerts.set(e.paymentId, list);
        return;
      }
      case 'payment.quoted':
        this.spreadBps.set(e.paymentId, e.payload.spreadBps);
        return;
      case 'payment.routed':
        this.routed.push({ offset, paymentId: e.paymentId, providerId: e.payload.providerId, attempt: e.payload.attempt ?? 1 });
        return;
      default:
        if (OPERATOR_TYPES.has(e.type)) {
          this.operator.push({ offset, eventId: e.eventId, type: e.type as OperatorFact['type'], paymentId: e.paymentId, producer: e.producer, payload: slim(payload) });
        }
    }
  }

  /** Payments whose Idempotency-Key starts with `prefix` (e.g. a scenario run's crafted payments). */
  paymentsWithKeyPrefix(prefix: string): string[] {
    return [...this.byKey.entries()].filter(([k]) => k.startsWith(prefix)).map(([, id]) => id);
  }

  operatorEvents(paymentId: string, type?: OperatorFact['type']): OperatorFact[] {
    return this.operator.filter((o) => o.paymentId === paymentId && (type === undefined || o.type === type));
  }
}

function slim(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.message !== 'string') return payload;
  const { message: _m, ...rest } = payload;
  return rest;
}

const sample = <T>(xs: readonly T[]) => xs.slice(0, 20);

// ------------------------------------------------------------------------------------------------ (h) FX

export interface SpreadStats {
  n: number;
  avg: number | null;
  max: number | null;
}

export function spreadStats(log: M4Log, paymentIds: readonly string[]): SpreadStats {
  const xs = paymentIds.map((id) => log.spreadBps.get(id)).filter((x): x is number => typeof x === 'number');
  if (xs.length === 0) return { n: 0, avg: null, max: null };
  return { n: xs.length, avg: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), max: Math.max(...xs) };
}

/** (h) quotes during the shock have wider spreads than before it, and narrow again after it ended. */
export function checkFxSpreads(log: M4Log, runId: string, groups: { before: string[]; during: string[]; after: string[] }): Check[] {
  const before = spreadStats(log, groups.before);
  const during = spreadStats(log, groups.during);
  const after = spreadStats(log, groups.after);
  const started = log.fxShocks.find((s) => s.type === 'started' && s.runId === runId);
  const ended = log.fxShocks.find((s) => s.type === 'ended' && s.runId === runId && (!started || s.shockId === started.shockId));
  const detail = `before ${fmt(before)}, during ${fmt(during)}, after ${fmt(after)}`;
  return [
    {
      id: 'h.fx-shock-events',
      title: 'fx-spike published control.fx_shock.started and control.fx_shock.ended for its run',
      ok: Boolean(started && ended && ended.offset > started.offset),
      detail: started ? `started @${started.offset} on ${started.corridorId}${ended ? `, ended @${ended.offset}` : ', NOT ended'}` : 'no control.fx_shock.started for the run',
    },
    {
      id: 'h.spread-wider-during',
      title: 'Quotes during the FX shock have a wider spread than before it (spreadBps)',
      ok: before.n > 0 && during.n > 0 && during.avg! > before.avg! && during.max! > before.max!,
      detail,
    },
    {
      id: 'h.spread-narrows-after',
      title: 'Quotes after the shock ended are narrower again than during it',
      ok: after.n > 0 && during.n > 0 && after.avg! < during.avg!,
      detail,
    },
  ];
}

function fmt(s: SpreadStats): string {
  return s.n === 0 ? 'no quotes' : `${s.n} quote(s) avg ${s.avg} bps max ${s.max} bps`;
}

// ------------------------------------------------------------------------------------------------ (g) routing

/** First-attempt routing decisions to `providerId` after `fromOffset` (the config update). */
export function firstAttemptRoutesTo(log: M4Log, providerId: string, fromOffset: number, paymentIds?: ReadonlySet<string>): RoutedDecision[] {
  return log.routed.filter((r) => r.offset > fromOffset && r.attempt === 1 && r.providerId === providerId && (!paymentIds || paymentIds.has(r.paymentId)));
}

export function checkNoRoutingTo(log: M4Log, providerId: string, fromOffset: number, toOffset: number | null, paymentIds: ReadonlySet<string>): Check {
  const inWindow = log.routed.filter((r) => r.offset > fromOffset && (toOffset === null || r.offset < toOffset));
  const bad = inWindow.filter((r) => r.attempt === 1 && r.providerId === providerId);
  const ours = inWindow.filter((r) => paymentIds.has(r.paymentId) && r.attempt === 1);
  const byProvider: Record<string, number> = {};
  for (const r of ours) byProvider[r.providerId] = (byProvider[r.providerId] ?? 0) + 1;
  return {
    id: 'g.no-first-attempt-to-disabled',
    title: `No first-attempt routing to ${providerId} while it is disabled`,
    ok: bad.length === 0 && ours.length > 0,
    detail: `${inWindow.length} routing decision(s) while disabled, ${bad.length} first attempt(s) to ${providerId}; our ${ours.length} payment(s) went to ${JSON.stringify(byProvider)}`,
    examples: bad.length ? sample(bad) : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ (f) refund

/** The reversal must post the original entries with debit and credit swapped (same accounts, amounts). */
export function isMirrorReversal(original: JournalView, reversal: JournalView): { ok: boolean; why?: string } {
  const key = (e: JournalView['entries'][number], flip: boolean) =>
    `${e.accountId}|${flip ? (e.direction === 'debit' ? 'credit' : 'debit') : e.direction}|${e.amount.currency}|${e.amount.amountMinor}`;
  const a = original.entries.map((e) => key(e, true)).sort();
  const b = reversal.entries.map((e) => key(e, false)).sort();
  if (a.length === 0) return { ok: false, why: 'original journal has no entries' };
  if (a.length !== b.length) return { ok: false, why: `entry count ${original.entries.length} vs ${reversal.entries.length}` };
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { ok: false, why: `entry mismatch: ${a[i]} vs ${b[i]}` };
  return { ok: true };
}

/** Per currency, debits = credits within one journal. */
export function journalBalanced(j: JournalView): boolean {
  const sums = new Map<string, number>();
  for (const e of j.entries) sums.set(e.amount.currency, (sums.get(e.amount.currency) ?? 0) + (e.direction === 'debit' ? e.amount.amountMinor : -e.amount.amountMinor));
  return [...sums.values()].every((v) => v === 0);
}

// ------------------------------------------------------------------------------------------------ (i) audit

export interface MutatingCall {
  userId: string;
  method: string;
  path: string;
  status: number;
  /** Ids the audit row should name (target id, payment id or refund id). */
  targets: string[];
  at: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: { userId: string; name?: string; role?: string };
  action: string;
  target: { type: string; id: string };
  details?: Record<string, unknown>;
  eventId?: string;
  paymentId?: string;
}

function rowNames(r: AuditRow): Set<string> {
  const ids = new Set<string>([r.target.id]);
  if (r.paymentId) ids.add(r.paymentId);
  for (const k of ['refundId', 'paymentId', 'caseId', 'changeRequestId']) {
    const v = r.details?.[k];
    if (typeof v === 'string') ids.add(v);
  }
  return ids;
}

/** Every successful mutating call has an audit row with the caller as actor naming one of its targets. */
export function checkAuditCoverage(calls: readonly MutatingCall[], rows: readonly AuditRow[]): Check {
  const ok2xx = calls.filter((c) => c.status >= 200 && c.status < 300);
  const missing = ok2xx.filter((c) => !rows.some((r) => r.actor.userId === c.userId && c.targets.some((t) => rowNames(r).has(t))));
  return {
    id: 'i.audit-coverage',
    title: 'Every successful mutating call is in the audit trail with the acting user',
    ok: ok2xx.length > 0 && missing.length === 0,
    detail: `${ok2xx.length} successful mutating call(s), ${missing.length} without an audit row; ${rows.length} audit row(s) read`,
    examples: missing.length ? sample(missing) : undefined,
  };
}

/** Rows read earlier must be unchanged later (append-only trail). */
export function checkAuditUnchanged(before: readonly AuditRow[], after: readonly AuditRow[]): Check {
  const later = new Map(after.map((r) => [r.id, r]));
  const changed = before.filter((r) => JSON.stringify(later.get(r.id) ?? null) !== JSON.stringify(r));
  return {
    id: 'i.audit-append-only',
    title: 'Audit rows read earlier are unchanged and still present at the end',
    ok: before.length > 0 && changed.length === 0 && after.length >= before.length,
    detail: `${before.length} row(s) snapshotted, ${after.length} at the end, ${changed.length} changed or missing`,
    examples: changed.length ? sample(changed.map((r) => ({ id: r.id, before: r, after: later.get(r.id) ?? null }))) : undefined,
  };
}

/** Audit rows that cite a log event must point at a real event; operator events must carry the actor. */
export function checkAuditEventLinks(rows: readonly AuditRow[], log: M4Log): Check {
  const linked = rows.filter((r) => r.eventId);
  // People named (maker `by` / checker `approvedBy`) on any audit row for the same event: e.g. the
  // approver's case.closed row cites payment.rejected, whose payload has an actor but no approvedBy field.
  const namedFor = new Map<string, Set<unknown>>();
  for (const r of linked) {
    const s = namedFor.get(r.eventId!) ?? new Set<unknown>();
    for (const v of [r.details?.by, r.details?.approvedBy, (r.details?.approvedBy as { userId?: string } | undefined)?.userId]) if (typeof v === 'string') s.add(v);
    namedFor.set(r.eventId!, s);
  }
  const broken = linked.filter((r) => {
    const ev = log.eventsById.get(r.eventId!);
    if (!ev) return true;
    if (ev.type.startsWith('control.')) return false;
    if (r.paymentId && ev.paymentId !== r.paymentId) return true;
    const actor = ev.payload.actor as { userId?: string } | undefined;
    // System rows (e.g. case.opened from risk.alert_raised) cite events no person produced.
    if (!actor) return false;
    // The person on the row must be on the event: its maker, its checker (approvedBy on the event, or on
    // the row's details when the event type has no approvedBy field, e.g. payment.rejected).
    const people = new Set([actor.userId, (ev.payload.approvedBy as { userId?: string } | undefined)?.userId, r.details?.by, r.details?.approvedBy, (r.details?.approvedBy as { userId?: string } | undefined)?.userId]);
    if (!people.has(r.actor.userId) && !namedFor.get(r.eventId!)?.has(r.actor.userId)) return true;
    // ... and the event must name the same maker the row names.
    return typeof r.details?.by === 'string' && r.details.by !== actor.userId;
  });
  return {
    id: 'i.audit-event-links',
    title: 'Audit rows that produced an event link to that event on the log, with the same person on it',
    ok: linked.length > 0 && broken.length === 0,
    detail: `${linked.length} audit row(s) with an eventId, ${broken.length} broken link(s)`,
    examples: broken.length ? sample(broken) : undefined,
  };
}

/** Operator events (producer ops) carry the actor; m4 drives them, so each must have a matching audit row. */
export function checkOperatorEventsHaveActors(log: M4Log): Check {
  const ops = log.operator.filter((o) => o.type !== 'payment.refunded' && !(o.type === 'payment.rejected' && o.payload.atStage !== 'ops'));
  const bad = ops.filter((o) => {
    const actor = o.payload.actor as { userId?: string } | undefined;
    return o.producer !== 'ops' || !actor?.userId;
  });
  return {
    id: 'i.operator-events-actor',
    title: 'Every operator event on the log (released / rejected at ops / retry / refund) has producer ops and an actor',
    ok: ops.length > 0 && bad.length === 0,
    detail: `${ops.length} operator event(s), ${bad.length} without producer ops + actor`,
    examples: bad.length ? sample(bad) : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ helpers

export function check(id: string, title: string, ok: boolean, detail: string, examples?: unknown[]): Check {
  return { id, title, ok, detail, ...(examples && examples.length ? { examples: sample(examples) } : {}) };
}

export function countBy<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}
