// Client-side state for the live feed. Pure reducer so it can be unit tested.
import type { PaymentStatus } from '@ct/contracts/browser';
import { statusForEvent } from './format';
import type { PaymentSummary, ServerMessage, Stats } from './types';

export const MAX_ROWS = 50;

export interface FeedState {
  payments: PaymentSummary[];
  stats: Stats | null;
  /** Bumped every time a payment enters a stage; used to re-trigger the pulse animation. */
  pulses: Partial<Record<PaymentStatus, number>>;
  /** Most recently changed payment and a sequence number to re-trigger its highlight. */
  lastChanged: { paymentId: string; seq: number } | null;
  seq: number;
}

export const initialFeed: FeedState = { payments: [], stats: null, pulses: {}, lastChanged: null, seq: 0 };

function byNewest(a: PaymentSummary, b: PaymentSummary): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function upsert(list: PaymentSummary[], p: PaymentSummary, max = MAX_ROWS): PaymentSummary[] {
  const i = list.findIndex((x) => x.paymentId === p.paymentId);
  if (i >= 0) {
    const next = list.slice();
    next[i] = p;
    return next;
  }
  return [p, ...list].sort(byNewest).slice(0, max);
}

function pulse(state: FeedState, status: PaymentStatus | null): FeedState['pulses'] {
  if (!status) return state.pulses;
  return { ...state.pulses, [status]: (state.pulses[status] ?? 0) + 1 };
}

export function applyMessage(state: FeedState, msg: ServerMessage): FeedState {
  if (msg.kind === 'snapshot') {
    return { ...state, payments: msg.payments.slice(0, MAX_ROWS), stats: msg.stats };
  }
  const seq = state.seq + 1;
  return {
    payments: upsert(state.payments, msg.payment),
    stats: msg.stats,
    pulses: pulse(state, statusForEvent(msg.event.type)),
    lastChanged: { paymentId: msg.payment.paymentId, seq },
    seq,
  };
}

export function applyMessages(state: FeedState, msgs: ServerMessage[]): FeedState {
  return msgs.reduce(applyMessage, state);
}

/** Polling fallback: replace the list, and pulse/highlight whatever changed since last time. */
export function applyPoll(state: FeedState, payments: PaymentSummary[], stats: Stats): FeedState {
  const before = new Map(state.payments.map((p) => [p.paymentId, p]));
  let next: FeedState = { ...state, payments: payments.slice(0, MAX_ROWS), stats };
  for (const p of [...payments].reverse()) {
    const prev = before.get(p.paymentId);
    if (prev && prev.status === p.status && prev.updatedAt === p.updatedAt) continue;
    if (!prev && state.payments.length === 0) continue; // first load: no animation storm
    const seq = next.seq + 1;
    next = { ...next, pulses: pulse(next, p.status), lastChanged: { paymentId: p.paymentId, seq }, seq };
  }
  return next;
}
