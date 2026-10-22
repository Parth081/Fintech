// settlement stage: a deterministic provider simulator speaking ISO 20022.
//   payment.routed -> payment.sent (pacs.008 to the chosen provider)
//   payment.sent   -> payment.settled (pacs.002 ACSC + the camt.053 line the provider will report)
//                  or payment.send_failed (pacs.002 RJCT with an ISO reason code; routing retries)
// Every outcome is a pure function of (seed, paymentId, attempt, providerId) and the trigger, so a
// redelivered trigger yields the same event (same id, same payload).
import { unitHash, type AnyEvent, type Money, type PayloadMap, type PaymentState, type StatementEntry } from '@ct/contracts';
import { buildPacs002, buildPacs008, originatorBic, SIMULATED_REJECT_CODES, statementIdFor, statusReason } from '@ct/iso20022';
import { providerProfile } from '@ct/market';
import { shortRef, type Outcome, type StageServices, type Step } from './common';

export const SETTLEMENT_RULE_VERSION = 'settlement-sim-v1';
const DEFAULT_SEED = 'control-tower';
const DEFAULT_SUCCESS_RATE = 0.95; // unknown provider (not in the catalogue)
const SCENARIO_REJECT_CODE = 'AG01';

export const messageIdFor = (paymentId: string, kind: 'pacs.008' | 'pacs.002', attempt: number) =>
  `MSG-${shortRef(paymentId, kind, String(attempt))}`;

export function providerBic(providerId: string): string {
  return providerProfile(providerId)?.bic ?? `X${providerId.toUpperCase().replace(/[^A-Z]/g, 'X').padEnd(3, 'X').slice(0, 3)}XX22XXX`;
}

export interface SettlementDraw {
  seed: string;
  providerFailureScale: number;
  baseSuccessRate: number;
  failureProbability: number;
  draw: number;
  fail: boolean;
  forcedByScenario: boolean;
  reasonCode?: string;
}

/** The simulator's decision for one attempt. Exported for tests and for the UI's "why" panel. */
export function settlementDraw(
  input: { paymentId: string; attempt: number; providerId: string; scenario?: string },
  sim: StageServices['sim'],
): SettlementDraw {
  const seed = sim?.seed ?? DEFAULT_SEED;
  const scale = sim?.providerFailureScale ?? 1;
  const baseSuccessRate = providerProfile(input.providerId)?.baseSuccessRate ?? DEFAULT_SUCCESS_RATE;
  const failureProbability = Math.min(1, Math.max(0, (1 - baseSuccessRate) * (Number.isFinite(scale) ? scale : 1)));
  const draw = unitHash(`${seed}|${input.paymentId}|${input.attempt}|${input.providerId}`);
  const forcedByScenario = input.scenario === 'provider-reject' && input.attempt === 1;
  const fail = forcedByScenario || (failureProbability > 0 && (draw < failureProbability || failureProbability >= 1));
  let reasonCode: string | undefined;
  if (fail) {
    if (forcedByScenario) reasonCode = SCENARIO_REJECT_CODE;
    else {
      const pick = unitHash(`${seed}|${input.paymentId}|${input.attempt}|${input.providerId}|reason`);
      reasonCode = SIMULATED_REJECT_CODES[Math.min(SIMULATED_REJECT_CODES.length - 1, Math.floor(pick * SIMULATED_REJECT_CODES.length))];
    }
  }
  return { seed, providerFailureScale: scale, baseSuccessRate, failureProbability, draw, fail, forcedByScenario, reasonCode };
}

/** Amount the provider confirms; 1 minor unit short for the recon-break demo scenario. */
export function settledAmountFor(quotedTarget: Money, scenario: string | undefined): Money {
  if (scenario !== 'recon-break') return quotedTarget;
  return { amountMinor: Math.max(0, quotedTarget.amountMinor - 1), currency: quotedTarget.currency };
}

function remittance(state: PaymentState): string {
  return `Cross-border payment ${state.initiated.corridor} ${state.paymentId} (synthetic demo)`;
}

function produceSent(trigger: AnyEvent, state: PaymentState): Outcome | null {
  if (trigger.type !== 'payment.routed') return null;
  const routed = trigger.payload;
  const latest = state.facts['payment.routed'];
  // Act only on the routing decision that is current (a stale redelivered routed must not send).
  if (!latest || latest.providerId !== routed.providerId || (latest.attempt ?? 1) !== (routed.attempt ?? 1)) return null;
  const quoted = state.facts['payment.quoted'];
  if (!quoted) return null;
  const attempt = routed.attempt ?? 1;
  const messageId = messageIdFor(state.paymentId, 'pacs.008', attempt);
  const bic = providerBic(routed.providerId);
  const message = buildPacs008({
    messageId,
    createdAt: trigger.occurredAt,
    paymentId: state.paymentId,
    settlementDate: trigger.occurredAt.slice(0, 10),
    settlementAmount: quoted.targetAmount,
    instructedAmount: quoted.sourceAmount,
    exchangeRate: quoted.rate,
    debtor: state.initiated.debtor,
    creditor: state.initiated.creditor,
    debtorAgentBic: originatorBic(state.initiated.debtor.country),
    creditorAgentBic: bic,
    remittanceInfo: remittance(state),
  });
  return {
    type: 'payment.sent',
    payload: { providerId: routed.providerId, messageType: 'pacs.008', messageId, attempt, message },
    decision: 'sent',
    reasonCodes: ['INSTRUCTION_SUBMITTED', 'PACS008_BUILT'],
    inputs: {
      providerId: routed.providerId,
      providerBic: bic,
      rail: routed.rail,
      attempt,
      messageId,
      settlementAmount: quoted.targetAmount,
      instructedAmount: quoted.sourceAmount,
      rate: quoted.rate,
    },
    ruleVersion: SETTLEMENT_RULE_VERSION,
  };
}

function produceOutcome(trigger: AnyEvent, state: PaymentState, services: StageServices): Outcome | null {
  if (trigger.type !== 'payment.sent') return null;
  const sent = trigger.payload;
  const latest = state.facts['payment.sent'];
  if (state.status !== 'sent' || !latest || latest.messageId !== sent.messageId) return null; // stale trigger
  const quoted = state.facts['payment.quoted'];
  if (!quoted) return null;
  const attempt = sent.attempt ?? 1;
  const scenario = state.initiated.scenario;
  const d = settlementDraw({ paymentId: state.paymentId, attempt, providerId: sent.providerId, scenario }, services.sim);
  const bic = providerBic(sent.providerId);
  const statusMessageId = messageIdFor(state.paymentId, 'pacs.002', attempt);
  const inputs: Record<string, unknown> = {
    providerId: sent.providerId,
    attempt,
    originalMessageId: sent.messageId,
    seed: d.seed,
    baseSuccessRate: d.baseSuccessRate,
    providerFailureScale: d.providerFailureScale,
    failureProbability: Number(d.failureProbability.toFixed(6)),
    draw: Number(d.draw.toFixed(6)),
    rule: 'fail if draw < (1 - baseSuccessRate) x providerFailureScale',
    scenario: scenario ?? null,
  };

  if (d.fail) {
    const reason = statusReason(d.reasonCode ?? 'MS03');
    const message = buildPacs002({
      messageId: statusMessageId,
      createdAt: trigger.occurredAt,
      originalMessageId: sent.messageId,
      paymentId: state.paymentId,
      status: 'RJCT',
      reasonCode: reason.code,
      instructingAgentBic: bic,
      instructedAgentBic: originatorBic(state.initiated.debtor.country),
    });
    const payload: PayloadMap['payment.send_failed'] = {
      providerId: sent.providerId,
      attempt,
      reasonCode: reason.code,
      reason: reason.text,
      statusMessage: 'pacs.002',
      message,
    };
    return {
      type: 'payment.send_failed',
      payload,
      decision: 'rejected_by_provider',
      reasonCodes: ['PROVIDER_REJECTED', reason.code, ...(d.forcedByScenario ? ['SCENARIO_PROVIDER_REJECT'] : [])],
      inputs: { ...inputs, reasonCode: reason.code, reasonName: reason.name },
      ruleVersion: SETTLEMENT_RULE_VERSION,
    };
  }

  const settledAmount = settledAmountFor(quoted.targetAmount, scenario);
  const valueDate = trigger.occurredAt.slice(0, 10);
  const statementEntry: StatementEntry = {
    statementId: statementIdFor(sent.providerId, valueDate),
    entryRef: `NTRY-${shortRef(state.paymentId, sent.providerId, String(attempt), 'camt.053')}`,
    providerId: sent.providerId,
    amount: settledAmount,
    bookingDate: valueDate,
    endToEndId: state.paymentId,
  };
  const message = buildPacs002({
    messageId: statusMessageId,
    createdAt: trigger.occurredAt,
    originalMessageId: sent.messageId,
    paymentId: state.paymentId,
    status: 'ACSC',
    instructingAgentBic: bic,
    instructedAgentBic: originatorBic(state.initiated.debtor.country),
    acceptanceDateTime: trigger.occurredAt,
  });
  const reconBreak = settledAmount.amountMinor !== quoted.targetAmount.amountMinor;
  return {
    type: 'payment.settled',
    payload: {
      providerId: sent.providerId,
      settlementRef: `STL-${shortRef(state.paymentId, 'settlement', String(attempt))}`,
      statusMessage: 'pacs.002',
      attempt,
      settledAmount,
      valueDate,
      message,
      statementEntry,
    },
    decision: 'settled',
    reasonCodes: ['PROVIDER_CONFIRMED', 'ACSC', ...(reconBreak ? ['SCENARIO_RECON_BREAK'] : [])],
    inputs: { ...inputs, quotedAmount: quoted.targetAmount, settledAmount, statementId: statementEntry.statementId },
    ruleVersion: SETTLEMENT_RULE_VERSION,
  };
}

export const settlementSteps: Step[] = [
  { trigger: 'payment.routed', delay: 'stage', produce: (t, state) => produceSent(t, state) },
  { trigger: 'payment.sent', delay: 'settlement', produce: (t, state, ctx) => produceOutcome(t, state, ctx.services) },
];
