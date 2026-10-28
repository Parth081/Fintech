// Wire types for the gateway HTTP API and WebSocket. Type-only imports so the web app can
// share them (`import type`) without pulling node code into the browser bundle.
import type {
  AnyEvent,
  EventType,
  Money,
  PaymentState,
  PaymentStatus,
  StatementEntry,
  ControlView,
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
  /** Changes every time the gateway process starts (the UI uses it to detect a completed reset). */
  instanceId: string;
  startedAt: string;
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

/** GET /api/payments/trend?minutes=30 (M4 console): payments initiated / failed per minute by createdAt, oldest first. */
export interface PaymentTrend {
  bucketMs: number;
  /** Start of the oldest bucket (epoch ms). */
  fromMs: number;
  initiated: number[];
  failed: number[];
  /** Source volume per bucket in USD-equivalent is not known here; counts only. */
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

// ---- M3 control plane ------------------------------------------------------------------

/** Per-provider routing traffic, one value per bucket, oldest first. */
export interface ProviderTraffic {
  providerId: string;
  /** First-attempt routings (attempt 1) per bucket. */
  firstAttempt: number[];
  /** Re-routes INTO this provider (attempt > 1) per bucket. */
  rerouted: number[];
  /** Provider rejects (payment.send_failed) per bucket. */
  failed: number[];
  settled: number[];
  total: { firstAttempt: number; rerouted: number; failed: number; settled: number };
}

/** GET /api/control/traffic (also inside GatewayControlView.traffic). Buckets by event time. */
export interface TrafficView {
  bucketMs: number;
  buckets: number;
  /** Start of the oldest bucket / end of the newest bucket (epoch ms). */
  fromMs: number;
  toMs: number;
  providers: ProviderTraffic[];
}

/** A payment that was re-routed away from a provider that rejected it. */
export interface RerouteBrief {
  paymentId: string;
  fromProviderId: string;
  toProviderId: string;
  attempt: number;
  reasonCode?: string;
  reason?: string;
  at: string;
}

/** GET /api/control/state: the contract's ControlView plus gateway extras. */
export interface GatewayControlView extends ControlView {
  /** Gateway clock when the view was computed (epoch ms). */
  atMs: number;
  /** Set when breakerStates() is unavailable (breakers is then []). */
  breakerError?: string;
  /** Why orchestrator is null (unreachable, HTTP error). */
  orchestratorError?: string;
  traffic: TrafficView;
  /** Newest first. */
  reroutes: RerouteBrief[];
}

/** Control plane changed (control event, breaker change, orchestrator change; at least every 2 s while a scenario runs). */
export interface ControlMessage {
  kind: 'control';
  view: GatewayControlView;
}

/** A reset was requested: every screen shows "Resetting…" and reconnects when the gateway is back. */
export interface ResetMessage {
  kind: 'reset';
  startedAt: string;
  /** Set when the launcher could not be reached: screens drop the "Resetting…" overlay. */
  failed?: string;
}

/**
 * The presenter asked every screen to open (or close, paymentId null) the payment drawer.
 * POST /api/control/focus { paymentId: string | null }. UI-only: nothing goes on the event log.
 */
export interface FocusMessage {
  kind: 'focus';
  paymentId: string | null;
}

export type ServerMessage = SnapshotMessage | UpdateMessage | StatsMessage | ControlMessage | ResetMessage | FocusMessage;

/** One WebSocket frame: a single message or a batch (array) of messages, in order. */
export type ServerFrame = ServerMessage | ServerMessage[];
