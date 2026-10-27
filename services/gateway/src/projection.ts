// Read-side projection: folds the event log into payment states, per-payment event lists, and
// incrementally maintained aggregates (stats, providers, FX quotes, statements, throughput).
// Pure in-memory; rebuilt from the earliest offset on every start. Every apply() is O(events of
// that payment), never O(payments), so replaying ~120k events stays fast.
import {
  applyEvent,
  exponentOf,
  isTerminal,
  PIPELINE,
  type AnyEvent,
  type Money,
  type PaymentState,
  type PaymentStatus,
} from '@ct/contracts';
import type {
  IsoMessage,
  PaymentDetail,
  PaymentsPage,
  PaymentSummary,
  PaymentTrend,
  ProviderFailure,
  QuoteStats,
  RejectedEvent,
  StatementGroup,
  StatementRef,
  Stats,
} from './api-types';
import { ThroughputMeter } from './throughput';

export const ALL_STATUSES: readonly PaymentStatus[] = [...PIPELINE, 'retrying', 'held', 'rejected', 'failed', 'refund_requested', 'refunded'];
const MAX_REJECTED = 500;
/** Per-payment event cap. A normal payment has 9-20 events; this only bites on a runaway retry loop. */
export const MAX_EVENTS_PER_PAYMENT = 64;
const MAX_RECENT_FAILURES = 20;

export type ApplyResult =
  | { kind: 'applied'; event: AnyEvent; state: PaymentState; summary: PaymentSummary }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; error: string };

export function summarize(state: PaymentState): PaymentSummary {
  const f = state.facts;
  const quoted = f['payment.quoted'];
  const routed = f['payment.routed'];
  let lastPipelineIndex = -1;
  let retries = 0;
  for (const h of state.history) {
    lastPipelineIndex = Math.max(lastPipelineIndex, PIPELINE.indexOf(h.status));
    if (h.type === 'payment.send_failed') retries += 1;
  }
  const summary: PaymentSummary = {
    paymentId: state.paymentId,
    status: state.status,
    corridor: state.initiated.corridor,
    amount: state.initiated.amount,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    stepIndex: PIPELINE.indexOf(state.status),
    lastPipelineIndex,
    ledgerPosted: state.ledgerPosted,
    retries,
  };
  const target: Money | undefined = quoted?.targetAmount;
  if (target) summary.targetAmount = target;
  if (routed) {
    summary.providerId = routed.providerId;
    if (routed.attempt !== undefined) summary.attempt = routed.attempt;
  }
  if (state.initiated.scenario) summary.scenario = state.initiated.scenario;
  let reason: string | undefined;
  if (state.status === 'held') reason = f['payment.held']?.reason;
  else if (state.status === 'rejected') reason = f['payment.rejected']?.reason;
  else if (state.status === 'failed') reason = f['payment.failed']?.reason;
  else if (state.status === 'retrying') {
    const sf = f['payment.send_failed'];
    if (sf) reason = `${sf.reasonCode} ${sf.reason}`;
  }
  if (reason) summary.reason = reason;
  if (state.status === 'reconciled') {
    const ms = Date.parse(state.updatedAt) - Date.parse(state.createdAt);
    if (Number.isFinite(ms)) summary.endToEndMs = ms;
    const rec = f['payment.reconciled'];
    if (rec) summary.recon = rec.matched ? 'matched' : 'break';
  }
  return summary;
}

interface PaymentRecord {
  state: PaymentState;
  events: AnyEvent[];
  dropped: number;
  summary: PaymentSummary;
  sentAtMs?: number;
}

export interface ProviderAggregate {
  routed: number;
  sent: number;
  settled: number;
  sendFailed: number;
  latencySumMs: number;
  latencyCount: number;
  feeBpsSum: number;
  feeBpsCount: number;
  feeByCurrency: Map<string, { sum: number; count: number }>;
  recentFailures: ProviderFailure[];
  failureReasons: Record<string, number>;
}

function newProviderAggregate(): ProviderAggregate {
  return {
    routed: 0, sent: 0, settled: 0, sendFailed: 0, latencySumMs: 0, latencyCount: 0,
    feeBpsSum: 0, feeBpsCount: 0, feeByCurrency: new Map(), recentFailures: [], failureReasons: {},
  };
}

interface QuoteAggregate {
  count: number;
  spreadSum: number;
  last?: { rate: string; mid?: string; spreadBps: number; at: string };
}

export interface PaymentFilter {
  status?: PaymentStatus[];
  corridor?: string;
  provider?: string;
  /** M4 console: case-insensitive substring over payment id, end-to-end/message ids, settlement ref and party names/accounts. */
  q?: string;
  /** Source currency (ISO 4217). */
  currency?: string;
  /** Source amount range in MAJOR units of the payment's own currency (inclusive). */
  minAmount?: number;
  maxAmount?: number;
  /** createdAt range (inclusive, epoch ms). */
  fromMs?: number;
  toMs?: number;
}

/** Text a payment can be found by (console global search). Lower-cased. */
export function searchText(state: PaymentState): string {
  const i = state.initiated;
  const f = state.facts;
  return [
    state.paymentId,
    i.debtor.name, i.debtor.accountId, i.creditor.name, i.creditor.accountId, i.idempotencyKey,
    f['payment.sent']?.messageId, f['payment.settled']?.settlementRef, f['payment.quoted']?.quoteId,
    f['ledger.posted']?.journalId, f['payment.reconciled']?.statementRef,
  ]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' | ')
    .toLowerCase();
}

/** True when the record matches the M4 extended filters (q, currency, amount range, date range). */
export function matchesExtended(state: PaymentState, filter: PaymentFilter, q: string | null): boolean {
  const amount = state.initiated.amount;
  if (filter.currency && amount.currency !== filter.currency) return false;
  if (filter.minAmount !== undefined || filter.maxAmount !== undefined) {
    const major = amount.amountMinor / 10 ** exponentOf(amount.currency);
    if (filter.minAmount !== undefined && major < filter.minAmount) return false;
    if (filter.maxAmount !== undefined && major > filter.maxAmount) return false;
  }
  if (filter.fromMs !== undefined || filter.toMs !== undefined) {
    const t = Date.parse(state.createdAt);
    if (filter.fromMs !== undefined && !(t >= filter.fromMs)) return false;
    if (filter.toMs !== undefined && !(t <= filter.toMs)) return false;
  }
  if (q && !searchText(state).includes(q)) return false;
  return true;
}

function messageOf(event: AnyEvent): IsoMessage | null {
  switch (event.type) {
    case 'payment.sent': {
      const p = event.payload;
      if (typeof p.message !== 'string' || !p.message) return null;
      const m: IsoMessage = {
        eventId: event.eventId, eventType: event.type, messageType: 'pacs.008', occurredAt: event.occurredAt,
        providerId: p.providerId, xml: p.message,
      };
      if (p.attempt !== undefined) m.attempt = p.attempt;
      return m;
    }
    case 'payment.send_failed': {
      const p = event.payload;
      if (typeof p.message !== 'string' || !p.message) return null;
      return {
        eventId: event.eventId, eventType: event.type, messageType: 'pacs.002', occurredAt: event.occurredAt,
        providerId: p.providerId, attempt: p.attempt, status: 'RJCT', reasonCode: p.reasonCode, xml: p.message,
      };
    }
    case 'payment.settled': {
      const p = event.payload;
      if (typeof p.message !== 'string' || !p.message) return null;
      const m: IsoMessage = {
        eventId: event.eventId, eventType: event.type, messageType: 'pacs.002', occurredAt: event.occurredAt,
        providerId: p.providerId, status: 'ACSC', xml: p.message,
      };
      if (p.attempt !== undefined) m.attempt = p.attempt;
      return m;
    }
    default:
      return null;
  }
}

export class Projection {
  private readonly records = new Map<string, PaymentRecord>();
  /** Payment ids in first-seen (log) order. */
  private readonly order: string[] = [];
  private readonly rejectedList: RejectedEvent[] = [];
  private rejectedTotal = 0;
  private eventCount = 0;
  private readonly byStatus: Record<PaymentStatus, number>;
  private endToEndSumMs = 0;
  private endToEndCount = 0;
  private retriesTotal = 0;
  private reconBreaks = 0;
  private reconMatched = 0;
  readonly providers = new Map<string, ProviderAggregate>();
  private readonly quotes = new Map<string, QuoteAggregate>();
  private readonly statements = new Map<string, StatementGroup>();
  readonly throughput: ThroughputMeter;

  constructor(options: { now?: () => number } = {}) {
    this.byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<PaymentStatus, number>;
    this.throughput = new ThroughputMeter(options.now ?? Date.now);
  }

  apply(event: AnyEvent): ApplyResult {
    const paymentId = typeof event?.paymentId === 'string' ? event.paymentId : '';
    const rec = paymentId ? this.records.get(paymentId) : undefined;
    const prev = rec?.state;
    let next: PaymentState;
    try {
      if (!paymentId) throw new Error('event has no paymentId');
      next = applyEvent(prev, event);
    } catch (err) {
      this.rejectedTotal += 1;
      this.rejectedList.push({ event, error: err instanceof Error ? err.message : String(err), receivedAt: new Date().toISOString() });
      if (this.rejectedList.length > MAX_REJECTED) this.rejectedList.shift();
      return { kind: 'rejected', error: this.rejectedList.at(-1)!.error };
    }
    if (next === prev) return { kind: 'duplicate' };

    const summary = summarize(next);
    let record: PaymentRecord;
    if (!rec) {
      record = { state: next, events: [event], dropped: 0, summary };
      this.records.set(paymentId, record);
      this.order.push(paymentId);
    } else {
      record = rec;
      record.state = next;
      record.summary = summary;
      if (record.events.length >= MAX_EVENTS_PER_PAYMENT) {
        record.events.splice(1, 1); // keep payment.initiated, drop the oldest after it
        record.dropped += 1;
      }
      record.events.push(event);
    }
    this.eventCount += 1;
    if (prev) this.byStatus[prev.status] -= 1;
    this.byStatus[next.status] += 1;
    const completed = next.status !== prev?.status && isTerminal(next.status);
    this.throughput.record(Date.parse(event.occurredAt), { initiated: event.type === 'payment.initiated', completed });
    this.aggregate(event, record, prev, next);
    return { kind: 'applied', event, state: next, summary };
  }

  private provider(id: string): ProviderAggregate {
    let p = this.providers.get(id);
    if (!p) {
      p = newProviderAggregate();
      this.providers.set(id, p);
    }
    return p;
  }

  private aggregate(event: AnyEvent, record: PaymentRecord, prev: PaymentState | undefined, next: PaymentState): void {
    switch (event.type) {
      case 'payment.quoted': {
        const p = event.payload;
        const corridor = next.initiated.corridor;
        const q = this.quotes.get(corridor) ?? { count: 0, spreadSum: 0 };
        q.count += 1;
        q.spreadSum += Number.isFinite(p.spreadBps) ? p.spreadBps : 0;
        q.last = { rate: p.rate, spreadBps: p.spreadBps, at: event.occurredAt };
        if (p.midRate) q.last.mid = p.midRate;
        this.quotes.set(corridor, q);
        break;
      }
      case 'payment.routed': {
        const p = event.payload;
        const agg = this.provider(p.providerId);
        agg.routed += 1;
        const fee = p.estimatedFee;
        if (fee && Number.isFinite(fee.amountMinor)) {
          const c = agg.feeByCurrency.get(fee.currency) ?? { sum: 0, count: 0 };
          c.sum += fee.amountMinor;
          c.count += 1;
          agg.feeByCurrency.set(fee.currency, c);
          const amt = next.initiated.amount;
          if (amt.currency === fee.currency && amt.amountMinor > 0) {
            agg.feeBpsSum += (fee.amountMinor / amt.amountMinor) * 10_000;
            agg.feeBpsCount += 1;
          }
        }
        break;
      }
      case 'payment.sent': {
        this.provider(event.payload.providerId).sent += 1;
        record.sentAtMs = Date.parse(event.occurredAt);
        break;
      }
      case 'payment.send_failed': {
        const p = event.payload;
        const agg = this.provider(p.providerId);
        agg.sendFailed += 1;
        this.retriesTotal += 1;
        agg.failureReasons[p.reasonCode] = (agg.failureReasons[p.reasonCode] ?? 0) + 1;
        agg.recentFailures.push({
          paymentId: event.paymentId, attempt: p.attempt, reasonCode: p.reasonCode, reason: p.reason, occurredAt: event.occurredAt,
        });
        if (agg.recentFailures.length > MAX_RECENT_FAILURES) agg.recentFailures.shift();
        break;
      }
      case 'payment.settled': {
        const p = event.payload;
        const agg = this.provider(p.providerId);
        agg.settled += 1;
        const ms = Date.parse(event.occurredAt) - (record.sentAtMs ?? Number.NaN);
        if (Number.isFinite(ms) && ms >= 0) {
          agg.latencySumMs += ms;
          agg.latencyCount += 1;
        }
        const se = p.statementEntry;
        if (se && se.amount && typeof se.bookingDate === 'string') {
          const providerId = se.providerId || p.providerId;
          const key = `${providerId}|${se.bookingDate}|${se.amount.currency}`;
          let g = this.statements.get(key);
          if (!g) {
            g = {
              providerId, date: se.bookingDate, currency: se.amount.currency,
              statementId: se.statementId || `STMT-${providerId}-${se.bookingDate}-${se.amount.currency}`,
              entries: 0, totalMinor: 0, list: [],
            };
            this.statements.set(key, g);
          }
          g.list.push(se);
          g.entries += 1;
          g.totalMinor += se.amount.amountMinor;
        }
        break;
      }
      case 'payment.reconciled': {
        if (event.payload.matched) this.reconMatched += 1;
        else this.reconBreaks += 1;
        break;
      }
      default:
        break;
    }
    if (next.status === 'reconciled' && prev?.status !== 'reconciled') {
      const ms = Date.parse(next.updatedAt) - Date.parse(next.createdAt);
      if (Number.isFinite(ms)) {
        this.endToEndSumMs += ms;
        this.endToEndCount += 1;
      }
    }
  }

  get paymentCount(): number {
    return this.records.size;
  }

  get totalEvents(): number {
    return this.eventCount;
  }

  /** Newest first (by first appearance in the log). */
  summaries(limit = 50): PaymentSummary[] {
    return this.page({}, 0, limit).items;
  }

  /** Filtered page, newest first. O(payments) worst case (a scan with early exit), no sorting. */
  page(filter: PaymentFilter, offset: number, limit: number): PaymentsPage {
    const statuses = filter.status && filter.status.length ? new Set(filter.status) : null;
    const q = filter.q ? filter.q.trim().toLowerCase() : '';
    const extended =
      q !== '' || !!filter.currency || filter.minAmount !== undefined || filter.maxAmount !== undefined ||
      filter.fromMs !== undefined || filter.toMs !== undefined;
    const unfiltered = !statuses && !filter.corridor && !filter.provider && !extended;
    const items: PaymentSummary[] = [];
    let matched = 0;
    if (unfiltered) {
      const total = this.order.length;
      for (let i = total - 1 - offset; i >= 0 && items.length < limit; i--) {
        const r = this.records.get(this.order[i]!);
        if (r) items.push(r.summary);
      }
      return { total, offset, limit, items };
    }
    for (let i = this.order.length - 1; i >= 0; i--) {
      const rec = this.records.get(this.order[i]!);
      const s = rec?.summary;
      if (!rec || !s) continue;
      if (statuses && !statuses.has(s.status)) continue;
      if (filter.corridor && s.corridor !== filter.corridor) continue;
      if (filter.provider && s.providerId !== filter.provider) continue;
      if (extended && !matchesExtended(rec.state, filter, q || null)) continue;
      if (matched >= offset && items.length < limit) items.push(s);
      matched += 1;
    }
    return { total: matched, offset, limit, items };
  }

  /**
   * Payments initiated (and now failed/rejected) per minute over the last `minutes`, by createdAt.
   * Walks the log order newest-first and stops once well past the window: O(payments in window).
   */
  trend(nowMs: number, minutes: number): PaymentTrend {
    const bucketMs = 60_000;
    const n = Math.max(1, Math.min(240, Math.floor(minutes)));
    const end = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
    const fromMs = end - n * bucketMs;
    const initiated = new Array<number>(n).fill(0);
    const failed = new Array<number>(n).fill(0);
    let older = 0;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const s = this.records.get(this.order[i]!)?.summary;
      if (!s) continue;
      const t = Date.parse(s.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t < fromMs) {
        // order is by first appearance, which tracks createdAt closely; tolerate a little disorder
        if (++older > 200) break;
        continue;
      }
      if (t >= end) continue;
      const b = Math.floor((t - fromMs) / bucketMs);
      initiated[b] = (initiated[b] ?? 0) + 1;
      if (s.status === 'failed' || s.status === 'rejected') failed[b] = (failed[b] ?? 0) + 1;
    }
    return { bucketMs, fromMs, initiated, failed };
  }

  summary(paymentId: string): PaymentSummary | undefined {
    return this.records.get(paymentId)?.summary;
  }

  state(paymentId: string): PaymentState | undefined {
    return this.records.get(paymentId)?.state;
  }

  /** All payment states (for @ct/market providerHealth). */
  states(): IterableIterator<PaymentState> {
    const it = this.records.values();
    return (function* () {
      for (const r of it) yield r.state;
    })();
  }

  detail(paymentId: string): PaymentDetail | undefined {
    const r = this.records.get(paymentId);
    if (!r) return undefined;
    const d: PaymentDetail = { state: r.state, events: [...r.events] };
    if (r.dropped) d.droppedEvents = r.dropped;
    return d;
  }

  messages(paymentId: string): IsoMessage[] | undefined {
    const r = this.records.get(paymentId);
    if (!r) return undefined;
    const out: IsoMessage[] = [];
    for (const e of r.events) {
      const m = messageOf(e);
      if (m) out.push(m);
    }
    return out;
  }

  stats(): Stats {
    const byStatus = { ...this.byStatus };
    const { held, rejected, reconciled, failed, retrying } = byStatus;
    return {
      total: this.records.size,
      byStatus,
      reconciled,
      inFlight: this.records.size - reconciled - held - rejected - failed,
      held,
      rejected,
      retrying,
      failed,
      retriesTotal: this.retriesTotal,
      reconBreaks: this.reconBreaks,
      reconMatched: this.reconMatched,
      avgEndToEndMs: this.endToEndCount > 0 ? Math.round(this.endToEndSumMs / this.endToEndCount) : null,
      rejectedEvents: this.rejectedTotal,
      events: this.eventCount,
      throughput: this.throughput.read(),
    };
  }

  quoteStats(corridorId: string): QuoteStats {
    const q = this.quotes.get(corridorId);
    if (!q || q.count === 0) return { count: 0, avgSpreadBps: null };
    const out: QuoteStats = { count: q.count, avgSpreadBps: Math.round((q.spreadSum / q.count) * 10) / 10 };
    if (q.last) {
      out.lastRate = q.last.rate;
      if (q.last.mid) out.lastMid = q.last.mid;
      out.lastSpreadBps = q.last.spreadBps;
      out.lastQuotedAt = q.last.at;
    }
    return out;
  }

  /** Statements newest date first, then provider, then currency. */
  statementRefs(): StatementRef[] {
    const out: StatementRef[] = [];
    for (const g of this.statements.values()) {
      out.push({ providerId: g.providerId, date: g.date, currency: g.currency, statementId: g.statementId, entries: g.entries, totalMinor: g.totalMinor });
    }
    return out.sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.providerId !== b.providerId ? a.providerId.localeCompare(b.providerId) : a.currency.localeCompare(b.currency),
    );
  }

  statementGroups(providerId: string, date: string): StatementGroup[] {
    const out: StatementGroup[] = [];
    for (const g of this.statements.values()) if (g.providerId === providerId && g.date === date) out.push(g);
    return out.sort((a, b) => b.entries - a.entries || a.currency.localeCompare(b.currency));
  }

  rejected(): RejectedEvent[] {
    return [...this.rejectedList];
  }
}
