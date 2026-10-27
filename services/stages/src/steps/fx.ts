// fx stage: payment.scored(approve) | payment.released -> payment.quoted, priced by the simulated market
// (@ct/market). The quote is taken at the TRIGGER's occurredAt (not the wall clock), so re-running the step
// for the same trigger (restart, redelivery, replay) yields exactly the same quote.
// M4: a payment released by an operator (payment.released, held -> scored) is quoted at the release time.
// M4: active FX shocks (control.fx_shock.*, ctx.control.fxShocks as of the trigger) are applied through the
// @ct/market shock hook (shocksFromControl); the trace lists them and adds reason code FX_SHOCK_ACTIVE.
import { DEFAULT_SEED, getVolatilityShocks, PRICING_VERSION, QUOTE_TTL_MS as MARKET_QUOTE_TTL_MS, quote, shocksFromControl } from '@ct/market';
import type { AnyEvent, PaymentState } from '@ct/contracts';
import { shortRef, type Outcome, type Step, type StepContext } from './common';

/** M1 flat spread, kept for compatibility. M2 pricing is per corridor + tier + volatility (see @ct/market pricing). */
export const FX_SPREAD_BPS = 35;
export const QUOTE_TTL_MS = MARKET_QUOTE_TTL_MS;
export const FX_RULE_VERSION = PRICING_VERSION;

function priceAt(trigger: AnyEvent, state: PaymentState, ctx: StepContext): Outcome {
  const init = state.initiated;
  const atMs = Date.parse(trigger.occurredAt);
  if (!Number.isFinite(atMs)) throw new Error(`trigger ${trigger.eventId} has no valid occurredAt`);
  const seed = ctx.services.sim?.seed ?? DEFAULT_SEED;
  const controlShocks = Object.values(ctx.control.fxShocks ?? {});
  const shocks = [...getVolatilityShocks(), ...shocksFromControl(ctx.control.fxShocks ?? {})];
  const q = quote({ corridorId: init.corridor, sourceAmount: init.amount, atMs, seed, shocks });
  if (q.targetAmount.currency !== init.targetCurrency) {
    throw new Error(`corridor ${init.corridor} pays ${q.targetAmount.currency}, payment asks for ${init.targetCurrency}`);
  }
  const corridorShocks = controlShocks.filter((s) => s.corridorId === init.corridor);
  const reasonCodes = ['MARKET_MID_RATE', `AMOUNT_TIER_${q.tier.toUpperCase()}`];
  if (q.components.volatilityBps > 0) reasonCodes.push('VOLATILITY_ADD_ON');
  if (corridorShocks.length) reasonCodes.push('FX_SHOCK_ACTIVE');
  if (trigger.type === 'payment.released') reasonCodes.push('RELEASED_BY_OPERATOR');
  reasonCodes.push('SPREAD_APPLIED');
  return {
    type: 'payment.quoted',
    payload: {
      quoteId: `q-${shortRef(state.paymentId, 'fx-quote')}`,
      rate: q.rate,
      midRate: q.midRate,
      rateTimestamp: q.rateTimestamp,
      spreadBps: q.spreadBps,
      sourceAmount: q.sourceAmount,
      targetAmount: q.targetAmount,
      expiresAt: q.expiresAt,
    },
    decision: 'quoted',
    reasonCodes,
    ruleVersion: FX_RULE_VERSION,
    inputs: {
      corridor: q.corridorId,
      seed,
      pricedAt: trigger.occurredAt,
      pricedOn: trigger.type,
      midRate: q.midRate,
      rateTimestamp: q.rateTimestamp,
      amountTier: q.tier,
      spreadComponents: q.components,
      recentRangeBps: q.recentRangeBps,
      spreadBps: q.spreadBps,
      rate: q.rate,
      sourceAmount: q.sourceAmount,
      targetAmount: q.targetAmount,
      ttlMs: QUOTE_TTL_MS,
      ...(corridorShocks.length
        ? {
            fxShocks: corridorShocks.map((s) => ({
              shockId: s.shockId, driftBps: s.driftBps, noiseMultiplier: s.noiseMultiplier, rampMs: s.rampMs, since: s.since, reason: s.reason,
            })),
            shockRule: 'active control.fx_shock moves the mid by up to driftBps (ramped in over rampMs) and multiplies short-horizon noise; the volatility add-on widens the spread',
          }
        : {}),
    },
  };
}

export const fxSteps: Step[] = [
  {
    trigger: 'payment.scored',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.scored' || trigger.payload.decision !== 'approve' || state.status !== 'scored') return null;
      return priceAt(trigger, state, ctx);
    },
  },
  {
    trigger: 'payment.released',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.released' || state.status !== 'scored') return null;
      if (state.history.findLast((h) => h.type === 'payment.released')?.eventId !== trigger.eventId) return null;
      return priceAt(trigger, state, ctx);
    },
  },
];
