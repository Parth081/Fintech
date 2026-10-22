// Fictional provider catalogue (no real brands). Settlement, routing and the UI all read it from here.

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

/** Catalogue success probability after PROVIDER_FAILURE_SCALE (failure probability scaled, clamped to [0, 1]). */
export function priorSuccessRate(profile: ProviderProfile, failureScale = 1): number {
  const scale = Number.isFinite(failureScale) && failureScale >= 0 ? failureScale : 1;
  return Math.min(1, Math.max(0, 1 - (1 - profile.baseSuccessRate) * scale));
}
