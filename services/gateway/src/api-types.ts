// Wire types for the gateway HTTP API and WebSocket. Type-only imports so the web app can
// share them (`import type`) without pulling node code into the browser bundle.
import type { AnyEvent, Money, PaymentState, PaymentStatus } from '@ct/contracts/browser';

export interface PaymentSummary {
  paymentId: string;
  status: PaymentStatus;
  corridor: string;
  amount: Money;
  targetAmount?: Money;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
  /** Index of status in PIPELINE, or -1 for held/rejected. */
  stepIndex: number;
  /** Furthest PIPELINE index the payment reached (useful for held/rejected). */
  lastPipelineIndex: number;
  ledgerPosted: boolean;
  scenario?: string;
  /** Hold/reject reason. */
  reason?: string;
  /** initiated -> reconciled, once reconciled. */
  endToEndMs?: number;
}

export interface Stats {
  total: number;
  byStatus: Record<PaymentStatus, number>;
  reconciled: number;
  inFlight: number;
  held: number;
  rejected: number;
  /** Mean initiated -> reconciled time, null until something reconciles. */
  avgEndToEndMs: number | null;
  /** Events the state machine refused (diagnostics). */
  rejectedEvents: number;
}

export interface PaymentDetail {
  state: PaymentState;
  events: AnyEvent[];
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
}

export interface SnapshotMessage {
  kind: 'snapshot';
  payments: PaymentSummary[];
  stats: Stats;
}

export interface EventMessage {
  kind: 'event';
  event: AnyEvent;
  payment: PaymentSummary;
  stats: Stats;
}

export type ServerMessage = SnapshotMessage | EventMessage;

/** One WebSocket frame: a single message or a batch (array) of messages, in order. */
export type ServerFrame = ServerMessage | ServerMessage[];
