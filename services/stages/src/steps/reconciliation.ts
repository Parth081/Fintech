// reconciliation stage (M1 stub; M2 owners replace the logic, keep the export name).
import { shortRef, type Step } from './common';

export const reconciliationSteps: Step[] = [
  {
    trigger: 'ledger.posted',
    delay: 'stage',
    produce: (_t, state) => {
      const settled = state.facts['payment.settled'];
      const posted = state.facts['ledger.posted'];
      if (!settled || !posted) return null;
      const day = state.updatedAt.slice(0, 10).replace(/-/g, '');
      return {
        type: 'payment.reconciled',
        payload: { statementRef: `camt.053-${day}-${shortRef(state.paymentId, 'statement')}`, matched: true },
        decision: 'matched',
        reasonCodes: ['STUB_PASS', 'STATEMENT_MATCHED'],
        inputs: { settlementRef: settled.settlementRef, journalId: posted.journalId },
      };
    },
  },
];
