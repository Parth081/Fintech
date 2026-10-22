// Simulated FX market. The mid rate is a pure function of (corridor, time, seed): no history is
// iterated, so any timestamp (past or future) is O(1) and every process computes the same number.
//
// Model: mid(t) = base * (1 + deviation(t)), where base is the corridor midRate from CORRIDORS and
// deviation is a sum of "octaves" of smooth value noise. Each octave hashes (seed, corridor, octave,
// k) to a value in [-1, 1] at its tick boundaries k*period and interpolates between neighbours
// with smoothstep, so the curve is continuous with a continuous slope. Long octaves give the
// intraday trend, short ones the jitter. |deviation| <= sum of amplitudes = 139 bps (< 1.5%).
// Typical movement is a few bps per minute. Time resolution is 1 s: the rate for t is the rate at
// floor(t / 1000) * 1000, and that tick is returned as atMs (= rateTimestamp of a quote).
// Floats are used only for the noise shape (IEEE + - * / only, no Math.sin, so results are
// bit-identical everywhere); the decimal string is produced with exact BigInt math.
import { corridorById } from '@ct/contracts/browser';
import { divRound, formatFixed, parseDecimal, rescale } from './decimal';
import { fnv1a, hashIndex, signedUnit } from './hash';

export const DEFAULT_SEED = 'control-tower';
/** Decimals of every market and customer rate string. */
export const RATE_SCALE = 6;
export const RATE_RESOLUTION_MS = 1000;

export interface NoiseOctave {
  periodMs: number;
  amplitudeBps: number;
}

export const RATE_OCTAVES: readonly NoiseOctave[] = [
  { periodMs: 4 * 3_600_000, amplitudeBps: 80 }, // intraday trend
  { periodMs: 3_600_000, amplitudeBps: 40 },
  { periodMs: 900_000, amplitudeBps: 15 },
  { periodMs: 180_000, amplitudeBps: 3 },
  { periodMs: 30_000, amplitudeBps: 1 }, // tick jitter
];

/** Upper bound of |deviation| without shocks (bps). */
export const MAX_DEVIATION_BPS = RATE_OCTAVES.reduce((s, o) => s + o.amplitudeBps, 0);
/** Hard clamp of |deviation| with shocks (bps). */
export const MAX_SHOCKED_DEVIATION_BPS = 1_000;
/** Octaves at or below this period are amplified by a shock's noiseMultiplier. */
export const SHOCK_NOISE_MAX_PERIOD_MS = 900_000;

/**
 * Volatility shock window (M3 hook; none are active by default). During [fromMs, toMs) the mid is
 * pushed by up to `driftBps` (signed) and the short-horizon noise is multiplied by
 * `noiseMultiplier`, both shaped by an envelope that ramps in over the first 15% of the window and
 * out over the last 35%. Every process that prices or charts rates must see the same shocks for
 * results to agree, so M3 should distribute them through config or the event log and either pass
 * them explicitly or call setVolatilityShocks() at start-up.
 */
export interface VolatilityShock {
  id?: string;
  /** Omit to shock every corridor. */
  corridorId?: string;
  fromMs: number;
  toMs: number;
  driftBps?: number;
  noiseMultiplier?: number;
}

let shockRegistry: readonly VolatilityShock[] = [];

/** Replace the process-wide default shock list (used when rateAt/quote get no explicit `shocks`). */
export function setVolatilityShocks(shocks: readonly VolatilityShock[]): void {
  shockRegistry = [...shocks];
}
export function getVolatilityShocks(): readonly VolatilityShock[] {
  return shockRegistry;
}
export function clearVolatilityShocks(): void {
  shockRegistry = [];
}

const keyCache = new Map<string, number>();
function octaveKey(seed: string, corridorId: string, octave: number): number {
  const k = `${seed}|${corridorId}|${octave}`;
  let v = keyCache.get(k);
  if (v === undefined) {
    v = fnv1a(k);
    if (keyCache.size > 10_000) keyCache.clear();
    keyCache.set(k, v);
  }
  return v;
}

const smoothstep = (x: number) => x * x * (3 - 2 * x);

function octaveValue(key: number, periodMs: number, t: number): number {
  const k = Math.floor(t / periodMs);
  const frac = (t - k * periodMs) / periodMs;
  const v0 = signedUnit(hashIndex(key, k));
  const v1 = signedUnit(hashIndex(key, k + 1));
  return v0 + (v1 - v0) * smoothstep(frac);
}

function shockEnvelope(s: VolatilityShock, t: number): number {
  if (!(t >= s.fromMs && t < s.toMs)) return 0;
  const span = s.toMs - s.fromMs;
  const x = (t - s.fromMs) / span;
  if (x < 0.15) return smoothstep(x / 0.15);
  if (x > 0.65) return smoothstep((1 - x) / 0.35);
  return 1;
}

/** Deviation from the corridor base, in bps (float). Exported for tests and charts. */
export function deviationBps(corridorId: string, tickMs: number, seed: string, shocks: readonly VolatilityShock[] = shockRegistry): number {
  let base = 0;
  let shortNoise = 0;
  RATE_OCTAVES.forEach((o, i) => {
    const v = o.amplitudeBps * octaveValue(octaveKey(seed, corridorId, i), o.periodMs, tickMs);
    base += v;
    if (o.periodMs <= SHOCK_NOISE_MAX_PERIOD_MS) shortNoise += v;
  });
  let extra = 0;
  for (const s of shocks) {
    if (s.corridorId !== undefined && s.corridorId !== corridorId) continue;
    const e = shockEnvelope(s, tickMs);
    if (e === 0) continue;
    extra += e * (s.driftBps ?? 0) + e * ((s.noiseMultiplier ?? 1) - 1) * shortNoise;
  }
  const total = base + extra;
  return Math.max(-MAX_SHOCKED_DEVIATION_BPS, Math.min(MAX_SHOCKED_DEVIATION_BPS, total));
}

export function tickOf(atMs: number): number {
  if (!Number.isFinite(atMs)) throw new Error(`bad timestamp ${atMs}`);
  return Math.floor(atMs / RATE_RESOLUTION_MS) * RATE_RESOLUTION_MS;
}

function baseUnits(corridorId: string): bigint {
  const corridor = corridorById(corridorId);
  if (!corridor) throw new Error(`unknown corridor ${corridorId}`);
  return rescale(parseDecimal(corridor.midRate), RATE_SCALE).units;
}

/** Mid in units of 10^-RATE_SCALE (exact, half-up). */
export function midUnitsAt(corridorId: string, atMs: number, seed = DEFAULT_SEED, shocks: readonly VolatilityShock[] = shockRegistry): { units: bigint; tickMs: number } {
  const tickMs = tickOf(atMs);
  const ppb = BigInt(Math.round(deviationBps(corridorId, tickMs, seed, shocks) * 100_000)); // 1 bp = 100,000 ppb
  const units = divRound(baseUnits(corridorId) * (1_000_000_000n + ppb), 1_000_000_000n, 'half-up');
  return { units, tickMs };
}

/** Market mid rate for a corridor at a moment, as a decimal string (target units per source unit). */
export function rateAt(
  corridorId: string,
  atMs: number,
  seed = DEFAULT_SEED,
  shocks: readonly VolatilityShock[] = shockRegistry,
): { corridorId: string; mid: string; atMs: number } {
  const { units, tickMs } = midUnitsAt(corridorId, atMs, seed, shocks);
  return { corridorId, mid: formatFixed({ units, scale: RATE_SCALE }, RATE_SCALE), atMs: tickMs };
}

export const MAX_SERIES_POINTS = 20_000;

/** Evenly spaced mid rates for charts (inclusive of both ends). */
export function rateSeries(
  corridorId: string,
  fromMs: number,
  toMs: number,
  stepMs: number,
  seed = DEFAULT_SEED,
  shocks: readonly VolatilityShock[] = shockRegistry,
): { atMs: number; mid: string }[] {
  if (!(stepMs > 0)) throw new Error(`stepMs must be > 0, got ${stepMs}`);
  if (toMs < fromMs) return [];
  const n = Math.floor((toMs - fromMs) / stepMs) + 1;
  if (n > MAX_SERIES_POINTS) throw new Error(`rateSeries would return ${n} points (max ${MAX_SERIES_POINTS}); use a larger step`);
  const out: { atMs: number; mid: string }[] = [];
  for (let i = 0; i < n; i++) {
    const at = fromMs + i * stepMs;
    out.push({ atMs: at, mid: rateAt(corridorId, at, seed, shocks).mid });
  }
  return out;
}
