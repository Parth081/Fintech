// Exact decimal money math for the stubs. No floats ever touch an amount.
import { exponentOf, type Money } from '@ct/contracts';

/** A decimal as an integer `units` scaled by 10^scale (e.g. "83.2500" -> {units: 832500n, scale: 4}). */
export interface Decimal {
  units: bigint;
  scale: number;
}

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

/** Customer rate: mid rate reduced by `spreadBps` (the customer receives fewer target units). Exact. */
export function applySpread(midRate: string, spreadBps: number): Decimal {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) throw new Error(`bad spreadBps ${spreadBps}`);
  const mid = parseDecimal(midRate);
  return { units: mid.units * BigInt(10_000 - spreadBps), scale: mid.scale + 4 };
}

/**
 * Convert a source amount at `rate` (target units per 1 source unit) into target minor units.
 * Rounds down (floor) so the platform never pays out more than it quoted.
 */
export function convert(source: Money, rate: Decimal, targetCurrency: string): Money {
  const srcExp = exponentOf(source.currency);
  const tgtExp = exponentOf(targetCurrency);
  const numerator = BigInt(source.amountMinor) * rate.units * 10n ** BigInt(tgtExp);
  const denominator = 10n ** BigInt(rate.scale + srcExp);
  const amountMinor = Number(numerator / denominator); // BigInt division truncates = floor for positives
  return { amountMinor, currency: targetCurrency };
}

/** Basis-point fee on an amount, rounded half-up, with a floor in minor units. */
export function bpsFee(amount: Money, bps: number, minMinor: number): Money {
  const raw = (BigInt(amount.amountMinor) * BigInt(bps) + 5_000n) / 10_000n;
  return { amountMinor: Math.max(minMinor, Number(raw)), currency: amount.currency };
}
