// Exact decimal arithmetic for rates and money. BigInt only; no float ever touches an amount.
// Browser-safe. services/stages/src/fx-math.ts re-exports these.
import { exponentOf, type Money } from '@ct/contracts/browser';

/** A decimal as an integer `units` scaled by 10^scale (e.g. "83.2500" -> {units: 832500n, scale: 4}). */
export interface Decimal {
  units: bigint;
  scale: number;
}

export type Rounding = 'floor' | 'half-up';

export function parseDecimal(value: string): Decimal {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a non-negative decimal: "${value}"`);
  const frac = m[2] ?? '';
  return { units: BigInt(`${m[1]}${frac}`), scale: frac.length };
}

/** Render with at least `minScale` decimals, trailing zeros beyond that trimmed. */
export function formatDecimal(d: Decimal, minScale = 4): string {
  const digits = d.units.toString().padStart(d.scale + 1, '0');
  const intPart = digits.slice(0, digits.length - d.scale);
  let frac = digits.slice(digits.length - d.scale);
  while (frac.length > minScale && frac.endsWith('0')) frac = frac.slice(0, -1);
  while (frac.length < minScale) frac += '0';
  return frac.length ? `${intPart}.${frac}` : intPart;
}

/** Render with exactly `scale` decimals (rounding half-up if the value has more). */
export function formatFixed(d: Decimal, scale: number): string {
  const r = rescale(d, scale, 'half-up');
  const digits = r.units.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

/** Integer division of non-negative bigints with the given rounding. */
export function divRound(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error('divRound expects numerator >= 0 and denominator > 0');
  const q = numerator / denominator;
  if (rounding === 'floor') return q;
  return (numerator % denominator) * 2n >= denominator ? q + 1n : q;
}

/** Change the scale of a decimal (exact when growing, rounded when shrinking). */
export function rescale(d: Decimal, scale: number, rounding: Rounding = 'half-up'): Decimal {
  if (scale >= d.scale) return { units: d.units * 10n ** BigInt(scale - d.scale), scale };
  return { units: divRound(d.units, 10n ** BigInt(d.scale - scale), rounding), scale };
}

/** Customer rate: mid rate reduced by `spreadBps` (the customer receives fewer target units). Exact. */
export function applySpread(midRate: string, spreadBps: number): Decimal {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) throw new Error(`bad spreadBps ${spreadBps}`);
  const mid = parseDecimal(midRate);
  return { units: mid.units * BigInt(10_000 - spreadBps), scale: mid.scale + 4 };
}

/**
 * Convert a source amount at `rate` (target units per 1 source unit) into target minor units.
 * Default rounding is floor (the platform never pays out more than it quoted); the FX engine uses
 * 'half-up' on a rate already rounded to RATE_SCALE decimals.
 */
export function convert(source: Money, rate: Decimal, targetCurrency: string, rounding: Rounding = 'floor'): Money {
  if (!Number.isSafeInteger(source.amountMinor) || source.amountMinor < 0) throw new Error(`bad source amount ${source.amountMinor}`);
  const srcExp = exponentOf(source.currency);
  const tgtExp = exponentOf(targetCurrency);
  const numerator = BigInt(source.amountMinor) * rate.units * 10n ** BigInt(tgtExp);
  const denominator = 10n ** BigInt(rate.scale + srcExp);
  return { amountMinor: Number(divRound(numerator, denominator, rounding)), currency: targetCurrency };
}

/** Basis-point fee on an amount, rounded half-up, with a floor in minor units. */
export function bpsFee(amount: Money, bps: number, minMinor: number): Money {
  const raw = divRound(BigInt(amount.amountMinor) * BigInt(bps), 10_000n, 'half-up');
  return { amountMinor: Math.max(minMinor, Number(raw)), currency: amount.currency };
}

/** Fixed + basis-point fee (half-up), e.g. a provider fee schedule entry. */
export function scheduleFee(amount: Money, schedule: { fixedMinor: number; bps: number }): Money {
  const variable = divRound(BigInt(amount.amountMinor) * BigInt(schedule.bps), 10_000n, 'half-up');
  return { amountMinor: schedule.fixedMinor + Number(variable), currency: amount.currency };
}
