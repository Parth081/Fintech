// Simulated market: FX rates and provider behaviour. Browser-safe (no node: imports).
// SKELETON from the integrator: the market agent implements the functions and may extend the
// catalogue, but must keep these exported names and signatures (other agents code against them).
import type { PaymentState } from '@ct/contracts';

export interface ProviderProfile {
  id: string; // matches PROVIDERS in @ct/contracts
  name: string;
  rail: string;
  /** Per corridor fee schedule, charged in the source currency. */
  fees: Record<string, { fixedMinor: number; bps: number }>;
  /** Probability an instruction is accepted and settled (before PROVIDER_FAILURE_SCALE). */
  baseSuccessRate: number;
  latencyMs: { p50: number; p95: number };
  /** Fictional BIC used in ISO 20022 messages. */
  bic: string;
}

export const PROVIDER_CATALOG: readonly ProviderProfile[] = [
  {
    id: 'orion', name: 'Provider Orion', rail: 'Rail-A (instant)', bic: 'XORIUS33XXX',
    fees: { 'US-IN': { fixedMinor: 150, bps: 20 }, 'DE-BR': { fixedMinor: 200, bps: 25 }, 'GB-PH': { fixedMinor: 150, bps: 22 } },
    baseSuccessRate: 0.97, latencyMs: { p50: 900, p95: 2500 },
  },
  {
    id: 'lyra', name: 'Provider Lyra', rail: 'Rail-B (same day)', bic: 'XLYRGB2LXXX',
    fees: { 'US-IN': { fixedMinor: 90, bps: 12 }, 'GB-PH': { fixedMinor: 80, bps: 10 } },
    baseSuccessRate: 0.93, latencyMs: { p50: 4000, p95: 12000 },
  },
  {
    id: 'vega', name: 'Provider Vega', rail: 'Rail-C (correspondent)', bic: 'XVEGDEFFXXX',
    fees: { 'US-IN': { fixedMinor: 300, bps: 8 }, 'DE-BR': { fixedMinor: 250, bps: 9 }, 'GB-PH': { fixedMinor: 300, bps: 8 } },
    baseSuccessRate: 0.99, latencyMs: { p50: 15000, p95: 40000 },
  },
];

export function providerProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/** Market mid rate for a corridor at a moment, as a decimal string (target units per source unit). */
export function rateAt(corridorId: string, atMs: number, seed = 'control-tower'): { corridorId: string; mid: string; atMs: number } {
  void corridorId; void atMs; void seed;
  throw new Error('rateAt not implemented yet (market agent)');
}

/** Evenly spaced mid rates for charts. */
export function rateSeries(corridorId: string, fromMs: number, toMs: number, stepMs: number, seed = 'control-tower'): { atMs: number; mid: string }[] {
  void corridorId; void fromMs; void toMs; void stepMs; void seed;
  throw new Error('rateSeries not implemented yet (market agent)');
}

export interface ProviderHealth {
  providerId: string;
  attempts: number;
  settled: number;
  failed: number;
  successRate: number; // observed, blended with the catalogue prior
  avgLatencyMs: number | null; // sent -> settled, observed
}

/** Observed provider health from projected payment states. */
export function providerHealth(states: Iterable<PaymentState>, providerId: string): ProviderHealth {
  void states; void providerId;
  throw new Error('providerHealth not implemented yet (market agent)');
}
