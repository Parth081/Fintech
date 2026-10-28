// risk stage (M4): the decision engine (risk/decision.ts) over screening + fraud model + AML typologies.
// One outcome per trigger, so a decision that raises several alerts is a short CHAIN:
//   payment.screened                  -> risk.alert_raised #1 | payment.held | payment.rejected | payment.scored
//   risk.alert_raised #i (producer    -> risk.alert_raised #i+1 | payment.held { alertIds } | payment.rejected
//     risk, still 'screened')
// Every link recomputes the same plan from the same inputs, anchored on the payment.screened event:
// history = payments initiated at a lower log offset than it, configuration = control state as of its
// offset (ctx.controlAt), windows relative to its occurredAt. So the chain is consistent even if a config
// change or new payments land mid-chain, and a restart/replay produces identical events.
import { DEFAULT_CONFIG, type AnyEvent, type ControlState, type PaymentState } from '@ct/contracts';
import { assessRisk, historyBefore, RISK_POLICY_VERSION, type RiskPlan } from '../risk';
import type { Outcome, Step, StepContext } from './common';

export function planFor(state: PaymentState, ctx: StepContext): RiskPlan | null {
  const screened = state.history.findLast((h) => h.type === 'payment.screened');
  if (!screened) return null;
  const offset = ctx.view.offsetOf?.(screened.eventId);
  const control: ControlState = offset !== undefined && ctx.controlAt ? ctx.controlAt(offset) : ctx.control;
  const atMs = Date.parse(screened.occurredAt);
  if (!Number.isFinite(atMs)) throw new Error(`payment ${state.paymentId}: payment.screened has no valid occurredAt`);
  const relevantTo = { debtorAccount: state.initiated.debtor.accountId, creditorAccount: state.initiated.creditor.accountId };
  const history = historyBefore(ctx.view.states.values(), state.paymentId, { atMs, offset }, ctx.view.offsetOf, relevantTo);
  const config = control.config ?? DEFAULT_CONFIG;
  return assessRisk({
    state,
    history,
    atMs,
    config: { 'risk.thresholds': config['risk.thresholds'], 'risk.manualReviewAboveUsd': config['risk.manualReviewAboveUsd'] },
    configVersions: control.configVersions ?? {},
  });
}

function alertOutcome(plan: RiskPlan, i: number): Outcome {
  const a = plan.alerts[i]!;
  return {
    type: 'risk.alert_raised',
    payload: a,
    decision: `alert_${a.kind}`,
    reasonCodes: [a.rule, ...plan.reasonCodes],
    inputs: { ...plan.inputs, alertIndex: i + 1, alertCount: plan.alerts.length, plannedDecision: plan.decision },
    ruleVersion: RISK_POLICY_VERSION,
  };
}

function finalOutcome(plan: RiskPlan): Outcome {
  if (plan.decision === 'reject') {
    return {
      type: 'payment.rejected',
      payload: { reason: plan.heldReason, atStage: 'risk' },
      decision: 'reject',
      reasonCodes: plan.reasonCodes,
      inputs: plan.inputs,
      ruleVersion: RISK_POLICY_VERSION,
    };
  }
  if (plan.decision === 'hold') {
    return {
      type: 'payment.held',
      payload: { reason: plan.heldReason, atStage: 'risk', alertIds: plan.alertIds },
      decision: 'hold',
      reasonCodes: plan.reasonCodes,
      inputs: plan.inputs,
      ruleVersion: RISK_POLICY_VERSION,
    };
  }
  return {
    type: 'payment.scored',
    payload: { fraudScore: plan.fraud.score, amlAlerts: plan.aml.map((a) => a.rule), decision: 'approve' },
    decision: 'approve',
    reasonCodes: plan.reasonCodes,
    inputs: plan.inputs,
    ruleVersion: RISK_POLICY_VERSION,
  };
}

const next = (plan: RiskPlan, i: number) => (i < plan.alerts.length ? alertOutcome(plan, i) : finalOutcome(plan));

export const riskSteps: Step[] = [
  {
    trigger: 'payment.screened',
    delay: 'stage',
    produce: (trigger: AnyEvent, state, ctx) => {
      if (trigger.type !== 'payment.screened' || state.status !== 'screened') return null;
      const plan = planFor(state, ctx);
      return plan ? next(plan, 0) : null;
    },
  },
  {
    trigger: 'risk.alert_raised',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'risk.alert_raised' || trigger.producer !== 'risk' || state.status !== 'screened') return null;
      if (state.facts['risk.alert_raised']?.alertId !== trigger.payload.alertId) return null; // a later alert superseded it
      const plan = planFor(state, ctx);
      if (!plan) return null;
      const i = plan.alerts.findIndex((a) => a.alertId === trigger.payload.alertId);
      if (i < 0) {
        // Not in the plan (cannot happen with identical inputs): finish the decision, keeping this alert.
        const fin = finalOutcome(plan);
        if (fin.type === 'payment.held' && !fin.payload.alertIds?.includes(trigger.payload.alertId)) {
          fin.payload = { ...fin.payload, alertIds: [...(fin.payload.alertIds ?? []), trigger.payload.alertId] };
        }
        return fin;
      }
      return next(plan, i + 1);
    },
  },
];
