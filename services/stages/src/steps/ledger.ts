// ledger stage (M1 stub; M2 owners replace the logic, keep the export name).
import { shortRef, type Step } from './common';

export const ledgerSteps: Step[] = [
  {
    trigger: 'payment.settled',
    delay: 'stage',
    produce: (_t, state) => {
      const quoted = state.facts['payment.quoted'];
      const settled = state.facts['payment.settled'];
      if (!quoted || !settled || state.ledgerPosted) return null;
      const src = quoted.sourceAmount;
      const tgt = quoted.targetAmount;
      return {
        type: 'ledger.posted',
        payload: {
          journalId: `JRN-${shortRef(state.paymentId, 'journal')}`,
          entries: [
            { account: `customer:${state.initiated.debtor.accountId}`, direction: 'debit', amount: src },
            { account: `fx-position:${src.currency}`, direction: 'credit', amount: src },
            { account: `fx-position:${tgt.currency}`, direction: 'debit', amount: tgt },
            { account: `provider:${settled.providerId}:payable`, direction: 'credit', amount: tgt },
          ],
        },
        decision: 'posted',
        reasonCodes: ['STUB_PASS', 'JOURNAL_BALANCED'],
        inputs: { sourceAmount: src, targetAmount: tgt, providerId: settled.providerId },
      };
    },
  },
];
