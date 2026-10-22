// Client-side state for the live feed. Pure reducer so it can be unit tested.
// The gateway coalesces bursts: an `update` carries the latest summary of each changed payment,
// per-event-type counts and fresh stats. The client keeps only the newest MAX_ROWS payments; the
// table pages through older ones over REST, so 10k+ payments never live in React state.
import type { EventType, PaymentStatus } from '@ct/contracts/browser';
import { statusForEvent } from './format';
import type { PaymentSummary, ServerMessage, Stats } from './types';

export const MAX_ROWS = 100;

export interface FeedState {
  payments: PaymentSummary[];
  stats: Stats | null;
  /** Bumped every time payments enter a stage; used to re-trigger the pulse animation. */
  pulses: Partial<Record<PaymentStatus, number>>;
  /** Most recently changed payment and a sequence number to re-trigger its highlight. */
  lastChanged: { paymentId: string; seq: number } | null;
  /** Payment ids changed by the last applied message (drawer refresh). */
  lastBatch: string[];
  seq: number;
}

export const initialFeed: FeedState = { payments: [], stats: null, pulses: {}, lastChanged: null, lastBatch: [], seq: 0 };

/** ISO-8601 UTC strings sort lexicographically. Newest first, ties by id for stability. */
function byNewest(a: PaymentSummary, b: PaymentSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.paymentId < b.paymentId ? 1 : a.paymentId > b.paymentId ? -1 : 0;
}

/** Merge changed payments into the newest-first list, keeping at most `max`. */
export function mergePayments(list: PaymentSummary[], changed: PaymentSummary[], max = MAX_ROWS): PaymentSummary[] {
  if (changed.length === 0) return list;
  const byId = new Map(list.map((p) => [p.paymentId, p] as const));
  let added = false;
  for (const p of changed) {
    if (!byId.has(p.paymentId)) added = true;
    byId.set(p.paymentId, p);
  }
  if (!added) return list.map((p) => byId.get(p.paymentId) ?? p);
  return [...byId.values()].sort(byNewest).slice(0, max);
}

export function upsert(list: PaymentSummary[], p: PaymentSummary, max = MAX_ROWS): PaymentSummary[] {
  return mergePayments(list, [p], max);
}

function addPulses(
  pulses: FeedState['pulses'],
  counts: Partial<Record<EventType, number>>,
): FeedState['pulses'] {
  let next = pulses;
  for (const [type, n] of Object.entries(counts)) {
    const s = statusForEvent(type);
    if (!s || !n) continue;
    if (next === pulses) next = { ...pulses };
    next[s] = (next[s] ?? 0) + 1;
  }
  return next;
}

export function applyMessage(state: FeedState, msg: ServerMessage): FeedState {
  if (msg.kind === 'snapshot') {
    return { ...state, payments: [...msg.payments].sort(byNewest).slice(0, MAX_ROWS), stats: msg.stats, lastBatch: [] };
  }
  if (msg.kind === 'stats') return { ...state, stats: msg.stats };
  const seq = state.seq + 1;
  const last = msg.payments.at(-1);
  return {
    payments: mergePayments(state.payments, msg.payments),
    stats: msg.stats,
    pulses: addPulses(state.pulses, msg.counts),
    lastChanged: last ? { paymentId: last.paymentId, seq } : state.lastChanged,
    lastBatch: msg.payments.map((p) => p.paymentId),
    seq,
  };
}

export function applyMessages(state: FeedState, msgs: ServerMessage[]): FeedState {
  return msgs.reduce(applyMessage, state);
}

/** Polling fallback: replace the list, and pulse/highlight whatever changed since last time. */
export function applyPoll(state: FeedState, payments: PaymentSummary[], stats: Stats): FeedState {
  const before = new Map(state.payments.map((p) => [p.paymentId, p]));
  let next: FeedState = { ...state, payments: payments.slice(0, MAX_ROWS), stats, lastBatch: [] };
  const changed: string[] = [];
  for (const p of [...payments].reverse()) {
    const prev = before.get(p.paymentId);
    if (prev && prev.status === p.status && prev.updatedAt === p.updatedAt) continue;
    if (!prev && state.payments.length === 0) continue; // first load: no animation storm
    changed.push(p.paymentId);
    const seq = next.seq + 1;
    next = { ...next, pulses: { ...next.pulses, [p.status]: (next.pulses[p.status] ?? 0) + 1 }, lastChanged: { paymentId: p.paymentId, seq }, seq };
  }
  return { ...next, lastBatch: changed };
}
