import { describe, expect, it } from 'vitest';
import { CORRIDORS } from '@ct/contracts/browser';
import { amountTier, CORRIDOR_BASE_SPREAD_BPS, quote, recentRangeBps, VOL_ADDON_CAP_BPS, volatilityAddOnBps } from './index';

const T = Date.parse('2026-10-22T12:00:00.000Z');

describe('quote: worked examples (hand checked)', () => {
  it('US-IN 1,250.00 USD', () => {
    const q = quote({ corridorId: 'US-IN', sourceAmount: { amountMinor: 125_000, currency: 'USD' }, atMs: T + 400 });
    // mid 83.639339; spread 35 base + 0 standard tier + 2 vol (range 4 bps / 2) = 37
    // rate = 83.639339 * 0.9963 = 83.32987345... -> 83.329873
    // target = 1,250 * 83.329873 = 104,162.34125 INR -> 10,416,234 paise (half-up)
    expect(q).toEqual({
      corridorId: 'US-IN',
      sourceAmount: { amountMinor: 125_000, currency: 'USD' },
      targetAmount: { amountMinor: 10_416_234, currency: 'INR' },
      midRate: '83.639339',
      rate: '83.329873',
      spreadBps: 37,
      components: { baseBps: 35, tierAdjustmentBps: 0, volatilityBps: 2 },
      tier: 'standard',
      recentRangeBps: 4,
      rateTimestamp: '2026-10-22T12:00:00.000Z',
      expiresAt: '2026-10-22T12:00:30.400Z',
    });
  });

  it('DE-BR 1,250.00 EUR (exact half rounds up)', () => {
    const q = quote({ corridorId: 'DE-BR', sourceAmount: { amountMinor: 125_000, currency: 'EUR' }, atMs: T });
    // mid 5.914137; spread 45 + 0 + 1 = 46; rate = 5.914137 * 0.9954 = 5.88693197... -> 5.886932
    // target = 1,250 * 5.886932 = 7,358.665 BRL = 735,866.5 centavos -> 735,867
    expect(q).toMatchObject({ midRate: '5.914137', spreadBps: 46, rate: '5.886932', targetAmount: { amountMinor: 735_867, currency: 'BRL' }, tier: 'standard' });
  });

  it('GB-PH 1,250.00 GBP', () => {
    const q = quote({ corridorId: 'GB-PH', sourceAmount: { amountMinor: 125_000, currency: 'GBP' }, atMs: T });
    // mid 71.787774; spread 40 + 0 + 3 = 43; rate = 71.787774 * 0.9957 = 71.47908657... -> 71.479087
    // target = 1,250 * 71.479087 = 89,348.85875 PHP -> 8,934,886 centavos
    expect(q).toMatchObject({ midRate: '71.787774', spreadBps: 43, rate: '71.479087', targetAmount: { amountMinor: 8_934_886, currency: 'PHP' }, tier: 'standard' });
  });

  it('applies amount tiers in every corridor: bigger tickets are cheaper', () => {
    const expected = [
      [999_99, 'retail', 10],
      [1_000_00, 'standard', 0],
      [9_999_99, 'standard', 0],
      [10_000_00, 'business', -10],
      [100_000_00, 'corporate', -20],
      [1_000_000_00, 'corporate', -20],
    ] as const;
    for (const c of CORRIDORS) {
      let previous = Infinity;
      for (const [amountMinor, tier, adj] of expected) {
        const q = quote({ corridorId: c.id, sourceAmount: { amountMinor, currency: c.sourceCurrency }, atMs: T });
        expect(q.tier).toBe(tier);
        expect(q.components.tierAdjustmentBps).toBe(adj);
        expect(q.components.baseBps).toBe(CORRIDOR_BASE_SPREAD_BPS[c.id]);
        expect(q.spreadBps).toBe(q.components.baseBps + adj + q.components.volatilityBps);
        expect(q.spreadBps).toBeLessThanOrEqual(previous);
        previous = q.spreadBps;
      }
    }
    // retail example: US-IN 50.00 USD, spread 35 + 10 + 2 = 47; rate = 83.639339 * 0.9953 = 83.24623411... -> 83.246234
    // target = 50 * 83.246234 = 4,162.3117 INR -> 416,231 paise
    const small = quote({ corridorId: 'US-IN', sourceAmount: { amountMinor: 5_000, currency: 'USD' }, atMs: T });
    expect(small).toMatchObject({ spreadBps: 47, rate: '83.246234', targetAmount: { amountMinor: 416_231, currency: 'INR' } });
    // corporate example: GB-PH 250,000.00 GBP, spread 40 - 20 + 3 = 23; rate = 71.787774 * 0.9977 = 71.62266212... -> 71.622662
    // target = 250,000 * 71.622662 = 17,905,665.50 PHP
    const big = quote({ corridorId: 'GB-PH', sourceAmount: { amountMinor: 25_000_000, currency: 'GBP' }, atMs: T });
    expect(big).toMatchObject({ spreadBps: 23, rate: '71.622662', targetAmount: { amountMinor: 1_790_566_550, currency: 'PHP' } });
  });

  it('target amount always equals source * published rate, half-up, in exact integers', () => {
    for (const c of CORRIDORS) {
      for (let i = 0; i < 200; i++) {
        const amountMinor = 1 + ((i * 7_919_993) % 50_000_000);
        const q = quote({ corridorId: c.id, sourceAmount: { amountMinor, currency: c.sourceCurrency }, atMs: T + i * 37_000 });
        const [ip, fp = ''] = q.rate.split('.');
        const rateUnits = BigInt(ip! + fp); // scale = fp.length (6)
        const num = BigInt(amountMinor) * rateUnits; // target minor * 10^6 (both currencies have 2 decimals)
        const den = 10n ** BigInt(fp.length);
        const expectedMinor = num / den + ((num % den) * 2n >= den ? 1n : 0n);
        expect(BigInt(q.targetAmount.amountMinor)).toBe(expectedMinor);
      }
    }
  });

  it('is deterministic and uses the 1s tick', () => {
    const req = { corridorId: 'US-IN', sourceAmount: { amountMinor: 77_777, currency: 'USD' }, atMs: T + 1234 };
    expect(quote(req)).toEqual(quote({ ...req }));
    expect(quote(req).rateTimestamp).toBe('2026-10-22T12:00:01.000Z');
    expect(quote({ ...req, seed: 'x' }).midRate).not.toBe(quote(req).midRate);
  });

  it('rejects bad requests', () => {
    expect(() => quote({ corridorId: 'US-IN', sourceAmount: { amountMinor: 100, currency: 'EUR' }, atMs: T })).toThrow(/sells USD/);
    expect(() => quote({ corridorId: 'US-IN', sourceAmount: { amountMinor: 0, currency: 'USD' }, atMs: T })).toThrow(/positive/);
    expect(() => quote({ corridorId: 'ZZ-ZZ', sourceAmount: { amountMinor: 100, currency: 'USD' }, atMs: T })).toThrow(/unknown corridor/);
  });
});

describe('volatility add-on', () => {
  it('is half the recent 5-minute range, capped', () => {
    expect(volatilityAddOnBps(0)).toBe(0);
    expect(volatilityAddOnBps(7)).toBe(3);
    expect(volatilityAddOnBps(500)).toBe(VOL_ADDON_CAP_BPS);
  });

  it('widens the spread during a shock', () => {
    const shock = { corridorId: 'US-IN', fromMs: T, toMs: T + 600_000, driftBps: 300, noiseMultiplier: 4 };
    const at = T + 120_000; // ramping in
    expect(recentRangeBps('US-IN', at, undefined, [shock])).toBeGreaterThan(60);
    const calm = quote({ corridorId: 'US-IN', sourceAmount: { amountMinor: 125_000, currency: 'USD' }, atMs: at });
    const stressed = quote({ corridorId: 'US-IN', sourceAmount: { amountMinor: 125_000, currency: 'USD' }, atMs: at, shocks: [shock] });
    expect(stressed.components.volatilityBps).toBe(VOL_ADDON_CAP_BPS);
    expect(stressed.spreadBps).toBeGreaterThan(calm.spreadBps);
  });

  it('amountTier uses major units of the source currency', () => {
    expect(amountTier({ amountMinor: 100_000, currency: 'USD' }).id).toBe('standard');
    expect(amountTier({ amountMinor: 1_000, currency: 'JPY' }).id).toBe('standard'); // JPY has 0 decimals
    expect(amountTier({ amountMinor: 999, currency: 'JPY' }).id).toBe('retail');
  });
});
