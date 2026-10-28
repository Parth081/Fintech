// routing stage: smart routing over the fictional providers (@ct/market scoreProviders).
//   payment.quoted      -> payment.routed attempt 1
//   payment.send_failed -> payment.routed attempt n+1, excluding every provider that already failed
//                          this payment; payment.failed when none is left or attempts would exceed 3.
//
// Determinism / replay: the decision depends only on data that is fixed for the trigger:
// - the payment's own facts (amount, corridor, routing chain) and the trigger payload;
// - provider health from ctx.view.states counting ONLY outcomes that occurred in
//   [T - HEALTH_LAG_MS - HEALTH_WINDOW_MS, T - HEALTH_LAG_MS), T = trigger.occurredAt.
//   Events are stamped right before they are published, and the runner waits until the projection
//   has applied the trigger's offset, so every outcome stamped more than HEALTH_LAG_MS before the
//   trigger is already in the view; later outcomes are ignored, so a re-run after a restart (with
//   a fuller view) computes the same health and the same event.
// - The step only acts while the trigger is current (status 'quoted', or 'retrying' with this
//   send_failed as the latest one); otherwise it returns null (the runner would drop it anyway).
//   This also stops a redelivered payment.quoted from producing a second "attempt 1" while the
//   payment is retrying (routed is a valid transition from 'retrying').
//
// Circuit breakers (M3, @ct/market breaker.ts) use the SAME cut-off as health (outcomes before
// T - HEALTH_LAG_MS), so they are equally replay-stable:
// - open breaker       -> provider excluded (excludedReason CIRCUIT_OPEN), reason code CIRCUIT_OPEN_REROUTED;
//                         inputs.circuitBlocked lists the blocked providers and inputs.withoutBreakers what
//                         the choice would have been without breakers.
// - half-open breaker  -> only payments whose hash selects them as probes may use it, and a probe
//                         payment IS sent to the half-open provider (reason code CIRCUIT_HALF_OPEN_PROBE;
//                         PROBE_OVERRIDES_SCORE when it was not the top score) — otherwise a provider whose
//                         health score is still depressed by the outage would never get the probe that
//                         lets it recover. Other payments see it excluded (CIRCUIT_HALF_OPEN,
//                         reason code CIRCUIT_HALF_OPEN_REROUTED).
// - all-open fallback  -> if the breakers block EVERY otherwise eligible provider, the least-bad class is
//                         re-admitted (half-open before open) and scored normally (reason code
//                         ALL_CIRCUITS_OPEN_FALLBACK). A breaker exists to stop wasting attempts on a sick
//                         provider while a healthier one is available; it never fails a payment by itself.
//                         The 3-attempt limit still bounds the damage.
// - recovery           -> after a breaker closes again (a probe settled), that provider's health counts
//                         only outcomes from the recovery on (reason code RECOVERED_AFTER_OUTAGE when it is
//                         chosen), so the outage's failures do not starve it for the whole health window.
//
// M4 operator configuration (ctx.control.config as of the trigger, so a change applies from its log position on):
// - 'provider.enabled' false        -> excluded with excludedReason PROVIDER_DISABLED (reason code PROVIDER_DISABLED_BY_OPERATOR);
// - 'provider.forcedBreaker' 'open' -> excluded with CIRCUIT_FORCED_OPEN, overriding the automatic breaker
//                                      (reason code CIRCUIT_FORCED_OPEN_REROUTED);
//   neither is ever re-admitted by the all-open fallback; with nothing left the payment fails NO_ELIGIBLE_PROVIDER.
// - 'routing.weights'               -> scoring weights (normalised by scoreProviders); invalid values fall back to defaults.
//
// M4 operator retry (payment.retry_requested, failed -> retrying): routing starts a FRESH attempt budget of
// MAX_ROUTING_ATTEMPTS with no providers excluded. Attempt NUMBERS keep counting across budgets (a payment
// that failed after attempts 1-3 retries with attempt 4, 5, 6), so pacs.008/pacs.002 message ids and
// settlement draws stay unique per attempt. payload.excludedProviders is the full ordered chain of earlier
// attempts' providers (it may repeat a provider after a retry, which is what @ct/market attemptsOf needs to
// attribute every attempt); only providers that failed within the current budget are excluded from scoring.
// payment.failed.attempts is the total number of attempts across all budgets.
import { DEFAULT_CONFIG, type AnyEvent, type PaymentState, type ProviderScore } from '@ct/contracts';
import {
  breakerAdmission,
  breakerDetails,
  DEFAULT_ROUTING_WEIGHTS,
  type RoutingWeights,
  EXCLUDED_CIRCUIT_FORCED_OPEN,
  EXCLUDED_CIRCUIT_HALF_OPEN,
  EXCLUDED_CIRCUIT_OPEN,
  EXCLUDED_PROVIDER_DISABLED,
  PROVIDER_CATALOG,
  providerHealthAll,
  providerProfile,
  scoreProviders,
  type BreakerAdmission,
  type BreakerDetail,
  type ProviderHealth,
} from '@ct/market';
import type { Outcome, Step, StepContext } from './common';

/** M1 flat routing fee, kept for compatibility. M2 fees come from the provider catalogue. */
export const ROUTING_FEE_BPS = 15;
export const ROUTING_FEE_MIN_MINOR = 100;

export const MAX_ROUTING_ATTEMPTS = 3;
export const HEALTH_LAG_MS = 2_000;
export const HEALTH_WINDOW_MS = 15 * 60_000;
export const ROUTING_RULE_VERSION = 'routing-v1';

function healthFor(trigger: AnyEvent, ctx: StepContext) {
  const asOfMs = Date.parse(trigger.occurredAt) - HEALTH_LAG_MS;
  if (!Number.isFinite(asOfMs)) throw new Error(`trigger ${trigger.eventId} has no valid occurredAt`);
  const failureScale = ctx.services.sim?.providerFailureScale ?? 1;
  const health: Record<string, ProviderHealth> = providerHealthAll(ctx.view.states.values(), { asOfMs, windowMs: HEALTH_WINDOW_MS, failureScale });
  const breakers = breakerDetails(ctx.view.states.values(), asOfMs);
  // A provider whose breaker recovered inside the health window starts over from its recovery.
  const resetFrom: Record<string, number> = {};
  for (const b of Object.values(breakers)) {
    if (b.state !== 'closed' || b.recoveredAtMs === null || !(b.recoveredAtMs > asOfMs - HEALTH_WINDOW_MS)) continue;
    const h = providerHealthAll(ctx.view.states.values(), { asOfMs, windowMs: asOfMs - b.recoveredAtMs, failureScale })[b.providerId];
    if (h) {
      health[b.providerId] = h;
      resetFrom[b.providerId] = b.recoveredAtMs;
    }
  }
  return { asOfMs, health, breakers, resetFrom };
}

function isBest(chosen: ProviderScore, eligible: ProviderScore[], key: (s: ProviderScore) => number): boolean {
  const v = key(chosen);
  return eligible.every((s) => key(s) >= v);
}

function failed(state: PaymentState, attempts: number, excluded: string[], code: string, reason: string, inputs: Record<string, unknown>): Outcome {
  return {
    type: 'payment.failed',
    payload: { reason, atStage: 'routing', attempts },
    decision: 'failed',
    reasonCodes: [code],
    ruleVersion: ROUTING_RULE_VERSION,
    inputs: { corridor: state.initiated.corridor, attempts, excludedProviders: excluded, ...inputs },
  };
}

const breakerInput = (b: BreakerDetail, admission: BreakerAdmission) => ({
  state: b.state, since: b.since, failureRate: b.failureRate, attempts: b.attempts, reason: b.reason, admission,
});

/** M4 operator configuration as routing applies it (ctx.control = config as of the trigger). */
function operatorConfig(ctx: StepContext) {
  const config = ctx.control.config ?? DEFAULT_CONFIG;
  const enabled = config['provider.enabled'] ?? {};
  const forced = config['provider.forcedBreaker'] ?? {};
  const w = config['routing.weights'];
  const valid = w && [w.success, w.cost, w.speed].every((x) => Number.isFinite(x) && x >= 0) && w.success + w.cost + w.speed > 0;
  const weights: RoutingWeights = valid ? { success: w.success, cost: w.cost, speed: w.speed } : { ...DEFAULT_ROUTING_WEIGHTS };
  /** Operator exclusions: absolute, never re-admitted by the all-circuits-open fallback. */
  const operator: Record<string, string> = {};
  for (const p of PROVIDER_CATALOG) {
    if (enabled[p.id] === false) operator[p.id] = EXCLUDED_PROVIDER_DISABLED;
    else if (forced[p.id] === 'open') operator[p.id] = EXCLUDED_CIRCUIT_FORCED_OPEN;
  }
  const versions = ctx.control.configVersions ?? {};
  return {
    weights,
    operator,
    inputs: {
      weights,
      weightsSource: versions['routing.weights'] ? `config v${versions['routing.weights']}` : 'default',
      ...(Object.keys(operator).length ? { operatorExclusions: operator } : {}),
      configVersions: {
        'routing.weights': versions['routing.weights'] ?? 0,
        'provider.enabled': versions['provider.enabled'] ?? 0,
        'provider.forcedBreaker': versions['provider.forcedBreaker'] ?? 0,
      },
    },
  };
}

function route(trigger: AnyEvent, state: PaymentState, ctx: StepContext, attempt: number, chain: string[], excluded: string[]): Outcome {
  const init = state.initiated;
  const { asOfMs, health, breakers, resetFrom } = healthFor(trigger, ctx);
  const op = operatorConfig(ctx);
  const base = { corridorId: init.corridor, sourceAmount: init.amount, excluded, health, weights: op.weights };

  // What each breaker means for THIS payment (deterministic per paymentId). Operator settings win.
  const admissions: Record<string, BreakerAdmission> = {};
  const circuit: Record<string, string> = {};
  for (const p of PROVIDER_CATALOG) {
    const b = breakers[p.id];
    const a: BreakerAdmission = b ? breakerAdmission(b, state.paymentId) : 'admit';
    admissions[p.id] = a;
    if (op.operator[p.id]) circuit[p.id] = op.operator[p.id]!;
    else if (a === 'reject-open') circuit[p.id] = EXCLUDED_CIRCUIT_OPEN;
    else if (a === 'reject-half-open') circuit[p.id] = EXCLUDED_CIRCUIT_HALF_OPEN;
  }
  const automatic = Object.keys(circuit).some((id) => !op.operator[id]);
  const unblockedEligible = Object.keys(circuit).length ? scoreProviders({ ...base, circuit: op.operator }).filter((s) => s.eligible) : [];
  let scoring = scoreProviders({ ...base, circuit });
  let eligible = scoring.filter((s) => s.eligible);
  let fallback = false;
  if (eligible.length === 0 && automatic && unblockedEligible.length > 0) {
    // Every eligible provider is blocked by its AUTOMATIC breaker: re-admit the least-bad class (half-open
    // before open). Providers an operator disabled or forced open are never re-admitted.
    const cls = unblockedEligible.some((s) => circuit[s.providerId] === EXCLUDED_CIRCUIT_HALF_OPEN) ? EXCLUDED_CIRCUIT_HALF_OPEN : EXCLUDED_CIRCUIT_OPEN;
    const still: Record<string, string> = {};
    for (const [id, why] of Object.entries(circuit)) if (why !== cls) still[id] = why;
    scoring = scoreProviders({ ...base, circuit: still });
    eligible = scoring.filter((s) => s.eligible);
    fallback = true;
  }

  const healthInputs = Object.fromEntries(
    PROVIDER_CATALOG.map((p) => {
      const h = health[p.id]!;
      return [p.id, { attempts: h.attempts, settled: h.settled, failed: h.failed, successRate: Math.round(h.successRate * 10_000) / 10_000, avgLatencyMs: h.avgLatencyMs }];
    }),
  );
  const breakerInputs = Object.fromEntries(
    PROVIDER_CATALOG.flatMap((p) => (breakers[p.id] ? [[p.id, breakerInput(breakers[p.id]!, admissions[p.id]!)]] : [])),
  );
  const resetInputs = Object.keys(resetFrom).length
    ? { healthResetAfterRecovery: Object.fromEntries(Object.entries(resetFrom).map(([id, ms]) => [id, new Date(ms).toISOString()])) }
    : {};

  // A probe payment goes to the half-open provider (the best-scoring one if several are half-open).
  const probe = eligible.find((s) => admissions[s.providerId] === 'probe');
  const chosen = probe ?? eligible[0];
  if (!chosen) {
    const opBlocked = Object.keys(op.operator).length > 0;
    return failed(state, attempt - 1, chain, 'NO_ELIGIBLE_PROVIDER', `No eligible provider left for ${init.corridor} after ${attempt - 1} failed attempt(s)${opBlocked ? ' (providers disabled or forced open by an operator)' : ''}`, {
      scoring,
      breakers: breakerInputs,
      ...op.inputs,
    });
  }
  const profile = providerProfile(chosen.providerId)!;
  const reasonCodes = [probe && probe !== eligible[0] ? 'PROBE_OVERRIDES_SCORE' : 'BEST_SCORE'];
  if (isBest(chosen, eligible, (s) => s.fee.amountMinor)) reasonCodes.push('LOWEST_FEE');
  if (isBest(chosen, eligible, (s) => -s.successRate)) reasonCodes.push('HIGHEST_SUCCESS');
  if (isBest(chosen, eligible, (s) => s.latencyMs)) reasonCodes.push('FASTEST');
  if (eligible.length === 1) reasonCodes.push('ONLY_ELIGIBLE_PROVIDER');
  if (attempt > 1) reasonCodes.push('RETRY_AFTER_FAILURE');
  if (probe) reasonCodes.push('CIRCUIT_HALF_OPEN_PROBE');
  // Providers the breakers kept this payment away from (corridor served, not failed for this payment).
  const blockedBy = (why: string) => scoring.filter((s) => s.excludedReason === why).map((s) => s.providerId);
  const blockedOpen = blockedBy(EXCLUDED_CIRCUIT_OPEN);
  const blockedHalfOpen = blockedBy(EXCLUDED_CIRCUIT_HALF_OPEN);
  const circuitBlocked = [...blockedOpen, ...blockedHalfOpen];
  if (blockedOpen.length) reasonCodes.push('CIRCUIT_OPEN_REROUTED');
  if (blockedHalfOpen.length) reasonCodes.push('CIRCUIT_HALF_OPEN_REROUTED');
  if (fallback) reasonCodes.push('ALL_CIRCUITS_OPEN_FALLBACK');
  if (resetFrom[chosen.providerId] !== undefined) reasonCodes.push('RECOVERED_AFTER_OUTAGE');
  if (blockedBy(EXCLUDED_PROVIDER_DISABLED).length) reasonCodes.push('PROVIDER_DISABLED_BY_OPERATOR');
  if (blockedBy(EXCLUDED_CIRCUIT_FORCED_OPEN).length) reasonCodes.push('CIRCUIT_FORCED_OPEN_REROUTED');
  if (state.history.some((h) => h.type === 'payment.retry_requested')) reasonCodes.push('OPERATOR_RETRY_BUDGET');
  const withoutBreakers = circuitBlocked.length ? unblockedEligible[0]?.providerId : undefined;

  return {
    type: 'payment.routed',
    payload: {
      providerId: chosen.providerId,
      rail: profile.rail,
      estimatedFee: chosen.fee,
      alternatives: eligible.filter((s) => s !== chosen).map((s) => ({ providerId: s.providerId, score: s.score })),
      attempt,
      excludedProviders: chain,
      scoring,
    },
    decision: chosen.providerId,
    reasonCodes,
    ruleVersion: ROUTING_RULE_VERSION,
    inputs: {
      corridor: init.corridor,
      sourceAmount: init.amount,
      attempt,
      excludedProviders: chain,
      ...(excluded.length !== chain.length ? { excludedThisBudget: excluded } : {}),
      ...op.inputs,
      healthAsOf: new Date(asOfMs).toISOString(),
      healthWindowMs: HEALTH_WINDOW_MS,
      health: healthInputs,
      breakerAsOf: new Date(asOfMs).toISOString(),
      breakers: breakerInputs,
      ...resetInputs,
      ...(circuitBlocked.length ? { circuitBlocked } : {}),
      ...(withoutBreakers !== undefined ? { withoutBreakers } : {}),
      ...(fallback ? { fallbackRule: 'every eligible provider was blocked by its breaker: least-bad class re-admitted (half-open before open)' } : {}),
    },
  };
}

export const routingSteps: Step[] = [
  {
    trigger: 'payment.quoted',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.quoted' || state.status !== 'quoted') return null;
      return route(trigger, state, ctx, 1, [], []);
    },
  },
  {
    trigger: 'payment.send_failed',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.send_failed' || state.status !== 'retrying') return null;
      const lastFailure = state.history.findLast((h) => h.type === 'payment.send_failed');
      if (lastFailure?.eventId !== trigger.eventId) return null; // a newer failure supersedes this trigger
      const prior = state.facts['payment.routed']?.excludedProviders ?? [];
      const chain = [...prior, trigger.payload.providerId]; // every earlier attempt's provider, in order
      const sends = state.history.filter((h) => h.type === 'payment.sent').length;
      const attemptsSoFar = Math.max(trigger.payload.attempt, sends);
      const start = budgetStart(state);
      const excluded = [...new Set(chain.slice(start))];
      const next = attemptsSoFar + 1;
      if (next - start > MAX_ROUTING_ATTEMPTS) {
        return failed(state, attemptsSoFar, chain, 'RETRY_LIMIT_REACHED', `Retry limit reached: ${attemptsSoFar - start} attempts failed (${excluded.join(', ')})`, {
          maxAttempts: MAX_ROUTING_ATTEMPTS,
          ...(start ? { attemptsBeforeOperatorRetry: start, totalAttempts: attemptsSoFar } : {}),
        });
      }
      return route(trigger, state, ctx, next, chain, excluded);
    },
  },
  {
    // M4: an operator retries a failed payment: fresh budget, nothing excluded, attempt numbers continue.
    trigger: 'payment.retry_requested',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.retry_requested' || state.status !== 'retrying') return null;
      if (state.history.at(-1)?.eventId !== trigger.eventId) return null; // already acted on (or superseded)
      const routed = state.facts['payment.routed'];
      const lastFailure = state.facts['payment.send_failed'];
      const chain = [...(routed?.excludedProviders ?? [])];
      if (lastFailure) chain.push(lastFailure.providerId);
      const sends = state.history.filter((h) => h.type === 'payment.sent').length;
      return route(trigger, state, ctx, sends + 1, chain, []);
    },
  },
];

/** Number of attempts (payment.sent) made before the latest operator retry: the current budget starts after them. */
export function budgetStart(state: PaymentState): number {
  let lastRetry = -1;
  state.history.forEach((h, i) => {
    if (h.type === 'payment.retry_requested') lastRetry = i;
  });
  if (lastRetry < 0) return 0;
  return state.history.slice(0, lastRetry).filter((h) => h.type === 'payment.sent').length;
}
