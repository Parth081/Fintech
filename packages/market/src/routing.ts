// Smart routing: score every catalogue provider for one payment.
//
// Eligibility: the provider has a fee schedule for the corridor (else CORRIDOR_NOT_SERVED), has
// not already failed this payment (else FAILED_THIS_PAYMENT) and is not blocked by its circuit breaker
// (input.circuit: providerId -> CIRCUIT_OPEN | CIRCUIT_HALF_OPEN, decided by the caller; M3).
//
// For eligible providers, each factor is normalised against the best eligible provider (1 = best):
//   success = clamp(1 - (failRate - bestFailRate) / FAILURE_SPAN, 0, 1)   FAILURE_SPAN = 10 points
//   cost    = lowestFee / fee                                             (fee: catalogue schedule)
//   speed   = fastestLatency / latency                                    (expected sent -> settled)
// score = (w.success * success + w.cost * cost + w.speed * speed) / (sum of weights), 4 dp.
// Default weights favour success, then cost, then speed: 0.5 / 0.3 / 0.2.
// Ties (equal rounded score) break on lower fee, then higher success rate, then providerId.
//
// successRate comes from providerHealth (Beta-blended with the catalogue prior); expected latency
// blends the catalogue p50 (weight LATENCY_PRIOR_WEIGHT) with the observed average of settled sends.
import type { Money, ProviderScore } from '@ct/contracts/browser';
import { scheduleFee } from './decimal';
import { PROVIDER_CATALOG, priorSuccessRate } from './catalog';
import type { ProviderHealth } from './health';

export interface RoutingWeights {
  success: number;
  cost: number;
  speed: number;
}

export const DEFAULT_ROUTING_WEIGHTS: Readonly<RoutingWeights> = { success: 0.5, cost: 0.3, speed: 0.2 };
export const FAILURE_SPAN = 0.1;
export const LATENCY_PRIOR_WEIGHT = 5;

export const EXCLUDED_CORRIDOR_NOT_SERVED = 'CORRIDOR_NOT_SERVED';
export const EXCLUDED_FAILED_THIS_PAYMENT = 'FAILED_THIS_PAYMENT';
export const EXCLUDED_CIRCUIT_OPEN = 'CIRCUIT_OPEN';
export const EXCLUDED_CIRCUIT_HALF_OPEN = 'CIRCUIT_HALF_OPEN';

export interface ScoreInput {
  corridorId: string;
  sourceAmount: Money;
  /** Providers that already failed this payment. */
  excluded?: readonly string[];
  /** Providers blocked by their circuit breaker, with the excludedReason to show (M3). */
  circuit?: Readonly<Record<string, string>>;
  /** Observed health by provider id; missing providers use the catalogue prior. */
  health?: Readonly<Record<string, ProviderHealth>>;
  weights?: RoutingWeights;
  /** PROVIDER_FAILURE_SCALE for the prior of providers without health. Default 1. */
  failureScale?: number;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Higher score first; then lower fee, higher success, providerId. */
export function compareScores(a: ProviderScore, b: ProviderScore): number {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (!a.eligible) return 0; // ineligible: keep catalogue order (stable sort)
  return b.score - a.score || a.fee.amountMinor - b.fee.amountMinor || b.successRate - a.successRate || (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0);
}

/** ProviderScore for ALL catalogue providers, best first (ineligible ones last, with excludedReason). */
export function scoreProviders(input: ScoreInput): ProviderScore[] {
  const weights = input.weights ?? DEFAULT_ROUTING_WEIGHTS;
  const wSum = weights.success + weights.cost + weights.speed;
  if (!(wSum > 0)) throw new Error('routing weights must sum to > 0');
  const excluded = new Set(input.excluded ?? []);

  const rows: ProviderScore[] = PROVIDER_CATALOG.map((p) => {
    const schedule = p.fees[input.corridorId];
    const h = input.health?.[p.id];
    const successRate = round4(h ? h.successRate : priorSuccessRate(p, input.failureScale ?? 1));
    const observed = h && h.avgLatencyMs !== null ? h.settled : 0;
    // M3: in the simulation every provider settles after the same artificial delay, so observed latency says
    // nothing real about a provider and let a slow rail (Vega) look as fast as an instant one after absorbing
    // re-routed traffic — Orion then never won its traffic back after an outage. Speed is therefore scored from
    // the catalogue profile; observed latency is still reported by providerHealth for the screens.
    void observed;
    const latencyMs = p.latencyMs.p50;
    const fee = schedule ? scheduleFee(input.sourceAmount, schedule) : { amountMinor: 0, currency: input.sourceAmount.currency };
    const excludedReason = !schedule
      ? EXCLUDED_CORRIDOR_NOT_SERVED
      : excluded.has(p.id)
        ? EXCLUDED_FAILED_THIS_PAYMENT
        : input.circuit?.[p.id];
    const row: ProviderScore = { providerId: p.id, eligible: excludedReason === undefined, fee, successRate, latencyMs, score: 0 };
    if (excludedReason) row.excludedReason = excludedReason;
    return row;
  });

  const eligible = rows.filter((r) => r.eligible);
  if (eligible.length) {
    const minFail = Math.min(...eligible.map((r) => 1 - r.successRate));
    const minFee = Math.min(...eligible.map((r) => r.fee.amountMinor));
    const minLat = Math.min(...eligible.map((r) => r.latencyMs));
    for (const r of eligible) {
      const success = Math.min(1, Math.max(0, 1 - (1 - r.successRate - minFail) / FAILURE_SPAN));
      const cost = r.fee.amountMinor === 0 ? 1 : minFee / r.fee.amountMinor;
      const speed = r.latencyMs === 0 ? 1 : minLat / r.latencyMs;
      r.score = round4((weights.success * success + weights.cost * cost + weights.speed * speed) / wSum);
    }
  }
  return rows.sort(compareScores);
}
