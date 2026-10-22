// risk stage (M1 stub; M2 owners replace the logic, keep the export name).
import { unitHash } from '@ct/contracts';
import type { Step } from './common';

export const riskSteps: Step[] = [
  {
    trigger: 'payment.screened',
    delay: 'stage',
    produce: (_t, state) => {
      const scenario = state.initiated.scenario;
      if (scenario === 'force-hold') {
        return {
          type: 'payment.held',
          payload: { reason: 'Manual review (scenario)', atStage: 'risk' },
          decision: 'hold',
          reasonCodes: ['SCENARIO_FORCE_HOLD'],
          inputs: { scenario },
        };
      }
      const fraudScore = Math.round(unitHash(state.paymentId) * 0.2 * 1000) / 1000;
      return {
        type: 'payment.scored',
        payload: { fraudScore, amlAlerts: [], decision: 'approve' },
        decision: 'approve',
        reasonCodes: ['STUB_PASS', 'SCORE_BELOW_THRESHOLD'],
        inputs: { amount: state.initiated.amount, corridor: state.initiated.corridor, fraudScore, scenario: scenario ?? null },
      };
    },
  },
];
