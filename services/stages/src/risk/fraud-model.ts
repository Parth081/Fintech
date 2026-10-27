// Explainable fraud model: logistic regression with FIXED coefficients (no training at runtime).
//
//   z = intercept + sum_i weight_i * x_i          score = 1 / (1 + e^-z)
//
// Every feature value x_i is in [0, ~1.5] and has a plain-English explanation; contribution_i = weight_i * x_i
// is what the alert shows as the reason's weight (log-odds points). History features use only payments
// before the trigger (see history.ts).
import type { PaymentRecord } from './history';

export const FRAUD_MODEL_VERSION = 'fraud-lr-v1';

/** Amount (source-currency major units) at which local cash/transfer reporting applies in the demo. */
export const REPORTING_THRESHOLD_MAJOR = 10_000;
/** "Just below a threshold" = within this fraction under it. */
export const JUST_BELOW_BAND = 0.1;
export const VELOCITY_WINDOW_MS = 10 * 60_000;

export const FRAUD_MODEL = {
  intercept: -2.6,
  weights: {
    AMOUNT_VS_HISTORY: 2.6,
    VELOCITY: 1.2,
    NEW_BENEFICIARY: 0.5,
    CORRIDOR_RISK: 1.0,
    ROUND_AMOUNT: 0.6,
    ODD_HOUR: 0.4,
    FIRST_TIME_SENDER: 0.6,
    JUST_BELOW_THRESHOLD: 1.4,
    LARGE_AMOUNT: 1.1,
  },
} as const;
export type FraudFeature = keyof typeof FRAUD_MODEL.weights;

/** Inherent corridor risk (0..1) from the (fictional) country-risk assessment. */
export const CORRIDOR_RISK: Readonly<Record<string, number>> = { 'US-IN': 0.3, 'GB-PH': 0.4, 'DE-BR': 0.5 };
const DEFAULT_CORRIDOR_RISK = 0.6;

/** Standard UTC offsets (hours) by country, for the sender's local hour. */
export const UTC_OFFSET_HOURS: Readonly<Record<string, number>> = { US: -5, GB: 0, DE: 1, IN: 5.5, BR: -3, PH: 8 };

export interface FraudInput {
  payment: PaymentRecord;
  debtorCountry: string;
  /** Payments before the trigger. */
  history: readonly PaymentRecord[];
  /** Anchor time for the windows. */
  atMs: number;
  manualReviewAboveUsd: number;
}

export interface FeatureValue {
  code: FraudFeature;
  value: number;
  weight: number;
  contribution: number;
  text: string;
}

export interface FraudResult {
  model: typeof FRAUD_MODEL_VERSION;
  score: number; // 0..1, 4 dp
  logit: number;
  intercept: number;
  features: FeatureValue[]; // every feature, model order
  /** Features that moved the score up, largest first (the alert's reasons). */
  reasons: { code: string; text: string; weight: number }[];
  facts: Record<string, unknown>;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const fmtUsd = (x: number) => `USD ${Math.round(x).toLocaleString('en-US')}`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Which threshold (if any) the amount sits just below. */
export function justBelowThreshold(p: Pick<PaymentRecord, 'major' | 'usd' | 'amount'>, manualReviewAboveUsd: number): string | null {
  const T = REPORTING_THRESHOLD_MAJOR;
  if (p.major >= T * (1 - JUST_BELOW_BAND) && p.major < T) return `${p.amount.currency} ${T.toLocaleString('en-US')} reporting line`;
  const M = manualReviewAboveUsd;
  if (M > 0 && p.usd >= M * (1 - JUST_BELOW_BAND) && p.usd < M) return `${fmtUsd(M)} manual-review threshold`;
  return null;
}

export function localHour(atMs: number, country: string): number {
  const h = new Date(atMs).getUTCHours() + new Date(atMs).getUTCMinutes() / 60 + (UTC_OFFSET_HOURS[country] ?? 0);
  return ((h % 24) + 24) % 24;
}

export function scoreFraud(input: FraudInput): FraudResult {
  const { payment: p, history, atMs } = input;
  const W = FRAUD_MODEL.weights;
  const prior = history.filter((h) => h.debtorAccount === p.debtorAccount);
  const firstTime = prior.length === 0;
  const newBeneficiary = !prior.some((h) => h.creditorAccount === p.creditorAccount);
  const recent = prior.filter((h) => h.atMs > atMs - VELOCITY_WINDOW_MS);
  const typical = prior.length >= 3 ? median(prior.map((h) => h.usd)) : null;
  const ratio = typical && typical > 0 ? p.usd / typical : null;
  const corridorRisk = CORRIDOR_RISK[p.corridor] ?? DEFAULT_CORRIDOR_RISK;
  const wholeMajor = Number.isInteger(p.major);
  const round = wholeMajor && p.major >= 1000 && p.major % 1000 === 0 ? 1 : wholeMajor && p.major >= 100 && p.major % 100 === 0 ? 0.5 : 0;
  const hour = localHour(p.atMs, input.debtorCountry);
  const below = justBelowThreshold(p, input.manualReviewAboveUsd);

  const f = (code: FraudFeature, value: number, text: string): FeatureValue => ({ code, value: r4(value), weight: W[code], contribution: r4(W[code] * value), text });
  const features: FeatureValue[] = [
    f('AMOUNT_VS_HISTORY', ratio ? clamp(Math.log10(ratio), 0, 1) : 0,
      ratio ? `Amount is ${ratio.toFixed(1)}x this sender's usual payment (median ${fmtUsd(typical!)} over ${prior.length} payments)` : 'Not enough sender history to compare the amount'),
    f('VELOCITY', clamp((recent.length - 2) / 6, 0, 1), `${recent.length} other payment(s) from this sender in the last ${VELOCITY_WINDOW_MS / 60_000} minutes`),
    f('NEW_BENEFICIARY', newBeneficiary ? 1 : 0, newBeneficiary ? 'First payment from this sender to this beneficiary' : 'Sender has paid this beneficiary before'),
    f('CORRIDOR_RISK', corridorRisk, `Corridor ${p.corridor} carries inherent risk ${corridorRisk.toFixed(1)}`),
    f('ROUND_AMOUNT', round, round === 1 ? 'Round amount (whole thousands)' : round ? 'Round amount (whole hundreds)' : 'Amount is not round'),
    f('ODD_HOUR', hour < 5 ? 1 : 0, `Sent at ${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')} sender local time${hour < 5 ? ' (unusual hour)' : ''}`),
    f('FIRST_TIME_SENDER', firstTime ? 1 : 0, firstTime ? 'Sender account has no payment history' : `Sender has ${prior.length} earlier payment(s)`),
    f('JUST_BELOW_THRESHOLD', below ? 1 : 0, below ? `Amount kept just below the ${below}` : 'Amount is not just below a threshold'),
    f('LARGE_AMOUNT', clamp(Math.log10(Math.max(p.usd, 1) / 1000), 0, 1.5), `Payment of about ${fmtUsd(p.usd)}`),
  ];
  const logit = FRAUD_MODEL.intercept + features.reduce((s, x) => s + x.contribution, 0);
  const score = r4(1 / (1 + Math.exp(-logit)));
  const reasons = features
    .filter((x) => x.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || (a.code < b.code ? -1 : 1))
    .map((x) => ({ code: x.code, text: x.text, weight: Math.round(x.contribution * 100) / 100 }));
  return {
    model: FRAUD_MODEL_VERSION,
    score,
    logit: r4(logit),
    intercept: FRAUD_MODEL.intercept,
    features,
    reasons,
    facts: { priorPayments: prior.length, recentPayments: recent.length, typicalUsd: typical, amountUsd: p.usd, localHour: r4(hour) },
  };
}
