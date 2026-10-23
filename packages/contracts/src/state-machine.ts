import type { AnyEvent, EventType, PayloadMap, PaymentStatus } from './events';
import { isBalanced } from './money';

/** Happy-path order, used by the UI and by tests. */
export const PIPELINE: readonly PaymentStatus[] = [
  'initiated',
  'screened',
  'scored',
  'quoted',
  'routed',
  'sent',
  'settled',
  'reconciled',
];

export const TERMINAL_STATUSES: readonly PaymentStatus[] = ['reconciled', 'held', 'rejected', 'failed'];

const PRE_APPROVAL: PaymentStatus[] = ['initiated', 'screened', 'scored'];

/** event type -> allowed "from" statuses (null = no prior state) and resulting status (null = no status change). */
export const TRANSITIONS: Record<EventType, { from: (PaymentStatus | null)[]; to: PaymentStatus | null }> = {
  'payment.initiated': { from: [null], to: 'initiated' },
  'payment.screened': { from: ['initiated'], to: 'screened' },
  'payment.scored': { from: ['screened'], to: 'scored' },
  'payment.quoted': { from: ['scored'], to: 'quoted' },
  'payment.routed': { from: ['quoted', 'retrying'], to: 'routed' },
  'payment.sent': { from: ['routed'], to: 'sent' },
  'payment.send_failed': { from: ['sent'], to: 'retrying' },
  'payment.failed': { from: ['retrying'], to: 'failed' },
  'payment.settled': { from: ['sent'], to: 'settled' },
  'ledger.posted': { from: ['settled'], to: null },
  'payment.reconciled': { from: ['settled'], to: 'reconciled' },
  'payment.held': { from: PRE_APPROVAL, to: 'held' },
  'payment.rejected': { from: PRE_APPROVAL, to: 'rejected' },
};

export interface PaymentHistoryItem {
  eventId: string;
  type: EventType;
  occurredAt: string;
  status: PaymentStatus;
}

export interface PaymentState {
  paymentId: string;
  status: PaymentStatus;
  initiated: PayloadMap['payment.initiated'];
  createdAt: string;
  updatedAt: string;
  ledgerPosted: boolean;
  /** Latest payload seen for each event type. */
  facts: Partial<{ [K in EventType]: PayloadMap[K] }>;
  history: PaymentHistoryItem[];
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly paymentId: string,
    readonly eventType: EventType,
    readonly fromStatus: PaymentStatus | null,
    detail?: string,
  ) {
    super(`Invalid transition for payment ${paymentId}: ${eventType} from ${fromStatus ?? 'none'}${detail ? ` (${detail})` : ''}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canApply(state: PaymentState | undefined, event: AnyEvent): boolean {
  try {
    applyEvent(state, event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure reducer. Returns a new state; never mutates its input.
 * Idempotent: an event whose eventId is already in history returns the state unchanged.
 * Throws InvalidTransitionError for illegal transitions.
 */
export function applyEvent(state: PaymentState | undefined, event: AnyEvent): PaymentState {
  if (state && state.paymentId !== event.paymentId) {
    throw new InvalidTransitionError(event.paymentId, event.type, state.status, 'paymentId mismatch');
  }
  if (state?.history.some((h) => h.eventId === event.eventId)) return state;

  const rule = TRANSITIONS[event.type];
  const from = state ? state.status : null;
  if (!rule.from.includes(from)) throw new InvalidTransitionError(event.paymentId, event.type, from);

  if (event.type === 'payment.initiated') {
    return {
      paymentId: event.paymentId,
      status: 'initiated',
      initiated: event.payload,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      ledgerPosted: false,
      facts: { 'payment.initiated': event.payload },
      history: [{ eventId: event.eventId, type: event.type, occurredAt: event.occurredAt, status: 'initiated' }],
    };
  }

  const prev = state as PaymentState;
  if (event.type === 'ledger.posted') {
    if (prev.ledgerPosted) throw new InvalidTransitionError(event.paymentId, event.type, from, 'ledger already posted');
    if (!isBalanced(event.payload.entries)) {
      throw new InvalidTransitionError(event.paymentId, event.type, from, 'journal entries are not balanced');
    }
  }
  if (event.type === 'payment.reconciled' && !prev.ledgerPosted) {
    throw new InvalidTransitionError(event.paymentId, event.type, from, 'ledger not posted yet');
  }

  const status = rule.to ?? prev.status;
  return {
    ...prev,
    status,
    updatedAt: event.occurredAt,
    ledgerPosted: prev.ledgerPosted || event.type === 'ledger.posted',
    facts: { ...prev.facts, [event.type]: event.payload },
    history: [...prev.history, { eventId: event.eventId, type: event.type, occurredAt: event.occurredAt, status }],
  };
}

/** Fold a sequence of events (any order of payments) into a map of states. Invalid events are reported, not thrown. */
/** Fold events into payment states. Control events (M3) on the same log are skipped, never rejected. */
export function project(
  events: Iterable<AnyEvent | { type: `control.${string}`; paymentId: string }>,
  initial: Map<string, PaymentState> = new Map(),
): { states: Map<string, PaymentState>; rejected: { event: AnyEvent; error: string }[] } {
  const states = new Map(initial);
  const rejected: { event: AnyEvent; error: string }[] = [];
  for (const e of events) {
    if (e.type.startsWith('control.')) continue;
    const event = e as AnyEvent;
    try {
      states.set(event.paymentId, applyEvent(states.get(event.paymentId), event));
    } catch (err) {
      rejected.push({ event, error: (err as Error).message });
    }
  }
  return { states, rejected };
}

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
