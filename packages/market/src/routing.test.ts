import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@ct/contracts/browser';
import { DEFAULT_ROUTING_WEIGHTS, PROVIDER_CATALOG, scoreProviders, type ProviderHealth } from './index';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });
const pick = (rows: ReturnType<typeof scoreProviders>) => rows.map((r) => [r.providerId, r.score, r.fee.amountMinor, r.excludedReason ?? null]);

describe('provider catalogue', () => {
  it('matches the contracts provider list (ids, rails, corridors served)', () => {
    expect(PROVIDER_CATALOG.map((p) => p.id)).toEqual(PROVIDERS.map((p) => p.id));
    for (const p of PROVIDER_CATALOG) {
      const c = PROVIDERS.find((x) => x.id === p.id)!;
      expect(p.rail).toBe(c.rail);
      expect(Object.keys(p.fees).sort()).toEqual([...c.corridors].sort());
    }
  });
});

describe('scoreProviders', () => {
  it('scores all three providers, best first (worked example: US-IN 1,250.00 USD)', () => {
    // fees: orion 150 + 20bps = 400, lyra 90 + 12bps = 240, vega 300 + 8bps = 400
    // orion = 0.5*0.8 + 0.3*0.6 + 0.2*1 = 0.78; vega = 0.5*1 + 0.3*0.6 + 0.2*0.06 = 0.692; lyra = 0.5*0.4 + 0.3*1 + 0.2*0.225 = 0.545
    const rows = scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(125_000) });
    expect(pick(rows)).toEqual([['orion', 0.78, 400, null], ['vega', 0.692, 400, null], ['lyra', 0.545, 240, null]]);
    expect(rows[0]).toMatchObject({ eligible: true, successRate: 0.97, latencyMs: 900, fee: usd(400) });
  });

  it('prefers the cheap reliable correspondent for big tickets', () => {
    const rows = scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(10_000_000) });
    expect(rows[0]!.providerId).toBe('vega');
    expect(rows[0]!.fee).toEqual(usd(8_300));
  });

  it('explains exclusions', () => {
    const rows = scoreProviders({ corridorId: 'DE-BR', sourceAmount: { amountMinor: 50_000, currency: 'EUR' }, excluded: ['orion'] });
    expect(pick(rows)).toEqual([['vega', 1, 295, null], ['orion', 0, 325, 'FAILED_THIS_PAYMENT'], ['lyra', 0, 0, 'CORRIDOR_NOT_SERVED']]);
    expect(rows.filter((r) => r.eligible).map((r) => r.providerId)).toEqual(['vega']);
    const none = scoreProviders({ corridorId: 'DE-BR', sourceAmount: { amountMinor: 50_000, currency: 'EUR' }, excluded: ['orion', 'vega'] });
    expect(none.every((r) => !r.eligible)).toBe(true);
  });

  it('reacts to observed health', () => {
    const sick: ProviderHealth = { providerId: 'orion', attempts: 300, settled: 150, failed: 150, successRate: 0.5, avgLatencyMs: 900 };
    const rows = scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(125_000), health: { orion: sick } });
    expect(rows[0]!.providerId).toBe('vega');
    expect(rows.find((r) => r.providerId === 'orion')!.successRate).toBe(0.5);
  });

  it('scores speed from the catalogue p50, not the simulated observed latency (M3)', () => {
    const slow: ProviderHealth = { providerId: 'orion', attempts: 45, settled: 45, failed: 0, successRate: 0.97, avgLatencyMs: 10_900 };
    const fastVega: ProviderHealth = { providerId: 'vega', attempts: 45, settled: 45, failed: 0, successRate: 0.99, avgLatencyMs: 300 };
    const rows = scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(125_000), health: { orion: slow, vega: fastVega } });
    expect(rows.find((r) => r.providerId === 'orion')!.latencyMs).toBe(900);
    expect(rows.find((r) => r.providerId === 'vega')!.latencyMs).toBe(15_000);
  });

  it('breaks ties deterministically (lower fee, then success, then id)', () => {
    const eq = { success: 0, cost: 0, speed: 1 };
    const h = (id: string): ProviderHealth => ({ providerId: id, attempts: 10, settled: 10, failed: 0, successRate: 0.95, avgLatencyMs: 1000 });
    const health = { orion: h('orion'), lyra: h('lyra'), vega: h('vega') };
    const a = scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(125_000), weights: eq, health: { ...health, orion: { ...h('orion'), avgLatencyMs: 900 } } });
    expect(a.map((r) => r.providerId)[0]).toBe('orion');
    // all equal except fee: lyra (240) wins over orion/vega (400); orion beats vega on id
    const same = { ...health };
    const b = scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(125_000), weights: { success: 1, cost: 0, speed: 0 }, health: same });
    expect(b.map((r) => r.providerId)).toEqual(['lyra', 'orion', 'vega']);
    expect(scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(125_000), weights: { success: 1, cost: 0, speed: 0 }, health: same })).toEqual(b);
  });

  it('documents default weights', () => {
    expect(DEFAULT_ROUTING_WEIGHTS).toEqual({ success: 0.5, cost: 0.3, speed: 0.2 });
    expect(() => scoreProviders({ corridorId: 'US-IN', sourceAmount: usd(1), weights: { success: 0, cost: 0, speed: 0 } })).toThrow();
  });
});
