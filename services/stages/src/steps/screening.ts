// screening stage (M1 stub; M2 owners replace the logic, keep the export name).
import type { Step } from './common';

export const SANCTIONS_LIST_VERSION = 'fictional-sanctions-2026.1';

export const screeningSteps: Step[] = [
  {
    trigger: 'payment.initiated',
    delay: 'stage',
    produce: (_t, state) => ({
      type: 'payment.screened',
      payload: { result: 'clear', listVersion: SANCTIONS_LIST_VERSION },
      decision: 'clear',
      reasonCodes: ['STUB_PASS', 'NO_LIST_MATCH'],
      inputs: {
        debtorName: state.initiated.debtor.name,
        creditorName: state.initiated.creditor.name,
        listVersion: SANCTIONS_LIST_VERSION,
      },
    }),
  },
];
