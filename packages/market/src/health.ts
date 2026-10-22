// Observed provider health, derived from projected payment states.
//
// Each payment.sent in a payment's history is one attempt. Its provider is recovered from the
// routing chain: payment.routed.excludedProviders (providers that already failed, in order) +
// the latest payment.send_failed provider + the current payment.routed provider. The attempt's
// outcome is the next payment.send_failed (failed) or payment.settled (settled) in history.
//
// successRate = Beta-binomial posterior mean with the catalogue success rate as prior:
//   (settled + w * prior) / (settled + failed + w),  w = HEALTH_PRIOR_WEIGHT (50 pseudo-outcomes)
// so a handful of failures moves it a little and a sustained incident moves it a lot.
//
// Time filter (options.asOfMs / windowMs): only outcomes with asOf - window <= outcomeAt < asOf
// count; attempts sent before asOf without an outcome by then are in flight. Routing passes
// asOf = trigger time - lag so the result is stable for that trigger (see routing step).
//
// Cost: O(payments) per call. Attempt extraction (history walk + Date.parse) is cached per state
// object in a WeakMap (states are immutable; a changed payment is a new object), so a call is one
// pass over the map with a few comparisons per payment.
import type { PaymentState } from '@ct/contracts/browser';
import { PROVIDER_CATALOG, priorSuccessRate, providerProfile } from './catalog';

export const HEALTH_PRIOR_WEIGHT = 50;

export interface ProviderHealth {
  providerId: string;
  attempts: number;
  settled: number;
  failed: number;
  successRate: number; // observed, blended with the catalogue prior
  avgLatencyMs: number | null; // sent -> settled, observed
}

export interface HealthOptions {
  /** Count only outcomes strictly before this time (ms). Default: everything. */
  asOfMs?: number;
  /** Count only outcomes within this long before asOfMs. Default: unlimited. */
  windowMs?: number;
  /** PROVIDER_FAILURE_SCALE applied to the catalogue prior. Default 1. */
  failureScale?: number;
  priorWeight?: number;
}

export interface AttemptRecord {
  providerId: string;
  sentAtMs: number;
  outcome: 'settled' | 'failed' | null;
  outcomeAtMs: number | null;
}

const NONE: readonly AttemptRecord[] = [];
const attemptCache = new WeakMap<PaymentState, readonly AttemptRecord[]>();

/** Provider attempts of one payment, in order (cached per state object). */
export function attemptsOf(state: PaymentState): readonly AttemptRecord[] {
  const sent = state.facts['payment.sent'];
  if (!sent) return NONE;
  const cached = attemptCache.get(state);
  if (cached) return cached;
  const routed = state.facts['payment.routed'];
  const failed = state.facts['payment.send_failed'];
  const chain = [...(routed?.excludedProviders ?? [])];
  if (failed && !chain.includes(failed.providerId)) chain.push(failed.providerId);
  if (routed && !chain.includes(routed.providerId)) chain.push(routed.providerId);
  const out: AttemptRecord[] = [];
  let current: AttemptRecord | undefined;
  for (const h of state.history) {
    if (h.type === 'payment.sent') {
      current = { providerId: chain[out.length] ?? sent.providerId, sentAtMs: Date.parse(h.occurredAt), outcome: null, outcomeAtMs: null };
      out.push(current);
    } else if ((h.type === 'payment.send_failed' || h.type === 'payment.settled') && current && current.outcome === null) {
      current.outcome = h.type === 'payment.settled' ? 'settled' : 'failed';
      current.outcomeAtMs = Date.parse(h.occurredAt);
    }
  }
  attemptCache.set(state, out);
  return out;
}

interface Acc {
  settled: number;
  failed: number;
  inFlight: number;
  latencySum: number;
  latencyN: number;
}

function finish(providerId: string, a: Acc, opts: HealthOptions): ProviderHealth {
  const profile = providerProfile(providerId);
  const w = opts.priorWeight ?? HEALTH_PRIOR_WEIGHT;
  const prior = profile ? priorSuccessRate(profile, opts.failureScale ?? 1) : 0.5;
  const n = a.settled + a.failed;
  return {
    providerId,
    attempts: n + a.inFlight,
    settled: a.settled,
    failed: a.failed,
    successRate: (a.settled + w * prior) / (n + w),
    avgLatencyMs: a.latencyN ? Math.round(a.latencySum / a.latencyN) : null,
  };
}

/** Health of every catalogue provider (plus any other provider seen) in one pass. */
export function providerHealthAll(states: Iterable<PaymentState>, opts: HealthOptions = {}): Record<string, ProviderHealth> {
  const asOf = opts.asOfMs ?? Number.POSITIVE_INFINITY;
  const from = opts.windowMs === undefined ? Number.NEGATIVE_INFINITY : asOf - opts.windowMs;
  const acc = new Map<string, Acc>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { settled: 0, failed: 0, inFlight: 0, latencySum: 0, latencyN: 0 }));
    return a;
  };
  for (const p of PROVIDER_CATALOG) get(p.id);
  for (const state of states) {
    const attempts = attemptsOf(state);
    for (let i = 0; i < attempts.length; i++) {
      const r = attempts[i]!;
      if (!(r.sentAtMs < asOf)) continue;
      if (r.outcome !== null && r.outcomeAtMs! < asOf) {
        if (r.outcomeAtMs! < from) continue;
        const a = get(r.providerId);
        if (r.outcome === 'settled') {
          a.settled++;
          a.latencySum += r.outcomeAtMs! - r.sentAtMs;
          a.latencyN++;
        } else a.failed++;
      } else if (r.sentAtMs >= from) get(r.providerId).inFlight++;
    }
  }
  const out: Record<string, ProviderHealth> = {};
  for (const [id, a] of acc) out[id] = finish(id, a, opts);
  return out;
}

/** Observed provider health from projected payment states. */
export function providerHealth(states: Iterable<PaymentState>, providerId: string, opts: HealthOptions = {}): ProviderHealth {
  return providerHealthAll(states, opts)[providerId] ?? finish(providerId, { settled: 0, failed: 0, inFlight: 0, latencySum: 0, latencyN: 0 }, opts);
}
