// routing stage (M1 stub; M2 owners replace the logic, keep the export name).
import { PROVIDERS, unitHash } from '@ct/contracts';
import { bpsFee } from '../fx-math';
import type { Step } from './common';

export const ROUTING_FEE_BPS = 15;
export const ROUTING_FEE_MIN_MINOR = 100;

export const routingSteps: Step[] = [
  {
    trigger: 'payment.quoted',
    delay: 'stage',
    produce: (_t, state) => {
      const init = state.initiated;
      const eligible = PROVIDERS.filter((p) => p.corridors.includes(init.corridor));
      const [chosen, ...others] = eligible;
      if (!chosen) throw new Error(`no provider serves corridor ${init.corridor}`);
      const alternatives = others.map((p) => ({
        providerId: p.id,
        score: Math.round((0.5 + unitHash(`${state.paymentId}|${p.id}`) * 0.4) * 1000) / 1000,
      }));
      const estimatedFee = bpsFee(init.amount, ROUTING_FEE_BPS, ROUTING_FEE_MIN_MINOR);
      return {
        type: 'payment.routed',
        payload: { providerId: chosen.id, rail: chosen.rail, estimatedFee, alternatives },
        decision: chosen.id,
        reasonCodes: ['STUB_PASS', 'FIRST_ELIGIBLE_PROVIDER'],
        inputs: { corridor: init.corridor, eligible: eligible.map((p) => p.id), feeBps: ROUTING_FEE_BPS, feeMinMinor: ROUTING_FEE_MIN_MINOR },
      };
    },
  },
];
