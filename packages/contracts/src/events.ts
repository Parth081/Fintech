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
  | 'retrying' // a provider failed the instruction; routing picks another provider
  | 'held'
  | 'rejected'
  | 'failed'; // every eligible provider failed; terminal, nothing was posted to the ledger

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
  | 'payment.send_failed'
  | 'payment.failed'
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
  'payment.send_failed',
  'payment.failed',
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
    rate: string; // decimal string, e.g. "83.1250" (target units per 1 source unit), spread applied
    midRate?: string; // market mid at quote time (M2+)
    rateTimestamp?: string; // ISO time of the market tick used (M2+)
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
    attempt?: number; // 1-based (M2+); >1 after a send_failed
    excludedProviders?: string[]; // providers that already failed this payment (M2+)
    scoring?: ProviderScore[]; // full explanation of the choice (M2+)
  };
  'payment.sent': {
    providerId: string;
    messageType: 'pacs.008';
    messageId: string;
    attempt?: number; // M2+
    message?: string; // ISO 20022 pacs.008 XML (M2+)
  };
  'payment.send_failed': {
    providerId: string;
    attempt: number;
    reasonCode: string; // ISO 20022 status reason, e.g. "AC04", "AM04", "NARR"
    reason: string;
    statusMessage: 'pacs.002';
    message?: string; // pacs.002 XML with status RJCT
  };
  'payment.settled': {
    providerId: string;
    settlementRef: string;
    statusMessage: 'pacs.002';
    attempt?: number; // M2+
    settledAmount?: Money; // amount the provider confirms it delivered (target currency) (M2+)
    valueDate?: string; // YYYY-MM-DD (M2+)
    message?: string; // pacs.002 XML with status ACSC (M2+)
    statementEntry?: StatementEntry; // what the provider will report on its camt.053 (M2+)
  };
  'ledger.posted': { journalId: string; entries: LedgerEntry[] };
  'payment.reconciled': {
    statementRef: string;
    matched: boolean;
    journalId?: string; // M2+
    breaks?: string[]; // empty when matched (M2+)
  };
  'payment.failed': { reason: string; atStage: StageName; attempts?: number };
  'payment.held': { reason: string; atStage: StageName };
  'payment.rejected': { reason: string; atStage: StageName };
}

/** One provider's score in a routing decision. Higher score wins. */
export interface ProviderScore {
  providerId: string;
  eligible: boolean;
  excludedReason?: string; // e.g. "FAILED_THIS_PAYMENT", "CORRIDOR_NOT_SERVED", "CIRCUIT_OPEN"
  fee: Money; // in source currency
  successRate: number; // 0..1, observed or catalogue
  latencyMs: number; // expected
  score: number;
}

/** A provider statement line (camt.053 Ntry). */
export interface StatementEntry {
  statementId: string;
  entryRef: string; // AcctSvcrRef
  providerId: string;
  amount: Money;
  bookingDate: string; // YYYY-MM-DD
  endToEndId: string; // = paymentId
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
