// settlement stage (M1 stub; M2 owners replace the logic, keep the export name).
import { shortRef, type Step } from './common';

export const settlementSteps: Step[] = [
  {
    trigger: 'payment.routed',
    delay: 'stage',
    produce: (_t, state) => {
      const routed = state.facts['payment.routed'];
      if (!routed) return null;
      return {
        type: 'payment.sent',
        payload: { providerId: routed.providerId, messageType: 'pacs.008', messageId: `MSG-${shortRef(state.paymentId, 'pacs.008')}` },
        decision: 'sent',
        reasonCodes: ['STUB_PASS', 'INSTRUCTION_SUBMITTED'],
        inputs: { providerId: routed.providerId, rail: routed.rail },
      };
    },
  },
  {
    trigger: 'payment.sent',
    delay: 'settlement',
    produce: (_t, state) => {
      const sent = state.facts['payment.sent'];
      if (!sent) return null;
      return {
        type: 'payment.settled',
        payload: { providerId: sent.providerId, settlementRef: `STL-${shortRef(state.paymentId, 'settlement')}`, statusMessage: 'pacs.002' },
        decision: 'settled',
        reasonCodes: ['STUB_PASS', 'PROVIDER_CONFIRMED'],
        inputs: { providerId: sent.providerId, messageId: sent.messageId },
      };
    },
  },
];
