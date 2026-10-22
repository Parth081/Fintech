// Wire types shared with the gateway (type-only import: nothing from node ends up in the bundle).
export type {
  PaymentSummary,
  Stats,
  Throughput,
  PaymentDetail,
  ServerMessage,
  ServerFrame,
  SnapshotMessage,
  UpdateMessage,
  StatsMessage,
  EventBrief,
  IsoMessage,
  FxCorridorRates,
  QuoteStats,
  ProviderView,
  ProviderFailure,
  StatementRef,
} from '../../../../services/gateway/src/api-types';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';
