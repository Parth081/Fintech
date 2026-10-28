import { describe, expect, it } from 'vitest';
import { corridorById } from '@ct/contracts';
import { generatePayment, generatePayments } from './generator';
import { applyRisk, parseRiskMix, riskFor, SANCTIONS_NEAR_MATCHES } from './risk';
import { parseTrafficArgs } from './send';

describe('risk mix (M4)', () => {
  it('parses kind=probability with percentages and rejects bad input', () => {
    expect(parseRiskMix('sanctions=0.5%,fraud=1%')).toEqual({ sanctions: 0.005, fraud: 0.01 });
    expect(parseRiskMix('fraud=0.02')).toEqual({ fraud: 0.02 });
    expect(() => parseRiskMix('aml=1%')).toThrow(/kinds/);
    expect(() => parseRiskMix('fraud=')).toThrow();
    expect(() => parseRiskMix('fraud=2')).toThrow();
    expect(() => parseRiskMix('fraud=60%,sanctions=50%')).toThrow(/sum/);
    expect(parseTrafficArgs(['--risk-mix', 'sanctions=0.5%,fraud=1%'], 'http://x').riskMix).toEqual({ sanctions: 0.005, fraud: 0.01 });
    expect(parseTrafficArgs([], 'http://x').riskMix).toBeUndefined();
  });

  it('leaves default traffic byte-identical', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePayment(42, i, { riskMix: {} })).toEqual(generatePayment(42, i));
      expect(generatePayment(42, i, { riskMix: { fraud: 0 } })).toEqual(generatePayment(42, i));
    }
  });

  it('is deterministic per seed + index, close to the requested rate, and only changes the risky payments', () => {
    const mix = { sanctions: 0.05, fraud: 0.1 };
    const a = generatePayments(7, 2000, { riskMix: mix });
    const b = generatePayments(7, 2000, { riskMix: mix });
    expect(a).toEqual(b);
    const plain = generatePayments(7, 2000);
    const sanctions = a.filter((p) => p.idempotencyKey.endsWith('-risk-sanctions'));
    const fraud = a.filter((p) => p.idempotencyKey.endsWith('-risk-fraud'));
    expect(sanctions.length / 2000).toBeGreaterThan(0.03);
    expect(sanctions.length / 2000).toBeLessThan(0.07);
    expect(fraud.length / 2000).toBeGreaterThan(0.07);
    expect(fraud.length / 2000).toBeLessThan(0.13);
    a.forEach((p, i) => {
      const risk = riskFor(7, i, mix);
      if (!risk) expect(p).toEqual(plain[i]);
      else expect(p.idempotencyKey).toBe(`${plain[i]!.idempotencyKey}-risk-${risk}`);
    });
  });

  it('shapes sanctions and fraud payments that stay valid for their corridor', () => {
    const names = new Set(SANCTIONS_NEAR_MATCHES.map((m) => m.name));
    for (let i = 0; i < 50; i++) {
      const base = generatePayment(3, i).body;
      const c = corridorById(base.corridor)!;
      const s = applyRisk('sanctions', 3, i, base);
      expect(names.has(s.creditor.name) || names.has(s.debtor.name)).toBe(true);
      expect(s.creditor.country).toBe(c.targetCountry);
      expect(s.debtor.country).toBe(c.sourceCountry);
      const f = applyRisk('fraud', 3, i, base);
      expect(f.amount.currency).toBe(c.sourceCurrency);
      expect(f.amount.amountMinor).toBeGreaterThanOrEqual(900_000);
      expect(f.amount.amountMinor).toBeLessThan(1_000_000);
      expect(f.debtor.accountId).toMatch(/^SIM-[A-Z]{2}-NEW[0-9A-F]{8}$/);
      expect(f.creditor.accountId).toMatch(/^SIM-[A-Z]{2}-COLL[1-3]$/);
      expect(applyRisk('fraud', 3, i, base)).toEqual(f);
    }
  });
});

describe('sanctions near-matches vs the fictional list (services/stages)', async () => {
  const { FICTIONAL_SANCTIONS_LIST } = await import('../../services/stages/src/risk/sanctions-list');
  const tokens = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((t) => t.length > 2).map((t) => t.slice(0, 4)));
  it('each near-match is close to (but not exactly) a listed name', () => {
    for (const m of SANCTIONS_NEAR_MATCHES) {
      const mine = tokens(m.name);
      const hit = FICTIONAL_SANCTIONS_LIST.find((e) => [e.name, ...e.aliases].some((n) => [...tokens(n)].filter((t) => mine.has(t)).length >= 2));
      expect(hit, m.name).toBeDefined();
      expect([hit!.name, ...hit!.aliases].map((n) => n.toUpperCase())).not.toContain(m.name.toUpperCase());
    }
  });
});
