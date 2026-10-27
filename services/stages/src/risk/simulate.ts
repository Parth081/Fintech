// Offline simulation of the decision engine over a stream of payment requests (calibration and tests).
// Each payment is decided against the payments before it, exactly as the risk stage does on the log.
import { applyEvent, type AnyEvent, type ConfigValues, type Money, type Party } from '@ct/contracts';
import { assessRisk, type RiskPlan } from './decision';
import { recordOf, type PaymentRecord } from './history';

export interface SimRequest {
  amount: Money;
  targetCurrency: string;
  corridor: string;
  debtor: Party;
  creditor: Party;
  scenario?: string;
}

export interface SimResult {
  decisions: RiskPlan['decision'][];
  plans: RiskPlan[];
  summary: { payments: number; approve: number; hold: number; reject: number; holdRate: number; rejectRate: number; byRule: Record<string, number> };
}

export function simulateTraffic(
  requests: readonly SimRequest[],
  opts: { startMs: number; ratePerSec: number; config: Pick<ConfigValues, 'risk.thresholds' | 'risk.manualReviewAboveUsd'> },
): SimResult {
  const byDebtor = new Map<string, PaymentRecord[]>();
  const byCreditor = new Map<string, PaymentRecord[]>();
  const push = (m: Map<string, PaymentRecord[]>, k: string, r: PaymentRecord) => {
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  };
  const plans: RiskPlan[] = [];
  const byRule: Record<string, number> = {};
  requests.forEach((req, i) => {
    const atMs = opts.startMs + Math.round((i * 1000) / opts.ratePerSec);
    const id = `sim-${i}`;
    const event = {
      eventId: `${id}-init`, type: 'payment.initiated', schemaVersion: 1, paymentId: id, occurredAt: new Date(atMs).toISOString(),
      correlationId: id, causationId: null, producer: 'payment-api', payload: { ...req, idempotencyKey: id },
    } as AnyEvent;
    const state = applyEvent(undefined, event);
    // Same relevance rule as the risk stage (history.ts isRelevant): same debtor, same creditor, or paid to the debtor.
    const d = req.debtor.accountId;
    const c = req.creditor.accountId;
    const related = new Map<string, PaymentRecord>();
    for (const r of [...(byDebtor.get(d) ?? []), ...(byCreditor.get(c) ?? []), ...(byCreditor.get(d) ?? [])]) related.set(r.paymentId, r);
    const lookback = [...related.values()].filter((h) => h.atMs > atMs - 24 * 3_600_000).sort((a, b) => a.atMs - b.atMs);
    const plan = assessRisk({ state, history: lookback, atMs: atMs + 400, config: opts.config });
    plans.push(plan);
    if (plan.decision !== 'approve') for (const code of plan.reasonCodes) byRule[code] = (byRule[code] ?? 0) + 1;
    const r = recordOf(state);
    push(byDebtor, d, r);
    push(byCreditor, c, r);
  });
  const decisions = plans.map((p) => p.decision);
  const n = decisions.length;
  const hold = decisions.filter((d) => d === 'hold').length;
  const reject = decisions.filter((d) => d === 'reject').length;
  return {
    decisions,
    plans,
    summary: { payments: n, approve: n - hold - reject, hold, reject, holdRate: Math.round((hold / n) * 10_000) / 10_000, rejectRate: Math.round((reject / n) * 10_000) / 10_000, byRule },
  };
}
