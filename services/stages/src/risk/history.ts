// Payment history the risk engine may look at: payments initiated BEFORE the trigger.
//
// "Before" is defined by log position, not wall clock: a payment counts only if its payment.initiated event
// sits at a lower log offset than the anchor event (the payment.screened that started the risk decision).
// The runner waits until its projection has applied the trigger's offset, so every such payment is in the
// view, and later payments are filtered out: a restart or replay (with a fuller view) sees exactly the same
// history. Without offsets (hand-built unit-test contexts) it falls back to createdAt < anchor time.
import { exponentOf, type Money, type PaymentState } from '@ct/contracts';

/**
 * Reference USD rates used ONLY to put amounts on one scale for risk features and thresholds
 * ('risk.manualReviewAboveUsd'). Pricing never uses these (FX quotes come from @ct/market).
 */
export const USD_REFERENCE_RATES: Readonly<Record<string, number>> = {
  USD: 1, EUR: 1.08, GBP: 1.27, INR: 0.012, BRL: 0.18, PHP: 0.0175, JPY: 0.0067,
};

export function majorUnits(m: Money): number {
  return m.amountMinor / 10 ** exponentOf(m.currency);
}

/** USD-equivalent major units (2 dp) of an amount. Unknown currencies count 1:1. */
export function toUsd(m: Money): number {
  return Math.round(majorUnits(m) * (USD_REFERENCE_RATES[m.currency] ?? 1) * 100) / 100;
}

export interface PaymentRecord {
  paymentId: string;
  atMs: number; // payment.initiated occurredAt
  debtorAccount: string;
  creditorAccount: string;
  debtorName: string;
  creditorName: string;
  corridor: string;
  amount: Money;
  usd: number;
  /** Source-currency major units (local reporting thresholds are per currency). */
  major: number;
}

export function recordOf(state: PaymentState): PaymentRecord {
  const i = state.initiated;
  return {
    paymentId: state.paymentId,
    atMs: Date.parse(state.createdAt),
    debtorAccount: i.debtor.accountId,
    creditorAccount: i.creditor.accountId,
    debtorName: i.debtor.name,
    creditorName: i.creditor.name,
    corridor: i.corridor,
    amount: i.amount,
    usd: toUsd(i.amount),
    major: majorUnits(i.amount),
  };
}

/**
 * Every fraud feature and AML typology only looks at payments from the same debtor, to the same creditor, or
 * TO the debtor (rapid in-out). Filtering on that first gives identical results at a fraction of the cost.
 */
export function isRelevant(debtorAccount: string, creditorAccount: string, to: { debtorAccount: string; creditorAccount: string }): boolean {
  return debtorAccount === to.debtorAccount || creditorAccount === to.creditorAccount || creditorAccount === to.debtorAccount;
}

/** How far back history features look at all (the longest typology window is 24 h). */
export const HISTORY_LOOKBACK_MS = 24 * 3_600_000;

export interface HistoryAnchor {
  /** Log offset of the anchor event; payments whose initiated offset is lower count. */
  offset?: number;
  /** Anchor time (the anchor event's occurredAt) for the time windows. */
  atMs: number;
}

/**
 * Payments before the anchor (excluding `selfId`), oldest first, within HISTORY_LOOKBACK_MS of it.
 * Sorted by (time, paymentId) so feature order is deterministic.
 */
export function historyBefore(
  states: Iterable<PaymentState>,
  selfId: string,
  anchor: HistoryAnchor,
  offsetOf?: (eventId: string) => number | undefined,
  /** Only keep payments that share an account with this party pair (all any feature looks at). */
  relevantTo?: { debtorAccount: string; creditorAccount: string },
): PaymentRecord[] {
  const out: PaymentRecord[] = [];
  const from = anchor.atMs - HISTORY_LOOKBACK_MS;
  for (const s of states) {
    if (s.paymentId === selfId) continue;
    if (relevantTo && !isRelevant(s.initiated.debtor.accountId, s.initiated.creditor.accountId, relevantTo)) continue;
    const initiatedId = s.history[0]?.eventId;
    if (!initiatedId) continue;
    if (anchor.offset !== undefined && offsetOf) {
      const off = offsetOf(initiatedId);
      if (off === undefined || off >= anchor.offset) continue;
    } else if (!(Date.parse(s.createdAt) < anchor.atMs)) continue;
    const at = Date.parse(s.createdAt);
    if (!(at >= from)) continue;
    out.push(recordOf(s));
  }
  return out.sort((a, b) => a.atMs - b.atMs || (a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0));
}
