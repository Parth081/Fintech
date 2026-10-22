// fx stage (M1 stub; M2 owners replace the logic, keep the export name).
import { corridorById } from '@ct/contracts';
import { applySpread, convert, formatDecimal } from '../fx-math';
import { shortRef, type Step } from './common';

export const FX_SPREAD_BPS = 35;
export const QUOTE_TTL_MS = 30_000;

export const fxSteps: Step[] = [
  {
    trigger: 'payment.scored',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.scored' || trigger.payload.decision !== 'approve') return null;
      const init = state.initiated;
      const corridor = corridorById(init.corridor);
      if (!corridor) throw new Error(`unknown corridor ${init.corridor}`);
      const rate = applySpread(corridor.midRate, FX_SPREAD_BPS);
      const targetAmount = convert(init.amount, rate, init.targetCurrency);
      const rateStr = formatDecimal(rate);
      return {
        type: 'payment.quoted',
        payload: {
          quoteId: `q-${shortRef(state.paymentId, 'fx-quote')}`,
          rate: rateStr,
          spreadBps: FX_SPREAD_BPS,
          sourceAmount: init.amount,
          targetAmount,
          expiresAt: new Date(Date.parse(ctx.now) + QUOTE_TTL_MS).toISOString(),
        },
        decision: 'quoted',
        reasonCodes: ['STUB_PASS', 'MID_RATE_PLUS_SPREAD'],
        inputs: { corridor: corridor.id, midRate: corridor.midRate, spreadBps: FX_SPREAD_BPS, rate: rateStr, sourceAmount: init.amount },
      };
    },
  },
];
