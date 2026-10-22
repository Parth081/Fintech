// fx stage: payment.scored(approve) -> payment.quoted, priced by the simulated market (@ct/market).
// The quote is taken at the TRIGGER's occurredAt (not the wall clock), so re-running the step for
// the same trigger (restart, redelivery, replay) yields exactly the same quote.
import { DEFAULT_SEED, PRICING_VERSION, QUOTE_TTL_MS as MARKET_QUOTE_TTL_MS, quote } from '@ct/market';
import { shortRef, type Step } from './common';

/** M1 flat spread, kept for compatibility. M2 pricing is per corridor + tier + volatility (see @ct/market pricing). */
export const FX_SPREAD_BPS = 35;
export const QUOTE_TTL_MS = MARKET_QUOTE_TTL_MS;
export const FX_RULE_VERSION = PRICING_VERSION;

export const fxSteps: Step[] = [
  {
    trigger: 'payment.scored',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.scored' || trigger.payload.decision !== 'approve') return null;
      const init = state.initiated;
      const atMs = Date.parse(trigger.occurredAt);
      if (!Number.isFinite(atMs)) throw new Error(`trigger ${trigger.eventId} has no valid occurredAt`);
      const seed = ctx.services.sim?.seed ?? DEFAULT_SEED;
      const q = quote({ corridorId: init.corridor, sourceAmount: init.amount, atMs, seed });
      if (q.targetAmount.currency !== init.targetCurrency) {
        throw new Error(`corridor ${init.corridor} pays ${q.targetAmount.currency}, payment asks for ${init.targetCurrency}`);
      }
      const reasonCodes = ['MARKET_MID_RATE', `AMOUNT_TIER_${q.tier.toUpperCase()}`];
      if (q.components.volatilityBps > 0) reasonCodes.push('VOLATILITY_ADD_ON');
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
        },
      };
    },
  },
];
