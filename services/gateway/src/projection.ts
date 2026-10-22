// Read-side projection: folds the event log into payment states, per-payment event lists and
// diagnostics. Pure in-memory; rebuilt from the earliest offset on every start.
import { applyEvent, PIPELINE, type AnyEvent, type Money, type PaymentState, type PaymentStatus } from '@ct/contracts';
import type { PaymentDetail, PaymentSummary, RejectedEvent, Stats } from './api-types';

const ALL_STATUSES: readonly PaymentStatus[] = [...PIPELINE, 'held', 'rejected'];
const MAX_REJECTED = 500;

export type ApplyResult =
  | { kind: 'applied'; event: AnyEvent; state: PaymentState }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; error: string };

export function summarize(state: PaymentState): PaymentSummary {
  const quoted = state.facts['payment.quoted'];
  const routed = state.facts['payment.routed'];
  const held = state.facts['payment.held'];
  const rejected = state.facts['payment.rejected'];
  let lastPipelineIndex = -1;
  for (const h of state.history) lastPipelineIndex = Math.max(lastPipelineIndex, PIPELINE.indexOf(h.status));
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
  };
  const target: Money | undefined = quoted?.targetAmount;
  if (target) summary.targetAmount = target;
  if (routed) summary.providerId = routed.providerId;
  if (state.initiated.scenario) summary.scenario = state.initiated.scenario;
  const reason = held?.reason ?? rejected?.reason;
  if (reason) summary.reason = reason;
  if (state.status === 'reconciled') {
    const ms = Date.parse(state.updatedAt) - Date.parse(state.createdAt);
    if (Number.isFinite(ms)) summary.endToEndMs = ms;
  }
  return summary;
}

export class Projection {
  private readonly states = new Map<string, PaymentState>();
  private readonly eventsById = new Map<string, AnyEvent[]>();
  /** Payment ids in first-seen (log) order. */
  private readonly order: string[] = [];
  private readonly rejectedList: RejectedEvent[] = [];
  private rejectedTotal = 0;
  private eventCount = 0;
  private reconciledCount = 0;
  private endToEndSumMs = 0;

  apply(event: AnyEvent): ApplyResult {
    const paymentId = typeof event?.paymentId === 'string' ? event.paymentId : '';
    const prev = paymentId ? this.states.get(paymentId) : undefined;
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

    if (!prev) this.order.push(paymentId);
    this.states.set(paymentId, next);
    const list = this.eventsById.get(paymentId) ?? [];
    list.push(event);
    this.eventsById.set(paymentId, list);
    this.eventCount += 1;
    if (next.status === 'reconciled' && prev?.status !== 'reconciled') {
      this.reconciledCount += 1;
      const ms = Date.parse(next.updatedAt) - Date.parse(next.createdAt);
      if (Number.isFinite(ms)) this.endToEndSumMs += ms;
    }
    return { kind: 'applied', event, state: next };
  }

  get paymentCount(): number {
    return this.states.size;
  }

  get totalEvents(): number {
    return this.eventCount;
  }

  /** Newest first (by first appearance in the log). */
  summaries(limit = 50): PaymentSummary[] {
    const out: PaymentSummary[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const state = this.states.get(this.order[i]!);
      if (state) out.push(summarize(state));
    }
    return out;
  }

  summary(paymentId: string): PaymentSummary | undefined {
    const state = this.states.get(paymentId);
    return state ? summarize(state) : undefined;
  }

  detail(paymentId: string): PaymentDetail | undefined {
    const state = this.states.get(paymentId);
    if (!state) return undefined;
    return { state, events: [...(this.eventsById.get(paymentId) ?? [])] };
  }

  stats(): Stats {
    const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<PaymentStatus, number>;
    for (const s of this.states.values()) byStatus[s.status] += 1;
    const held = byStatus.held;
    const rejected = byStatus.rejected;
    const reconciled = byStatus.reconciled;
    return {
      total: this.states.size,
      byStatus,
      reconciled,
      inFlight: this.states.size - reconciled - held - rejected,
      held,
      rejected,
      avgEndToEndMs: this.reconciledCount > 0 ? Math.round(this.endToEndSumMs / this.reconciledCount) : null,
      rejectedEvents: this.rejectedTotal,
    };
  }

  rejected(): RejectedEvent[] {
    return [...this.rejectedList];
  }
}
