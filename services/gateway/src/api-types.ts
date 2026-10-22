// Wire types for the gateway HTTP API and WebSocket. Type-only imports so the web app can
// share them (`import type`) without pulling node code into the browser bundle.
import type {
  AnyEvent,
  EventType,
  Money,
  PaymentState,
  PaymentStatus,
  StatementEntry,
} from '@ct/contracts/browser';

export interface PaymentSummary {
  paymentId: string;
  status: PaymentStatus;
  corridor: string;
  amount: Money;
  targetAmount?: Money;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
  /** Index of status in PIPELINE, or -1 for held/rejected/retrying/failed. */
  stepIndex: number;
  /** Furthest PIPELINE index the payment reached (useful for held/rejected/failed/retrying). */
  lastPipelineIndex: number;
  ledgerPosted: boolean;
  scenario?: string;
  /** Hold/reject/fail reason. */
  reason?: string;
  /** initiated -> reconciled, once reconciled. */
  endToEndMs?: number;
  /** Routing attempt currently in force (1-based). */
  attempt?: number;
  /** Provider rejections so far (payment.send_failed count). */
  retries: number;
  /** Reconciliation outcome once reconciled. */
  recon?: 'matched' | 'break';
}

export interface Throughput {
  windowSec: number;
  /** payment.initiated events in the last minute (by event time). */
  paymentsPerMin: number;
  /** Payments that reached a terminal status in the last minute. */
  completedPerMin: number;
  /** Mean events per second over the window. */
  eventsPerSec: number;
  eventsLastMinute: number;
  /** Events per second, oldest first (windowSec values) - for sparklines. */
  series: number[];
}

export interface Stats {
  total: number;
  byStatus: Record<PaymentStatus, number>;
  reconciled: number;
  inFlight: number;
  held: number;
  rejected: number;
  /** Payments currently waiting for a re-route after a provider reject. */
  retrying: number;
  /** Terminal failures (every eligible provider failed). */
  failed: number;
  /** Total provider rejections (payment.send_failed events). */
  retriesTotal: number;
  /** Reconciled payments whose statement did not match. */
  reconBreaks: number;
  reconMatched: number;
  /** Mean initiated -> reconciled time, null until something reconciles. */
  avgEndToEndMs: number | null;
  /** Events the state machine refused (diagnostics). */
  rejectedEvents: number;
  /** Applied events (= /health events). */
  events: number;
  throughput: Throughput;
}

export interface PaymentDetail {
  state: PaymentState;
  events: AnyEvent[];
  /** Events beyond the per-payment cap that were not kept (normally 0). */
  droppedEvents?: number;
}

export interface RejectedEvent {
  event: AnyEvent;
  error: string;
  receivedAt: string;
}

export interface Health {
  ok: true;
  payments: number;
  events: number;
  /** True once the startup replay reached the log head seen at start. */
  replayed: boolean;
  replayMs: number | null;
}

/** GET /api/payments/:id/messages */
export interface IsoMessage {
  eventId: string;
  eventType: EventType;
  messageType: 'pacs.008' | 'pacs.002';
  occurredAt: string;
  providerId: string;
  attempt?: number;
  /** For pacs.002: ACSC (settled) or RJCT (send_failed). */
  status?: 'ACSC' | 'RJCT';
  reasonCode?: string;
  xml: string;
}

/** GET /api/fx/rates -> FxCorridorRates[] */
export interface FxCorridorRates {
  corridorId: string;
  sourceCurrency: string;
  targetCurrency: string;
  /** Current market mid, null when the market is unavailable. */
  mid: string | null;
  atMs: number;
  series: { atMs: number; mid: string }[];
  seriesStepMs: number;
  marketError?: string;
  quotes: QuoteStats;
}

export interface QuoteStats {
  count: number;
  avgSpreadBps: number | null;
  lastRate?: string;
  lastMid?: string;
  lastSpreadBps?: number;
  lastQuotedAt?: string;
}

export interface ProviderFailure {
  paymentId: string;
  attempt: number;
  reasonCode: string;
  reason: string;
  occurredAt: string;
}

/** GET /api/providers -> ProviderView[] */
export interface ProviderView {
  providerId: string;
  name: string;
  rail: string;
  bic?: string;
  corridors: string[];
  catalogue: {
    baseSuccessRate: number | null;
    latencyMs: { p50: number; p95: number } | null;
    fees: Record<string, { fixedMinor: number; bps: number }>;
  };
  /** From @ct/market providerHealth (null if unavailable). */
  health: {
    attempts: number;
    settled: number;
    failed: number;
    successRate: number;
    avgLatencyMs: number | null;
  } | null;
  healthError?: string;
  /** Gateway-side counters (always available). */
  observed: {
    routed: number;
    sent: number;
    settled: number;
    sendFailed: number;
    /** settled / (settled + sendFailed), null before any outcome. */
    successRate: number | null;
    avgLatencyMs: number | null;
  };
  /** Share of all settled payments (0..1). */
  shareOfVolume: number;
  /** Mean estimated fee in basis points of the source amount, over routing decisions. */
  avgFeeBps: number | null;
  /** Mean estimated fee per source currency. */
  avgFee: Money[];
  /** Provider rejects that forced a re-route (= sendFailed). */
  retriesCaused: number;
  recentFailures: ProviderFailure[];
  failureReasons: Record<string, number>;
  latestStatement?: { date: string; currency: string };
}

/** GET /api/statements -> StatementRef[] (newest date first) */
export interface StatementRef {
  providerId: string;
  date: string;
  currency: string;
  statementId: string;
  entries: number;
  totalMinor: number;
}

export interface StatementGroup extends StatementRef {
  list: StatementEntry[];
}

export interface PaymentsPage {
  total: number;
  offset: number;
  limit: number;
  items: PaymentSummary[];
}

export interface SnapshotMessage {
  kind: 'snapshot';
  payments: PaymentSummary[];
  stats: Stats;
}

/** Event identity without the payload: enough for animations and ordering. */
export interface EventBrief {
  eventId: string;
  type: EventType;
  paymentId: string;
  occurredAt: string;
}

/**
 * Coalesced live update. One per flush window: latest summary per changed payment (capped; the rest
 * follow in the next frame), the events in order (capped, oldest dropped first), per-type counts and stats.
 */
export interface UpdateMessage {
  kind: 'update';
  payments: PaymentSummary[];
  events: EventBrief[];
  /** Events applied in this window, including any not listed in `events`. */
  eventCount: number;
  droppedEvents: number;
  counts: Partial<Record<EventType, number>>;
  stats: Stats;
}

/** Periodic stats refresh (throughput decays even when nothing happens). */
export interface StatsMessage {
  kind: 'stats';
  stats: Stats;
}

export type ServerMessage = SnapshotMessage | UpdateMessage | StatsMessage;

/** One WebSocket frame: a single message or a batch (array) of messages, in order. */
export type ServerFrame = ServerMessage | ServerMessage[];
