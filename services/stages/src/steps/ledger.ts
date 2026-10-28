// ledger stage:
//   payment.settled          -> ledger.posted    (settlement journal)
//   payment.refund_requested -> payment.refunded (M4: refund journal = exact reversal of the settlement journal)
// Journals are written by the injected ledger store (services/ledger), idempotent on the causing event id
// (and, for settlement and refund, at most one journal per payment), so a redelivered trigger returns the
// same journal and never posts money twice.
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
  {
    trigger: 'payment.refund_requested',
    delay: 'stage',
    produce: async (trigger, state, ctx) => {
      if (trigger.type !== 'payment.refund_requested' || state.status !== 'refund_requested' || !state.ledgerPosted) return null;
      const ledger = ctx.services.ledger;
      if (!ledger?.postRefund) {
        throw new Error('ledger stage: services.ledger.postRefund is not configured (inject a ledger store, e.g. createInMemoryLedger() from @ct/ledger)');
      }
      const settlementJournalId = state.facts['ledger.posted']?.journalId ?? null;
      const { journalId, entries } = await ledger.postRefund({ paymentId: state.paymentId, causationEventId: trigger.eventId, state });
      return {
        type: 'payment.refunded',
        payload: { journalId, entries },
        decision: 'refunded',
        reasonCodes: ['REVERSAL_JOURNAL_POSTED', 'JOURNAL_BALANCED', 'FEE_REFUNDED', 'IDEMPOTENT_PER_PAYMENT'],
        inputs: {
          reversesJournalId: settlementJournalId,
          requestedBy: trigger.payload.actor.userId,
          approvedBy: trigger.payload.approvedBy?.userId ?? null,
          reason: trigger.payload.reason,
          feePolicy: 'full reversal: amount and transfer fee are refunded; FX unwound at the original quoted rate',
          causationEventId: trigger.eventId,
        },
        ruleVersion: 'ledger-v1',
      };
    },
  },
];
