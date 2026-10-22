import { CORRIDORS, corridorById, exponentOf } from '@ct/contracts';
import { describe, expect, it } from 'vitest';
import { generatePayment, generatePayments, idempotencyKey, mulberry32 } from './generator';
import { classifyResponse, parseTrafficArgs } from './send';

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('traffic generator', () => {
  it('produces identical payments for the same seed', () => {
    expect(generatePayments(42, 50)).toEqual(generatePayments(42, 50));
    expect(generatePayments(42, 5)).not.toEqual(generatePayments(43, 5));
  });

  it('payment i does not depend on count or start offset', () => {
    const all = generatePayments(7, 20);
    const tail = generatePayments(7, 5, { start: 15 });
    expect(tail).toEqual(all.slice(15));
  });

  it('derives the idempotency key from seed + index (+ scenario)', () => {
    const ps = generatePayments(42, 100);
    expect(new Set(ps.map((p) => p.idempotencyKey)).size).toBe(100);
    expect(ps[3]!.idempotencyKey).toBe(idempotencyKey(42, 3));
    expect(generatePayment(42, 3, { scenario: 'force-hold' }).idempotencyKey).toBe('traffic-s42-i3-force-hold');
    expect(generatePayment(42, 3, { scenario: 'force-hold' }).body.scenario).toBe('force-hold');
    expect(ps[3]!.body.scenario).toBeUndefined();
  });

  it('uses known corridors with matching countries and currencies', () => {
    const ps = generatePayments(123, 500);
    for (const { body } of ps) {
      const c = corridorById(body.corridor);
      expect(c).toBeDefined();
      expect(body.amount.currency).toBe(c!.sourceCurrency);
      expect(body.targetCurrency).toBe(c!.targetCurrency);
      expect(body.debtor.country).toBe(c!.sourceCountry);
      expect(body.creditor.country).toBe(c!.targetCountry);
      expect(body.debtor.name).toMatch(/\S+ \S+/);
      expect(body.creditor.accountId).toMatch(/^SIM-[A-Z]{2}-\d{10}$/);
    }
    // Every corridor gets used with a reasonable sample.
    expect(new Set(ps.map((p) => p.body.corridor))).toEqual(new Set(CORRIDORS.map((c) => c.id)));
  });

  it('generates plausible integer minor-unit amounts', () => {
    for (const { body } of generatePayments(9, 500)) {
      const { amountMinor, currency } = body.amount;
      const scale = 10 ** exponentOf(currency);
      expect(Number.isSafeInteger(amountMinor)).toBe(true);
      expect(amountMinor).toBeGreaterThanOrEqual(scale); // at least 1 major unit
      expect(amountMinor).toBeLessThanOrEqual(50_000 * scale);
    }
  });
});

describe('traffic args + response classification', () => {
  it('parses flags with defaults', () => {
    expect(parseTrafficArgs([], 'http://x:1')).toEqual({ help: false, count: 10, seed: 42, rate: 2, url: 'http://x:1', start: 0 });
    const a = parseTrafficArgs(['--count', '3', '--seed=7', '--rate', '0.5', '--scenario', 'force-hold', '--url', 'http://h:9/'], 'u');
    expect(a).toMatchObject({ count: 3, seed: 7, rate: 0.5, scenario: 'force-hold', url: 'http://h:9' });
    expect(() => parseTrafficArgs(['--count', '-1'])).toThrow();
    expect(() => parseTrafficArgs(['--bogus'])).toThrow(/Unknown option/);
  });

  it('classifies accepted, duplicate and error responses', () => {
    const h = new Headers();
    expect(classifyResponse(202, h, { paymentId: 'p1' })).toEqual({ outcome: 'accepted', status: 202, paymentId: 'p1' });
    expect(classifyResponse(200, h, { paymentId: 'p1', duplicate: true }).outcome).toBe('duplicate');
    expect(classifyResponse(200, new Headers({ 'Idempotent-Replayed': 'true' }), {}).outcome).toBe('duplicate');
    expect(classifyResponse(409, h, {}).outcome).toBe('duplicate');
    expect(classifyResponse(400, h, { error: 'bad corridor' })).toMatchObject({ outcome: 'error', detail: 'bad corridor' });
  });
});
