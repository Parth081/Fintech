import { afterEach, describe, expect, it } from 'vitest';
import { CORRIDORS } from '@ct/contracts/browser';
import {
  clearVolatilityShocks,
  getVolatilityShocks,
  MAX_DEVIATION_BPS,
  rateAt,
  rateSeries,
  setVolatilityShocks,
} from './index';

const T = Date.parse('2026-10-22T12:00:00.000Z');
const DAY = 24 * 3_600_000;
const bps = (a: string, b: string) => ((Number(a) - Number(b)) / Number(b)) * 10_000;

afterEach(() => clearVolatilityShocks());

describe('rateAt', () => {
  it('is deterministic across calls and depends on corridor, time and seed', () => {
    for (const c of CORRIDORS) {
      const a = rateAt(c.id, T + 12_345);
      expect(rateAt(c.id, T + 12_345)).toEqual(a);
      expect(a.mid).toMatch(/^\d+\.\d{6}$/);
      expect(rateAt(c.id, T + 12_345, 'other-seed').mid).not.toBe(a.mid);
    }
    // pinned values (regression guard: same seed = same market everywhere)
    expect(rateAt('US-IN', T).mid).toBe('83.639339');
    expect(rateAt('DE-BR', T).mid).toBe('5.914137');
    expect(rateAt('GB-PH', T).mid).toBe('71.787774');
  });

  it('has 1 second resolution and reports the tick used', () => {
    const r = rateAt('US-IN', T + 999);
    expect(r).toEqual({ corridorId: 'US-IN', mid: rateAt('US-IN', T).mid, atMs: T });
    expect(rateAt('US-IN', T + 1000).atMs).toBe(T + 1000);
  });

  it('works for any timestamp without iterating history', () => {
    const t0 = performance.now();
    const far = rateAt('GB-PH', Date.parse('2099-01-01T00:00:00Z'));
    const past = rateAt('GB-PH', Date.parse('2001-01-01T00:00:00Z'));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(Math.abs(bps(far.mid, '72.4000'))).toBeLessThanOrEqual(MAX_DEVIATION_BPS + 0.01);
    expect(Math.abs(bps(past.mid, '72.4000'))).toBeLessThanOrEqual(MAX_DEVIATION_BPS + 0.01);
    expect(() => rateAt('XX-YY', T)).toThrow(/unknown corridor/);
  });

  it('stays within about +-1.5% of the corridor base and moves a few bps per minute', () => {
    expect(MAX_DEVIATION_BPS).toBeLessThan(150);
    for (const c of CORRIDORS) {
      const series = rateSeries(c.id, T, T + DAY, 60_000);
      let maxStep = 0;
      let sumStep = 0;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < series.length; i++) {
        const dev = bps(series[i]!.mid, c.midRate);
        expect(Math.abs(dev)).toBeLessThanOrEqual(MAX_DEVIATION_BPS + 0.01);
        min = Math.min(min, dev);
        max = Math.max(max, dev);
        if (i > 0) {
          const step = Math.abs(bps(series[i]!.mid, series[i - 1]!.mid));
          maxStep = Math.max(maxStep, step);
          sumStep += step;
        }
      }
      const avgStep = sumStep / (series.length - 1);
      expect(maxStep).toBeLessThan(10); // never jumps
      expect(avgStep).toBeGreaterThan(0.3); // but does move
      expect(avgStep).toBeLessThan(4);
      expect(max - min).toBeGreaterThan(30); // real intraday range
    }
  });

  it('is smooth second to second', () => {
    const s = rateSeries('US-IN', T, T + 3_600_000, 1000);
    for (let i = 1; i < s.length; i++) expect(Math.abs(bps(s[i]!.mid, s[i - 1]!.mid))).toBeLessThan(0.5);
  });
});

describe('rateSeries', () => {
  it('returns evenly spaced points that match rateAt, inclusive of both ends', () => {
    const s = rateSeries('DE-BR', T, T + 10 * 60_000, 60_000);
    expect(s).toHaveLength(11);
    s.forEach((p, i) => {
      expect(p.atMs).toBe(T + i * 60_000);
      expect(p.mid).toBe(rateAt('DE-BR', p.atMs).mid);
    });
    expect(rateSeries('DE-BR', T, T - 1, 1000)).toEqual([]);
    expect(() => rateSeries('DE-BR', T, T + 1000, 0)).toThrow();
    expect(() => rateSeries('DE-BR', T, T + DAY * 30, 1000)).toThrow(/max/);
  });
});

describe('volatility shock hook (M3)', () => {
  const shock = { corridorId: 'US-IN', fromMs: T, toMs: T + 600_000, driftBps: 300, noiseMultiplier: 4 };

  it('is off by default', () => {
    expect(getVolatilityShocks()).toEqual([]);
  });

  it('moves the rate only inside the window and only for the shocked corridor', () => {
    const mid = T + 300_000;
    const calm = rateAt('US-IN', mid).mid;
    const shocked = rateAt('US-IN', mid, undefined, [shock]).mid;
    expect(bps(shocked, calm)).toBeGreaterThan(200);
    expect(rateAt('US-IN', T - 1000, undefined, [shock]).mid).toBe(rateAt('US-IN', T - 1000).mid);
    expect(rateAt('US-IN', T + 600_000, undefined, [shock]).mid).toBe(rateAt('US-IN', T + 600_000).mid);
    expect(rateAt('GB-PH', mid, undefined, [shock]).mid).toBe(rateAt('GB-PH', mid).mid);
    // ramps in smoothly
    const s = rateSeries('US-IN', T, T + 600_000, 1000, undefined, [shock]);
    for (let i = 1; i < s.length; i++) expect(Math.abs(bps(s[i]!.mid, s[i - 1]!.mid))).toBeLessThan(10);
  });

  it('can be registered process-wide', () => {
    const mid = T + 300_000;
    const calm = rateAt('US-IN', mid).mid;
    setVolatilityShocks([shock]);
    expect(rateAt('US-IN', mid).mid).toBe(rateAt('US-IN', mid, undefined, [shock]).mid);
    clearVolatilityShocks();
    expect(rateAt('US-IN', mid).mid).toBe(calm);
  });
});
