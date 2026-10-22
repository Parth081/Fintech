// Wire protocol between the local broker and LocalBrokerBus clients. One JSON object per WebSocket
// text frame. See ../README.md for the narrative description. The client in
// packages/event-bus/src/local-broker-bus.ts mirrors these shapes (it cannot import from a service).

export const PROTOCOL_VERSION = 1;

// ---- client -> broker ----
export type ClientMessage =
  | { op: 'hello'; clientId: string; protocol: number }
  | { op: 'publish'; reqId: number; event: unknown; retry?: boolean }
  | {
      op: 'subscribe';
      reqId: number;
      subId: number;
      group: string;
      from: 'earliest' | 'latest';
      ephemeral: boolean;
      /** Explicit start offset; used when resubscribing after a reconnect (next offset the client still needs). */
      position?: number;
      /** Initial flow-control window: how many deliveries the broker may send before more credit arrives. */
      credit: number;
    }
  | { op: 'credit'; subId: number; n: number }
  | { op: 'commit'; subId: number; offset: number }
  | { op: 'unsubscribe'; reqId: number; subId: number };

// ---- broker -> client ----
export type BrokerMessage =
  | { op: 'welcome'; protocol: number; length: number }
  | { op: 'ack'; reqId: number; offset: number; duplicate?: boolean }
  | { op: 'subscribed'; reqId: number; subId: number; start: number }
  | { op: 'unsubscribed'; reqId: number; subId: number }
  | { op: 'deliver'; subId: number; offset: number; event: unknown }
  | { op: 'error'; reqId?: number; message: string };
