// Deterministic M1 stubs, one per pipeline step. Each maps (trigger event, projected state) to the
// event the stage should produce, or null when the trigger is not actionable for this stage.
import {
  corridorById,
  deterministicId,
  PROVIDERS,
  unitHash,
  type AnyEvent,
  type EventType,
  type PayloadMap,
  type PaymentState,
  type StageName,
} from '@ct/contracts';
import { applySpread, bpsFee, convert, formatDecimal } from './fx-math';

export const RULE_VERSION = 'stub-v1';
export const SANCTIONS_LIST_VERSION = 'fictional-sanctions-2026.1';
export const FX_SPREAD_BPS = 35;
export const QUOTE_TTL_MS = 30_000;
export const ROUTING_FEE_BPS = 15;
export const ROUTING_FEE_MIN_MINOR = 100;

export type PipelineStage = Exclude<StageName, 'payment-api'>;

export const STAGE_NAMES: readonly PipelineStage[] = [
  'screening',
  'risk',
  'fx',
  'routing',
  'settlement',
  'ledger',
  'reconciliation',
];

export function isStageName(value: string): value is PipelineStage {
  return (STAGE_NAMES as readonly string[]).includes(value);
}

/** What a stub decided. The runner wraps it into an envelope with ids, trace and timing. */
export type Outcome = {
  [K in EventType]: {
    type: K;
    payload: PayloadMap[K];
    decision: string;
    reasonCodes: string[];
    inputs: Record<string, unknown>;
  };
}[EventType];

export interface StepContext {
  /** occurredAt the produced event will carry (ISO). */
  now: string;
}

export interface Step {
  trigger: EventType;
  /** Which configured delay to wait before acting. */
  delay: 'stage' | 'settlement';
  produce(trigger: AnyEvent, state: PaymentState, ctx: StepContext): Outcome | null;
}

const shortRef = (...parts: string[]) => deterministicId(...parts).replace(/-/g, '').slice(0, 12).toUpperCase();

const screening: Step[] = [
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

const risk: Step[] = [
  {
    trigger: 'payment.screened',
    delay: 'stage',
    produce: (_t, state) => {
      const scenario = state.initiated.scenario;
      if (scenario === 'force-hold') {
        return {
          type: 'payment.held',
          payload: { reason: 'Manual review (scenario)', atStage: 'risk' },
          decision: 'hold',
          reasonCodes: ['SCENARIO_FORCE_HOLD'],
          inputs: { scenario },
        };
      }
      const fraudScore = Math.round(unitHash(state.paymentId) * 0.2 * 1000) / 1000;
      return {
        type: 'payment.scored',
        payload: { fraudScore, amlAlerts: [], decision: 'approve' },
        decision: 'approve',
        reasonCodes: ['STUB_PASS', 'SCORE_BELOW_THRESHOLD'],
        inputs: { amount: state.initiated.amount, corridor: state.initiated.corridor, fraudScore, scenario: scenario ?? null },
      };
    },
  },
];

const fx: Step[] = [
  {
    trigger: 'payment.scored',
    delay: 'stage',
    produce: (trigger, state, ctx) => {
      if (trigger.type !== 'payment.scored' || trigger.payload.decision !== 'approve') return null;
      const init = state.initiated;
      const corridor = corridorById(init.corridor);
      if (!corridor) throw new Error(`unknown corridor ${init.corridor}`);
      const rate = applySpread(corridor.midRate, FX_SPREAD_BPS);
      const targetAmount = convert(init.amount, rate, init.targetCurrency);
      const rateStr = formatDecimal(rate);
      return {
        type: 'payment.quoted',
        payload: {
          quoteId: `q-${shortRef(state.paymentId, 'fx-quote')}`,
          rate: rateStr,
          spreadBps: FX_SPREAD_BPS,
          sourceAmount: init.amount,
          targetAmount,
          expiresAt: new Date(Date.parse(ctx.now) + QUOTE_TTL_MS).toISOString(),
        },
        decision: 'quoted',
        reasonCodes: ['STUB_PASS', 'MID_RATE_PLUS_SPREAD'],
        inputs: { corridor: corridor.id, midRate: corridor.midRate, spreadBps: FX_SPREAD_BPS, rate: rateStr, sourceAmount: init.amount },
      };
    },
  },
];

const routing: Step[] = [
  {
    trigger: 'payment.quoted',
    delay: 'stage',
    produce: (_t, state) => {
      const init = state.initiated;
      const eligible = PROVIDERS.filter((p) => p.corridors.includes(init.corridor));
      const [chosen, ...others] = eligible;
      if (!chosen) throw new Error(`no provider serves corridor ${init.corridor}`);
      const alternatives = others.map((p) => ({
        providerId: p.id,
        score: Math.round((0.5 + unitHash(`${state.paymentId}|${p.id}`) * 0.4) * 1000) / 1000,
      }));
      const estimatedFee = bpsFee(init.amount, ROUTING_FEE_BPS, ROUTING_FEE_MIN_MINOR);
      return {
        type: 'payment.routed',
        payload: { providerId: chosen.id, rail: chosen.rail, estimatedFee, alternatives },
        decision: chosen.id,
        reasonCodes: ['STUB_PASS', 'FIRST_ELIGIBLE_PROVIDER'],
        inputs: { corridor: init.corridor, eligible: eligible.map((p) => p.id), feeBps: ROUTING_FEE_BPS, feeMinMinor: ROUTING_FEE_MIN_MINOR },
      };
    },
  },
];

const settlement: Step[] = [
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

const ledger: Step[] = [
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

const reconciliation: Step[] = [
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

export const STAGE_STEPS: Record<PipelineStage, Step[]> = {
  screening,
  risk,
  fx,
  routing,
  settlement,
  ledger,
  reconciliation,
};
