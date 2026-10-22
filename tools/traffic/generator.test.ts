import { CORRIDORS, corridorById, exponentOf } from '@ct/contracts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  corridorPopulation,
  CORRIDOR_PROFILES,
  generatePayment,
  generatePayments,
  idempotencyKey,
  mulberry32,
  parseScenarioMix,
  POPULATION_PER_CORRIDOR,
} from './generator';
import { runTraffic } from './run';
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
    expect(parseTrafficArgs([], 'http://x:1')).toEqual({ help: false, count: 10, seed: 42, rate: 2, url: 'http://x:1', start: 0, concurrency: 8 });
    expect(parseTrafficArgs(['--mix', 'provider-reject=0.02,recon-break=1%', '--concurrency', '32', '--quiet'], 'u')).toMatchObject({
      mix: { 'provider-reject': 0.02, 'recon-break': 0.01 },
      concurrency: 32,
      quiet: true,
    });
    expect(() => parseTrafficArgs(['--mix', 'a=0.7,b=0.7'])).toThrow(/sum/);
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

describe('traffic v2 model', () => {
  it('follows the weighted corridor mix', () => {
    const ps = generatePayments(5, 5000);
    const share = (id: string) => ps.filter((p) => p.body.corridor === id).length / ps.length;
    expect(share('US-IN')).toBeGreaterThan(0.45);
    expect(share('US-IN')).toBeLessThan(0.55);
    expect(share('DE-BR')).toBeGreaterThan(0.16);
    expect(share('DE-BR')).toBeLessThan(0.24);
  });

  it('draws log-normal amounts whose median tracks the corridor profile', () => {
    const ps = generatePayments(11, 6000);
    for (const [id, profile] of Object.entries(CORRIDOR_PROFILES)) {
      const c = corridorById(id)!;
      const majors = ps.filter((p) => p.body.corridor === id).map((p) => p.body.amount.amountMinor / 10 ** exponentOf(c.sourceCurrency)).sort((a, b) => a - b);
      const median = majors[Math.floor(majors.length / 2)]!;
      expect(median).toBeGreaterThan(profile.median * 0.8);
      expect(median).toBeLessThan(profile.median * 1.25);
    }
  });

  it('reuses a seeded population of customers', () => {
    const ps = generatePayments(3, 3000);
    const senders = new Set(ps.map((p) => p.body.debtor.accountId));
    expect(senders.size).toBeLessThanOrEqual(POPULATION_PER_CORRIDOR.senders * CORRIDORS.length);
    expect(senders.size).toBeGreaterThan(100);
    expect(corridorPopulation(3, CORRIDORS[0]!)).toEqual(corridorPopulation(3, CORRIDORS[0]!));
  });

  it('applies a scenario mix deterministically per seed + index', () => {
    const mix = parseScenarioMix('provider-reject=0.02,recon-break=0.01');
    const ps = generatePayments(42, 10_000, { mix });
    const count = (s: string) => ps.filter((p) => p.body.scenario === s).length;
    expect(count('provider-reject')).toBeGreaterThan(140);
    expect(count('provider-reject')).toBeLessThan(260);
    expect(count('recon-break')).toBeGreaterThan(60);
    expect(count('recon-break')).toBeLessThan(140);
    const withScenario = ps.find((p) => p.body.scenario)!;
    expect(withScenario.idempotencyKey).toBe(idempotencyKey(42, withScenario.index, withScenario.body.scenario));
    expect(generatePayments(42, 10, { mix, start: withScenario.index })[0]).toEqual(withScenario);
    // The mix does not change the rest of the payment.
    const plain = generatePayment(42, withScenario.index);
    expect({ ...withScenario.body, scenario: undefined }).toEqual({ ...plain.body, scenario: undefined });
  });
});

describe('runTraffic', () => {
  it('sends every payment once with bounded concurrency, retries 5xx with the same key, keeps idempotency', async () => {
    const seen = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    let failOnce = true;
    const server = http.createServer((req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const key = String(req.headers['idempotency-key']);
      req.resume();
      req.on('end', () => {
        setTimeout(() => {
          inFlight -= 1;
          if (failOnce && key.endsWith('-i3')) {
            failOnce = false;
            res.writeHead(503).end('{}');
            return;
          }
          const dup = seen.has(key);
          seen.set(key, (seen.get(key) ?? 0) + 1);
          res.writeHead(dup ? 200 : 202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ paymentId: `pay-${key}`, ...(dup ? { duplicate: true } : {}) }));
        }, 5);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const s = await runTraffic({ url, seed: 1, count: 40, rate: 0, concurrency: 4 });
      expect(s.counts).toEqual({ accepted: 40, duplicate: 0, error: 0 });
      expect(s.retried).toBe(1);
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(s.results.map((r) => r.payment.index)).toEqual(Array.from({ length: 40 }, (_, i) => i));
      const again = await runTraffic({ url, seed: 1, count: 5, rate: 0, concurrency: 2 });
      expect(again.counts.duplicate).toBe(5);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
