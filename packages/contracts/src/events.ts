// Event contracts shared by every service. Change these only with agreement from all owners.

/** One topic for the whole payment lifecycle; keyed by paymentId. */
export const PAYMENTS_TOPIC = 'payments' as const;

export const SCHEMA_VERSION = 1 as const;

export type PaymentStatus =
  | 'initiated'
  | 'screened'
  | 'scored'
  | 'quoted'
  | 'routed'
  | 'sent'
  | 'settled'
  | 'reconciled'
  | 'held'
  | 'rejected';

export type EventType =
  | 'payment.initiated'
  | 'payment.screened'
  | 'payment.scored'
  | 'payment.quoted'
  | 'payment.routed'
  | 'payment.sent'
  | 'payment.settled'
  | 'ledger.posted'
  | 'payment.reconciled'
  | 'payment.held'
  | 'payment.rejected';

export const EVENT_TYPES: readonly EventType[] = [
  'payment.initiated',
  'payment.screened',
  'payment.scored',
  'payment.quoted',
  'payment.routed',
  'payment.sent',
  'payment.settled',
  'ledger.posted',
  'payment.reconciled',
  'payment.held',
  'payment.rejected',
];

/** Services that produce events. Each pipeline stage is its own process. */
export type StageName =
  | 'payment-api'
  | 'screening'
  | 'risk'
  | 'fx'
  | 'routing'
  | 'settlement'
  | 'ledger'
  | 'reconciliation';

/** Money is always integer minor units (cents, paise...) plus an ISO 4217 code. Never floats. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export interface Party {
  name: string;
  country: string; // ISO 3166-1 alpha-2
  accountId: string;
}

export interface LedgerEntry {
  account: string;
  direction: 'debit' | 'credit';
  amount: Money;
}

export interface PayloadMap {
  'payment.initiated': {
    amount: Money;
    targetCurrency: string;
    corridor: string; // e.g. "US-IN"
    debtor: Party;
    creditor: Party;
    idempotencyKey: string;
    scenario?: string;
  };
  'payment.screened': { result: 'clear' | 'hit'; listVersion: string };
  'payment.scored': { fraudScore: number; amlAlerts: string[]; decision: 'approve' | 'hold' | 'reject' };
  'payment.quoted': {
    quoteId: string;
    rate: string; // decimal string, e.g. "83.1250" (target units per 1 source unit)
    spreadBps: number;
    sourceAmount: Money;
    targetAmount: Money;
    expiresAt: string;
  };
  'payment.routed': {
    providerId: string;
    rail: string;
    estimatedFee: Money;
    alternatives: { providerId: string; score: number }[];
  };
  'payment.sent': { providerId: string; messageType: 'pacs.008'; messageId: string };
  'payment.settled': { providerId: string; settlementRef: string; statusMessage: 'pacs.002' };
  'ledger.posted': { journalId: string; entries: LedgerEntry[] };
  'payment.reconciled': { statementRef: string; matched: boolean };
  'payment.held': { reason: string; atStage: StageName };
  'payment.rejected': { reason: string; atStage: StageName };
}

/** Why a decision was made. Every stage-produced event carries one (design rule: a decision trace for every decision). */
export interface DecisionTrace {
  stage: StageName;
  decision: string;
  reasonCodes: string[];
  inputs: Record<string, unknown>;
  ruleVersion: string;
  latencyMs: number;
}

export interface EventEnvelope<T extends EventType = EventType> {
  eventId: string;
  type: T;
  schemaVersion: typeof SCHEMA_VERSION;
  paymentId: string;
  occurredAt: string; // ISO-8601
  correlationId: string; // = paymentId for the payment lifecycle
  causationId: string | null; // eventId of the event that caused this one
  producer: StageName;
  payload: PayloadMap[T];
  trace?: DecisionTrace;
}

export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}
