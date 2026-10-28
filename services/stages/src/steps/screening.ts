// screening stage (M4): fuzzy sanctions screening of debtor and creditor against the FICTIONAL CONSOLIDATED
// LIST (risk/sanctions-list.ts, matching in risk/matching.ts). One outcome per trigger:
//   payment.initiated              -> payment.screened { result: 'clear' }                     (no potential match)
//                                  -> risk.alert_raised { kind: 'sanctions', ... }             (potential match)
//   risk.alert_raised (sanctions,  -> payment.screened { result: 'hit' }  (the risk stage then always holds)
//     producer screening)
// Screening is a pure function of the two names and the list version, so re-running it is deterministic.
import { SANCTIONS_LIST_VERSION, screenParties, sanctionsAlert, type ScreeningResult } from '../risk';
import type { Outcome, Step } from './common';

export { SANCTIONS_LIST_VERSION };
export const SCREENING_RULE_VERSION = 'screening-fuzzy-v1';

function traceInputs(s: ScreeningResult, debtorName: string, creditorName: string): Record<string, unknown> {
  return {
    debtorName,
    creditorName,
    listName: s.listName,
    listVersion: s.listVersion,
    algorithm: s.algorithm,
    threshold: s.threshold,
    score: s.score,
    bestMatches: s.best.map((m) => ({ field: m.field, score: m.score, entryId: m.entry.id, matchedName: m.matchedName })),
  };
}

export const screeningSteps: Step[] = [
  {
    trigger: 'payment.initiated',
    delay: 'stage',
    produce: (_t, state): Outcome | null => {
      if (state.status !== 'initiated') return null;
      const { debtor, creditor } = state.initiated;
      const s = screenParties(debtor.name, creditor.name);
      const inputs = traceInputs(s, debtor.name, creditor.name);
      const alert = sanctionsAlert(state.paymentId, s);
      if (alert) {
        return {
          type: 'risk.alert_raised',
          payload: alert,
          decision: 'potential_match',
          reasonCodes: ['SANCTIONS_POTENTIAL_MATCH', ...s.hits.map((h) => `${h.field.toUpperCase()}_MATCH`)],
          inputs,
          ruleVersion: SCREENING_RULE_VERSION,
        };
      }
      return {
        type: 'payment.screened',
        payload: { result: 'clear', listVersion: SANCTIONS_LIST_VERSION },
        decision: 'clear',
        reasonCodes: ['NO_LIST_MATCH'],
        inputs,
        ruleVersion: SCREENING_RULE_VERSION,
      };
    },
  },
  {
    trigger: 'risk.alert_raised',
    delay: 'stage',
    produce: (trigger, state): Outcome | null => {
      if (trigger.type !== 'risk.alert_raised' || trigger.producer !== 'screening' || trigger.payload.kind !== 'sanctions') return null;
      if (state.status !== 'initiated') return null;
      const { debtor, creditor } = state.initiated;
      const s = screenParties(debtor.name, creditor.name);
      return {
        type: 'payment.screened',
        payload: { result: 'hit', listVersion: SANCTIONS_LIST_VERSION },
        decision: 'hit',
        reasonCodes: ['SANCTIONS_POTENTIAL_MATCH', 'ALERT_RAISED'],
        inputs: { ...traceInputs(s, debtor.name, creditor.name), alertId: trigger.payload.alertId },
        ruleVersion: SCREENING_RULE_VERSION,
      };
    },
  },
];
