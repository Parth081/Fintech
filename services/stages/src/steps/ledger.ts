// ledger stage: payment.settled -> ledger.posted. The journal itself is written by the injected
// ledger store (services/ledger), which is idempotent on the causing event id, so a redelivered
// trigger returns the same journal and never posts money twice.
import type { Step } from './common';

export const ledgerSteps: Step[] = [
  {
    trigger: 'payment.settled',
    delay: 'stage',
    produce: async (trigger, state, ctx) => {
      const quoted = state.facts['payment.quoted'];
      const settled = state.facts['payment.settled'];
      if (!quoted || !settled || state.ledgerPosted) return null;
      const ledger = ctx.services.ledger;
      if (!ledger) {
        throw new Error('ledger stage: services.ledger is not configured (inject a ledger store, e.g. createInMemoryLedger() from @ct/ledger)');
      }
      const routed = state.facts['payment.routed'];
      const { journalId, entries } = await ledger.postSettlement({
        paymentId: state.paymentId,
        causationEventId: trigger.eventId,
        state,
      });
      return {
        type: 'ledger.posted',
        payload: { journalId, entries },
        decision: 'posted',
        reasonCodes: ['JOURNAL_BALANCED', 'IDEMPOTENT_ON_CAUSATION'],
        inputs: {
          sourceAmount: quoted.sourceAmount,
          targetAmount: quoted.targetAmount,
          fee: routed?.estimatedFee,
          providerId: settled.providerId,
          causationEventId: trigger.eventId,
        },
        ruleVersion: 'ledger-v1',
      };
    },
  },
];
