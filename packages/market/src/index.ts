// Simulated market: FX rates, pricing, provider catalogue, provider health and routing scores.
// Browser-safe (no node: imports; only @ct/contracts/browser at runtime). Same seed = same numbers
// in every process.
export { PROVIDER_CATALOG, providerProfile, priorSuccessRate, type ProviderProfile } from './catalog';
export {
  DEFAULT_SEED,
  RATE_SCALE,
  RATE_RESOLUTION_MS,
  RATE_OCTAVES,
  MAX_DEVIATION_BPS,
  MAX_SHOCKED_DEVIATION_BPS,
  MAX_SERIES_POINTS,
  rateAt,
  rateSeries,
  midUnitsAt,
  deviationBps,
  tickOf,
  setVolatilityShocks,
  getVolatilityShocks,
  clearVolatilityShocks,
  type NoiseOctave,
  type VolatilityShock,
} from './rates';
export {
  PRICING_VERSION,
  QUOTE_TTL_MS,
  MIN_SPREAD_BPS,
  DEFAULT_BASE_SPREAD_BPS,
  CORRIDOR_BASE_SPREAD_BPS,
  AMOUNT_TIERS,
  VOL_LOOKBACK_MS,
  VOL_SAMPLE_MS,
  VOL_ADDON_CAP_BPS,
  amountTier,
  recentRangeBps,
  volatilityAddOnBps,
  quote,
  type AmountTier,
  type Quote,
  type QuoteRequest,
} from './pricing';
export {
  HEALTH_PRIOR_WEIGHT,
  attemptsOf,
  providerHealth,
  providerHealthAll,
  type AttemptRecord,
  type HealthOptions,
  type ProviderHealth,
} from './health';
export {
  DEFAULT_ROUTING_WEIGHTS,
  FAILURE_SPAN,
  LATENCY_PRIOR_WEIGHT,
  EXCLUDED_CORRIDOR_NOT_SERVED,
  EXCLUDED_FAILED_THIS_PAYMENT,
  compareScores,
  scoreProviders,
  type RoutingWeights,
  type ScoreInput,
} from './routing';
export * from './decimal';
