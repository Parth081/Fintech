// Fictional corridors, providers and rails. Never use real brand names (see design doc).

export interface Corridor {
  id: string;
  sourceCountry: string;
  targetCountry: string;
  sourceCurrency: string;
  targetCurrency: string;
  /** Simulated mid-market rate: target units per 1 source unit, as a decimal string. */
  midRate: string;
}

export const CORRIDORS: readonly Corridor[] = [
  { id: 'US-IN', sourceCountry: 'US', targetCountry: 'IN', sourceCurrency: 'USD', targetCurrency: 'INR', midRate: '83.2500' },
  { id: 'DE-BR', sourceCountry: 'DE', targetCountry: 'BR', sourceCurrency: 'EUR', targetCurrency: 'BRL', midRate: '5.9100' },
  { id: 'GB-PH', sourceCountry: 'GB', targetCountry: 'PH', sourceCurrency: 'GBP', targetCurrency: 'PHP', midRate: '72.4000' },
];

export interface Provider {
  id: string;
  name: string;
  rail: string;
  corridors: string[];
}

export const PROVIDERS: readonly Provider[] = [
  { id: 'orion', name: 'Provider Orion', rail: 'Rail-A (instant)', corridors: ['US-IN', 'DE-BR', 'GB-PH'] },
  { id: 'lyra', name: 'Provider Lyra', rail: 'Rail-B (same day)', corridors: ['US-IN', 'GB-PH'] },
  { id: 'vega', name: 'Provider Vega', rail: 'Rail-C (correspondent)', corridors: ['US-IN', 'DE-BR', 'GB-PH'] },
];

export function corridorById(id: string): Corridor | undefined {
  return CORRIDORS.find((c) => c.id === id);
}
