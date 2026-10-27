// Decision engine: screening + fraud model + AML typologies + configuration -> approve | hold | reject.
//
// Policy (RISK_POLICY_VERSION):
//   combined  = 1 - (1 - fraudScore) x prod(1 - amlScore_i)          (noisy-OR of the independent signals)
//   1. sanctions potential match (screening 'hit')    -> HOLD, always (never auto-rejected: a human disposes)
//   2. fraudScore >= thresholds.reject                -> REJECT (atStage 'risk')
//   3. combined >= thresholds.hold                    -> HOLD
//   4. amount >= manualReviewAboveUsd (> 0)           -> HOLD (large-value review)
//   5. scenario 'force-hold'                          -> HOLD (demo control)
//   6. otherwise                                      -> APPROVE (payment.scored)
// AML never auto-rejects. Thresholds and the review amount are read from the configuration as of the
// decision's first trigger (control.config.updated before it), defaults from DEFAULT_CONFIG.
//
// Alerts: on HOLD or REJECT the risk stage raises one risk.alert_raised per contributing signal
// (fraud model when fraudScore >= FRAUD_ALERT_MIN or nothing else explains the decision; each AML typology;
// the large-value review; the force-hold scenario), then emits payment.held { alertIds } (including the
// screening stage's sanctions alert) or payment.rejected. Alert ids are deterministic per (payment, rule).
import { deterministicId, type ConfigValues, type PayloadMap, type PaymentState } from '@ct/contracts';
import { detectAml, AML_RULES_VERSION, type AmlHit } from './aml';
import { FRAUD_MODEL_VERSION, scoreFraud, type FraudResult } from './fraud-model';
import { recordOf, type PaymentRecord } from './history';
import { SANCTIONS_CRITICAL_THRESHOLD, screenParties, type ScreeningResult } from './matching';

export const RISK_POLICY_VERSION = 'risk-engine-v1';
export const FRAUD_ALERT_MIN = 0.5;

export type AlertPayload = PayloadMap['risk.alert_raised'];

export function alertIdFor(paymentId: string, rule: string): string {
  return `ALR-${deterministicId(paymentId, 'risk-alert', rule).replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

/** The sanctions alert the screening stage raises for a hit (null when clear). */
export function sanctionsAlert(paymentId: string, s: ScreeningResult): AlertPayload | null {
  const top = s.hits[0];
  if (!top) return null;
  return {
    alertId: alertIdFor(paymentId, 'SANCTIONS_FUZZY_MATCH'),
    kind: 'sanctions',
    severity: top.score >= SANCTIONS_CRITICAL_THRESHOLD ? 'critical' : 'high',
    rule: 'SANCTIONS_FUZZY_MATCH',
    score: top.score,
    summary: `${top.field === 'debtor' ? 'Sender' : 'Beneficiary'} "${top.partyName}" is a potential match (${Math.round(top.score * 100)}%) for ${top.entry.name} on the ${s.listName}`,
    reasons: s.hits.map((h) => ({
      code: h.matchedAlias ? 'ALIAS_MATCH' : 'NAME_MATCH',
      text: `${h.field === 'debtor' ? 'Sender' : 'Beneficiary'} name "${h.partyName}" vs listed ${h.matchedAlias ? 'alias' : 'name'} "${h.matchedName}" (${h.entry.id}, ${h.entry.program})`,
      weight: h.score,
    })),
    evidence: {
      listName: s.listName,
      listVersion: s.listVersion,
      algorithm: s.algorithm,
      threshold: s.threshold,
      field: top.field,
      score: top.score,
      entry: top.entry,
      matchedName: top.matchedName,
      matches: s.hits,
    },
  };
}

export interface RiskInput {
  state: PaymentState;
  history: readonly PaymentRecord[];
  /** Anchor time (the payment.screened trigger). */
  atMs: number;
  config: Pick<ConfigValues, 'risk.thresholds' | 'risk.manualReviewAboveUsd'>;
  configVersions?: Partial<Record<string, number>>;
}

export interface RiskPlan {
  decision: 'approve' | 'hold' | 'reject';
  reasonCodes: string[];
  screening: ScreeningResult;
  fraud: FraudResult;
  aml: AmlHit[];
  combined: number;
  /** Alerts the RISK stage raises, in order (excludes the screening stage's sanctions alert). */
  alerts: AlertPayload[];
  /** Every alert on the hold/reject (sanctions alert first). */
  alertIds: string[];
  heldReason: string;
  inputs: Record<string, unknown>;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function assessRisk(input: RiskInput): RiskPlan {
  const { state, history, atMs } = input;
  const thresholds = input.config['risk.thresholds'];
  const reviewUsd = input.config['risk.manualReviewAboveUsd'];
  const p = recordOf(state);
  const init = state.initiated;
  const screening = screenParties(init.debtor.name, init.creditor.name);
  const fraud = scoreFraud({ payment: p, debtorCountry: init.debtor.country, history, atMs, manualReviewAboveUsd: reviewUsd });
  const aml = detectAml(p, history, atMs, reviewUsd);
  const combined = r4(1 - (1 - fraud.score) * aml.reduce((s, a) => s * (1 - a.score), 1));
  const sanctionsHit = screening.result === 'hit';
  const largeValue = reviewUsd > 0 && p.usd >= reviewUsd;
  const forceHold = init.scenario === 'force-hold';

  const codes: string[] = [];
  let decision: RiskPlan['decision'];
  if (sanctionsHit) {
    decision = 'hold';
    codes.push('SANCTIONS_POTENTIAL_MATCH');
  } else if (fraud.score >= thresholds.reject) {
    decision = 'reject';
    codes.push('FRAUD_SCORE_ABOVE_REJECT');
  } else if (combined >= thresholds.hold) {
    decision = 'hold';
    codes.push('RISK_SCORE_ABOVE_HOLD');
  } else if (largeValue) {
    decision = 'hold';
  } else if (forceHold) {
    decision = 'hold';
  } else {
    decision = 'approve';
    codes.push('SCORE_BELOW_THRESHOLD');
  }
  if (fraud.score >= thresholds.hold) codes.push('FRAUD_MODEL_HIGH');
  for (const a of aml) codes.push(a.rule);
  if (largeValue) codes.push('MANUAL_REVIEW_AMOUNT');
  if (forceHold) codes.push('SCENARIO_FORCE_HOLD');

  const alerts: AlertPayload[] = [];
  if (decision !== 'approve') {
    if (forceHold && decision === 'hold' && !sanctionsHit) {
      alerts.push({
        alertId: alertIdFor(state.paymentId, 'SCENARIO_FORCE_HOLD'),
        kind: 'fraud',
        severity: 'medium',
        rule: 'SCENARIO_FORCE_HOLD',
        summary: 'Held for manual review by the force-hold demo scenario',
        reasons: [{ code: 'SCENARIO_FORCE_HOLD', text: 'The payment was submitted with scenario "force-hold", which always holds it for review' }],
        evidence: { scenario: 'force-hold', fraudScore: fraud.score },
      });
    }
    if (fraud.score >= FRAUD_ALERT_MIN || decision === 'reject') {
      const rule = decision === 'reject' ? 'FRAUD_MODEL_REJECT' : 'FRAUD_MODEL_HIGH';
      alerts.push({
        alertId: alertIdFor(state.paymentId, rule),
        kind: 'fraud',
        severity: decision === 'reject' ? 'critical' : fraud.score >= 0.85 ? 'high' : 'medium',
        rule,
        score: fraud.score,
        summary: `Fraud model scored ${Math.round(fraud.score * 100)}%: ${fraud.reasons.slice(0, 2).map((r) => r.text.charAt(0).toLowerCase() + r.text.slice(1)).join('; ')}`,
        reasons: fraud.reasons,
        evidence: { model: fraud.model, logit: fraud.logit, intercept: fraud.intercept, features: fraud.features, facts: fraud.facts, thresholds },
      });
    }
    {
      for (const a of aml) {
        alerts.push({
          alertId: alertIdFor(state.paymentId, a.rule),
          kind: 'aml',
          severity: a.severity,
          rule: a.rule,
          score: a.score,
          summary: a.summary,
          reasons: a.reasons,
          evidence: { ...a.evidence, relatedPaymentIds: a.relatedPaymentIds, rulesVersion: AML_RULES_VERSION },
        });
      }
    }
    if (largeValue) {
      alerts.push({
        alertId: alertIdFor(state.paymentId, 'AML_LARGE_VALUE_REVIEW'),
        kind: 'aml',
        severity: 'medium',
        rule: 'AML_LARGE_VALUE_REVIEW',
        summary: `Payment of about USD ${Math.round(p.usd).toLocaleString('en-US')} is at or above the USD ${reviewUsd.toLocaleString('en-US')} manual-review threshold`,
        reasons: [{ code: 'MANUAL_REVIEW_AMOUNT', text: `Payments of USD ${reviewUsd.toLocaleString('en-US')} or more always need a compliance review (config risk.manualReviewAboveUsd)` }],
        evidence: { amount: p.amount, amountUsd: p.usd, manualReviewAboveUsd: reviewUsd, configVersion: input.configVersions?.['risk.manualReviewAboveUsd'] ?? 0 },
      });
    }
    if (!alerts.length && !sanctionsHit) {
      // A hold must always be workable as a case: fall back to the fraud alert.
      alerts.push({
        alertId: alertIdFor(state.paymentId, 'FRAUD_MODEL_HIGH'),
        kind: 'fraud', severity: 'medium', rule: 'FRAUD_MODEL_HIGH', score: fraud.score,
        summary: `Combined risk score ${Math.round(combined * 100)}% is above the hold threshold`,
        reasons: fraud.reasons,
        evidence: { model: fraud.model, features: fraud.features, combined, thresholds },
      });
    }
  }

  const sanctions = sanctionsHit ? sanctionsAlert(state.paymentId, screening) : null;
  const alertIds = [...(sanctions ? [sanctions.alertId] : []), ...alerts.map((a) => a.alertId)];
  const heldReason = sanctionsHit
    ? `Sanctions screening: potential match for ${screening.hits[0]!.entry.name} (${Math.round(screening.score * 100)}%)`
    : forceHold && decision === 'hold'
      ? 'Manual review (scenario)'
      : decision === 'reject'
        ? `Fraud model score ${Math.round(fraud.score * 100)}% is at or above the reject threshold ${thresholds.reject}`
        : alerts.length
          ? `Held for review: ${alerts.map((a) => a.rule).join(', ')} (risk score ${Math.round(combined * 100)}%)`
          : 'Held for review';

  return {
    decision,
    reasonCodes: codes,
    screening,
    fraud,
    aml,
    combined,
    alerts,
    alertIds,
    heldReason,
    inputs: {
      policyVersion: RISK_POLICY_VERSION,
      fraudModel: FRAUD_MODEL_VERSION,
      amlRules: AML_RULES_VERSION,
      config: { 'risk.thresholds': thresholds, 'risk.manualReviewAboveUsd': reviewUsd },
      configVersions: input.configVersions ?? {},
      amountUsd: p.usd,
      screening: { result: screening.result, score: screening.score, listVersion: screening.listVersion },
      fraudScore: fraud.score,
      fraudFeatures: fraud.features.map((f) => ({ code: f.code, value: f.value, contribution: f.contribution })),
      amlTypologies: aml.map((a) => ({ rule: a.rule, score: a.score, related: a.relatedPaymentIds.length })),
      combinedScore: combined,
      historyAsOf: new Date(atMs).toISOString(),
      historyPayments: history.length,
      scenario: init.scenario ?? null,
      alertIds,
    },
  };
}
