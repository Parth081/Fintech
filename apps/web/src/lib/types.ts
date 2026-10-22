// Wire types shared with the gateway (type-only import: nothing from node ends up in the bundle).
export type {
  PaymentSummary,
  Stats,
  PaymentDetail,
  ServerMessage,
  ServerFrame,
  SnapshotMessage,
  EventMessage,
} from '../../../../services/gateway/src/api-types';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';
