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
import type { AnyEvent, PaymentState, ProviderScore } from '@ct/contracts';
import { DEFAULT_ROUTING_WEIGHTS, PROVIDER_CATALOG, providerHealthAll, providerProfile, scoreProviders } from '@ct/market';
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
  const health = providerHealthAll(ctx.view.states.values(), {
    asOfMs,
    windowMs: HEALTH_WINDOW_MS,
    failureScale: ctx.services.sim?.providerFailureScale ?? 1,
  });
  return { asOfMs, health };
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

function route(trigger: AnyEvent, state: PaymentState, ctx: StepContext, attempt: number, excluded: string[]): Outcome {
  const init = state.initiated;
  const { asOfMs, health } = healthFor(trigger, ctx);
  const scoring = scoreProviders({ corridorId: init.corridor, sourceAmount: init.amount, excluded, health, weights: DEFAULT_ROUTING_WEIGHTS });
  const eligible = scoring.filter((s) => s.eligible);
  const healthInputs = Object.fromEntries(
    PROVIDER_CATALOG.map((p) => {
      const h = health[p.id]!;
      return [p.id, { attempts: h.attempts, settled: h.settled, failed: h.failed, successRate: Math.round(h.successRate * 10_000) / 10_000, avgLatencyMs: h.avgLatencyMs }];
    }),
  );
  const chosen = eligible[0];
  if (!chosen) {
    return failed(state, attempt - 1, excluded, 'NO_ELIGIBLE_PROVIDER', `No eligible provider left for ${init.corridor} after ${attempt - 1} failed attempt(s)`, {
      scoring,
    });
  }
  const profile = providerProfile(chosen.providerId)!;
  const reasonCodes = ['BEST_SCORE'];
  if (isBest(chosen, eligible, (s) => s.fee.amountMinor)) reasonCodes.push('LOWEST_FEE');
  if (isBest(chosen, eligible, (s) => -s.successRate)) reasonCodes.push('HIGHEST_SUCCESS');
  if (isBest(chosen, eligible, (s) => s.latencyMs)) reasonCodes.push('FASTEST');
  if (eligible.length === 1) reasonCodes.push('ONLY_ELIGIBLE_PROVIDER');
  if (attempt > 1) reasonCodes.push('RETRY_AFTER_FAILURE');
  return {
    type: 'payment.routed',
    payload: {
      providerId: chosen.providerId,
      rail: profile.rail,
      estimatedFee: chosen.fee,
      alternatives: eligible.slice(1).map((s) => ({ providerId: s.providerId, score: s.score })),
      attempt,
      excludedProviders: excluded,
      scoring,
    },
    decision: chosen.providerId,
    reasonCodes,
    ruleVersion: ROUTING_RULE_VERSION,
    inputs: {
      corridor: init.corridor,
      sourceAmount: init.amount,
      attempt,
      excludedProviders: excluded,
      weights: DEFAULT_ROUTING_WEIGHTS,
      healthAsOf: new Date(asOfMs).toISOString(),
      healthWindowMs: HEALTH_WINDOW_MS,
      health: healthInputs,
    },
  };
}

export const routingSteps: Step[] = [
  {
    trigger: 'payment.quoted',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.quoted' || state.status !== 'quoted') return null;
      return route(trigger, state, ctx, 1, []);
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
      const excluded = [...new Set([...prior, trigger.payload.providerId])];
      const sends = state.history.filter((h) => h.type === 'payment.sent').length;
      const attemptsSoFar = Math.max(trigger.payload.attempt, sends);
      const next = attemptsSoFar + 1;
      if (next > MAX_ROUTING_ATTEMPTS) {
        return failed(state, attemptsSoFar, excluded, 'RETRY_LIMIT_REACHED', `Retry limit reached: ${attemptsSoFar} attempts failed (${excluded.join(', ')})`, {
          maxAttempts: MAX_ROUTING_ATTEMPTS,
        });
      }
      return route(trigger, state, ctx, next, excluded);
    },
  },
];
