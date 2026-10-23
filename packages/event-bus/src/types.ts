import type { BusEvent } from '@ct/contracts';

export interface DeliveryMeta {
  /** Position of the event in the log (0-based, monotonically increasing). */
  offset: number;
}

export type EventHandler = (event: BusEvent, meta: DeliveryMeta) => Promise<void> | void;

export interface SubscribeOptions {
  /** Consumer group name. Each group keeps its own committed offset. One active consumer per group in M1. */
  group: string;
  /**
   * Where to start when the group has no committed offset (or always, when ephemeral):
   * 'earliest' = offset 0, 'latest' = only events published after subscribing. Default 'earliest'.
   */
  from?: 'earliest' | 'latest';
  /** Ephemeral subscriptions never commit offsets; they always start from `from`. Used by projections that rebuild in memory. */
  ephemeral?: boolean;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

/**
 * The event backbone contract. Semantics every implementation must honour:
 * - publish() resolves only after the event is durably appended; returns its offset.
 * - Events are delivered to a subscription in log order, one at a time: the next handler
 *   call starts only after the previous one resolved.
 * - At-least-once: the group's offset is committed after the handler resolves. If the handler
 *   throws, the event is retried (implementations may back off) — handlers must be idempotent.
 * - A single topic (PAYMENTS_TOPIC) carries the whole payment lifecycle.
 * - Publishing an event whose eventId is already in the log is a no-op that returns the existing
 *   offset (idempotent append), so retried publishes never create duplicates. (M2)
 */
export interface EventBus {
  /** Payment events and (M3) control events share one ordered log. */
  publish(event: BusEvent): Promise<DeliveryMeta>;
  /**
   * The offset the next published event will get (= number of events in the log). A consumer that has
   * processed every offset below head() has seen everything published before the call. (M2)
   */
  head(): Promise<number>;
  subscribe(options: SubscribeOptions, handler: EventHandler): Promise<Subscription>;
  close(): Promise<void>;
}
