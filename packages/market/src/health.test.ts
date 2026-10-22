import { describe, expect, it } from 'vitest';
import type { PaymentState } from '@ct/contracts/browser';
import { attemptsOf, HEALTH_PRIOR_WEIGHT, providerHealth, providerHealthAll } from './index';
import { buildState } from './testing';

const T = Date.parse('2026-10-22T12:00:00.000Z');

describe('attemptsOf', () => {
  it('attributes every attempt to the provider that handled it', () => {
    const s = buildState({
      paymentId: 'p1', startMs: T,
      attempts: [{ providerId: 'orion', ok: false, latencyMs: 500 }, { providerId: 'vega', ok: false }, { providerId: 'lyra', ok: true, latencyMs: 3000 }],
    });
    const a = attemptsOf(s);
    expect(a.map((x) => [x.providerId, x.outcome])).toEqual([['orion', 'failed'], ['vega', 'failed'], ['lyra', 'settled']]);
    expect(a[2]!.outcomeAtMs! - a[2]!.sentAtMs).toBe(3000);
    expect(attemptsOf(s)).toBe(a); // cached per state object
  });

  it('handles a payment waiting for re-routing and one in flight', () => {
    const retrying = buildState({ paymentId: 'p2', startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'lyra', ok: false }] });
    expect(retrying.status).toBe('retrying');
    expect(attemptsOf(retrying).map((x) => [x.providerId, x.outcome])).toEqual([['orion', 'failed'], ['lyra', 'failed']]);
    const inFlight = buildState({ paymentId: 'p3', startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: true }], truncateAfter: 'payment.sent' });
    expect(inFlight.status).toBe('sent');
    expect(attemptsOf(inFlight).map((x) => [x.providerId, x.outcome])).toEqual([['orion', 'failed'], ['vega', null]]);
    expect(attemptsOf(buildState({ paymentId: 'p4', startMs: T }))).toEqual([]);
  });
});

describe('providerHealth', () => {
  const states: PaymentState[] = [];
  // orion: 8 settled (latency 1000, 2000...), 2 failed; vega: 1 settled; lyra: nothing
  for (let i = 0; i < 8; i++) states.push(buildState({ paymentId: `ok-${i}`, startMs: T + i * 10_000, attempts: [{ providerId: 'orion', ok: true, latencyMs: 1000 * (1 + (i % 2)) }] }));
  states.push(buildState({ paymentId: 'f-1', startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: true, latencyMs: 20_000 }] }));
  states.push(buildState({ paymentId: 'f-2', startMs: T + 200_000, attempts: [{ providerId: 'orion', ok: false }] }));

  it('counts observed outcomes and blends the success rate with the catalogue prior', () => {
    const h = providerHealth(states, 'orion');
    expect(h).toMatchObject({ providerId: 'orion', attempts: 10, settled: 8, failed: 2, avgLatencyMs: 1500 });
    expect(h.successRate).toBeCloseTo((8 + HEALTH_PRIOR_WEIGHT * 0.97) / (10 + HEALTH_PRIOR_WEIGHT), 12);
    expect(providerHealth(states, 'vega')).toMatchObject({ attempts: 1, settled: 1, failed: 0, avgLatencyMs: 20_000 });
    const lyra = providerHealth(states, 'lyra');
    expect(lyra).toEqual({ providerId: 'lyra', attempts: 0, settled: 0, failed: 0, successRate: 0.93, avgLatencyMs: null });
  });

  it('a few failures do not swing it; a sustained incident does', () => {
    const few = providerHealth([buildState({ paymentId: 'x', startMs: T, attempts: [{ providerId: 'vega', ok: false }] })], 'vega');
    expect(few.successRate).toBeGreaterThan(0.96);
    const many = Array.from({ length: 200 }, (_, i) => buildState({ paymentId: `inc-${i}`, startMs: T + i, attempts: [{ providerId: 'vega', ok: i % 2 === 0 }] }));
    expect(providerHealth(many, 'vega').successRate).toBeLessThan(0.7);
  });

  it('applies PROVIDER_FAILURE_SCALE to the prior', () => {
    expect(providerHealth([], 'lyra', { failureScale: 0 }).successRate).toBe(1);
    expect(providerHealth([], 'lyra', { failureScale: 2 }).successRate).toBeCloseTo(0.86, 12);
  });

  it('only counts outcomes before asOf and inside the window', () => {
    // f-2's orion failure happens at T+200_000+~600ms; ok-* settle between T+~1.5s and T+~73s
    const before = providerHealthAll(states, { asOfMs: T + 100_000 });
    expect(before.orion).toMatchObject({ settled: 8, failed: 1 });
    const windowed = providerHealthAll(states, { asOfMs: T + 300_000, windowMs: 120_000 });
    expect(windowed.orion).toMatchObject({ settled: 0, failed: 1 });
    // a sent attempt whose outcome lies after asOf is in flight
    const sentAt = attemptsOf(states[0]!)[0]!.sentAtMs;
    const mid = providerHealthAll([states[0]!], { asOfMs: sentAt + 1 });
    expect(mid.orion).toMatchObject({ attempts: 1, settled: 0, failed: 0 });
    expect(Object.keys(providerHealthAll([]))).toEqual(['orion', 'lyra', 'vega']);
  });

  it('is fast with 10,000 payments in the view', () => {
    const view = new Map<string, PaymentState>();
    const ids = ['orion', 'lyra', 'vega'];
    for (let i = 0; i < 10_000; i++) {
      const attempts = i % 10 === 0 ? [{ providerId: ids[i % 3]!, ok: false }, { providerId: ids[(i + 1) % 3]!, ok: true }] : [{ providerId: ids[i % 3]!, ok: i % 17 !== 0 }];
      view.set(`perf-${i}`, buildState({ paymentId: `perf-${i}`, startMs: T + i * 100, attempts }));
    }
    let t0 = performance.now();
    const cold = providerHealthAll(view.values(), { asOfMs: T + 1_005_000, windowMs: 900_000 });
    const coldMs = performance.now() - t0;
    const runs = 50;
    t0 = performance.now();
    for (let i = 0; i < runs; i++) providerHealthAll(view.values(), { asOfMs: T + 1_005_000 + i, windowMs: 900_000 });
    const warmMs = (performance.now() - t0) / runs;
    console.log(`[perf] providerHealthAll over 10,000 payments: cold ${coldMs.toFixed(2)} ms, warm ${warmMs.toFixed(3)} ms/call`);
    expect(cold.orion!.attempts + cold.lyra!.attempts + cold.vega!.attempts).toBeGreaterThan(5_000);
    expect(warmMs).toBeLessThan(25);
  });
});
