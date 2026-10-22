// FX pricing policy. Customer spread (bps, charged by lowering the rate the customer gets):
//
//   spreadBps = max(MIN_SPREAD_BPS, base[corridor] + tier adjustment + volatility add-on)
//
// - base: per corridor (CORRIDOR_BASE_SPREAD_BPS): US-IN 35, DE-BR 45, GB-PH 40.
// - tier (source amount in major units): retail < 1,000: +10; standard < 10,000: 0;
//   business < 100,000: -10; corporate >= 100,000: -20. Bigger tickets are cheaper.
// - volatility add-on: half the high-low range of the mid over the last 5 minutes (sampled every
//   minute, 6 points, exact bps, floored), capped at 30 bps. Calm market: 0-3 bps.
//
// Customer rate = mid * (1 - spreadBps / 10,000), rounded half-up to RATE_SCALE (6) decimals.
// Target amount = sourceAmount * rate (that published rate, so anyone can recompute it), rounded
// half-up to target minor units. All money math is BigInt.
import { corridorById, exponentOf, type Money } from '@ct/contracts/browser';
import { convert, formatFixed, rescale, applySpread } from './decimal';
import { DEFAULT_SEED, midUnitsAt, RATE_SCALE, type VolatilityShock, getVolatilityShocks } from './rates';

export const PRICING_VERSION = 'fx-engine-v1';
export const QUOTE_TTL_MS = 30_000;
export const MIN_SPREAD_BPS = 5;
export const DEFAULT_BASE_SPREAD_BPS = 50;
export const CORRIDOR_BASE_SPREAD_BPS: Readonly<Record<string, number>> = { 'US-IN': 35, 'DE-BR': 45, 'GB-PH': 40 };

export interface AmountTier {
  id: 'retail' | 'standard' | 'business' | 'corporate';
  /** Lower bound, inclusive, in major units of the source currency. */
  minMajor: number;
  adjustmentBps: number;
}

export const AMOUNT_TIERS: readonly AmountTier[] = [
  { id: 'retail', minMajor: 0, adjustmentBps: 10 },
  { id: 'standard', minMajor: 1_000, adjustmentBps: 0 },
  { id: 'business', minMajor: 10_000, adjustmentBps: -10 },
  { id: 'corporate', minMajor: 100_000, adjustmentBps: -20 },
];

export const VOL_LOOKBACK_MS = 300_000;
export const VOL_SAMPLE_MS = 60_000;
export const VOL_ADDON_CAP_BPS = 30;

export function amountTier(amount: Money): AmountTier {
  const minorPerMajor = 10n ** BigInt(exponentOf(amount.currency));
  let chosen = AMOUNT_TIERS[0]!;
  for (const t of AMOUNT_TIERS) if (BigInt(amount.amountMinor) >= BigInt(t.minMajor) * minorPerMajor) chosen = t;
  return chosen;
}

/** High-low range of the mid over the lookback window, in whole bps of the current mid (floored). */
export function recentRangeBps(corridorId: string, atMs: number, seed = DEFAULT_SEED, shocks: readonly VolatilityShock[] = getVolatilityShocks()): number {
  const now = midUnitsAt(corridorId, atMs, seed, shocks).units;
  let min = now;
  let max = now;
  for (let back = VOL_SAMPLE_MS; back <= VOL_LOOKBACK_MS; back += VOL_SAMPLE_MS) {
    const u = midUnitsAt(corridorId, atMs - back, seed, shocks).units;
    if (u < min) min = u;
    if (u > max) max = u;
  }
  return Number(((max - min) * 10_000n) / now);
}

export function volatilityAddOnBps(rangeBps: number): number {
  return Math.min(VOL_ADDON_CAP_BPS, Math.floor(rangeBps / 2));
}

export interface QuoteRequest {
  corridorId: string;
  sourceAmount: Money;
  atMs: number;
  seed?: string;
  shocks?: readonly VolatilityShock[];
}

export interface Quote {
  corridorId: string;
  sourceAmount: Money;
  targetAmount: Money;
  midRate: string;
  rate: string;
  spreadBps: number;
  components: { baseBps: number; tierAdjustmentBps: number; volatilityBps: number };
  tier: AmountTier['id'];
  recentRangeBps: number;
  /** ISO time of the 1-second market tick used. */
  rateTimestamp: string;
  expiresAt: string;
}

export function quote(req: QuoteRequest): Quote {
  const corridor = corridorById(req.corridorId);
  if (!corridor) throw new Error(`unknown corridor ${req.corridorId}`);
  if (req.sourceAmount.currency !== corridor.sourceCurrency) {
    throw new Error(`corridor ${corridor.id} sells ${corridor.sourceCurrency}, got ${req.sourceAmount.currency}`);
  }
  if (!Number.isSafeInteger(req.sourceAmount.amountMinor) || req.sourceAmount.amountMinor <= 0) {
    throw new Error(`source amount must be a positive integer, got ${req.sourceAmount.amountMinor}`);
  }
  const seed = req.seed ?? DEFAULT_SEED;
  const shocks = req.shocks ?? getVolatilityShocks();
  const { units, tickMs } = midUnitsAt(corridor.id, req.atMs, seed, shocks);
  const midRate = formatFixed({ units, scale: RATE_SCALE }, RATE_SCALE);

  const baseBps = CORRIDOR_BASE_SPREAD_BPS[corridor.id] ?? DEFAULT_BASE_SPREAD_BPS;
  const tier = amountTier(req.sourceAmount);
  const rangeBps = recentRangeBps(corridor.id, req.atMs, seed, shocks);
  const volatilityBps = volatilityAddOnBps(rangeBps);
  const spreadBps = Math.max(MIN_SPREAD_BPS, baseBps + tier.adjustmentBps + volatilityBps);

  const rateDec = rescale(applySpread(midRate, spreadBps), RATE_SCALE, 'half-up');
  const targetAmount = convert(req.sourceAmount, rateDec, corridor.targetCurrency, 'half-up');
  return {
    corridorId: corridor.id,
    sourceAmount: { ...req.sourceAmount },
    targetAmount,
    midRate,
    rate: formatFixed(rateDec, RATE_SCALE),
    spreadBps,
    components: { baseBps, tierAdjustmentBps: tier.adjustmentBps, volatilityBps },
    tier: tier.id,
    recentRangeBps: rangeBps,
    rateTimestamp: new Date(tickMs).toISOString(),
    expiresAt: new Date(req.atMs + QUOTE_TTL_MS).toISOString(),
  };
}
