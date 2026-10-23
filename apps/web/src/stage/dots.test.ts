import { describe, expect, it } from 'vitest';
import { advanceDots, applyDotEvents, createDotEngine, DEFAULT_DOT_CONFIG, dotAlpha, dotCounts, type DotConfig, type SpawnInfo } from './dots';

const cfg: DotConfig = { ...DEFAULT_DOT_CONFIG, maxDots: 3, travelMs: 1000, holdAt: 0.9, landMs: 200, flashMs: 100, failMs: 300, maxAgeMs: 5000 };
const info = (providerId = 'orion'): SpawnInfo => ({ routeKey: `US-IN:${providerId}`, providerId, hubT: 0.4 });
const resolve = () => info();
const ev = (type: string, paymentId = 'p1') => ({ type, paymentId });

function run(engine: ReturnType<typeof createDotEngine>, ms: number, step = 16) {
  for (let t = 0; t < ms; t += step) advanceDots(engine, step, cfg);
}

describe('dot lifecycle', () => {
  it('spawns on routed, ignores the following sent, and holds short of the target', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed'), ev('payment.sent')], resolve, cfg);
    expect(e.dots).toHaveLength(1);
    run(e, 3000);
    expect(e.dots[0]?.p).toBeCloseTo(0.9, 6);
    expect(e.dots[0]?.phase).toBe('flying');
  });

  it('spawns on sent when routed was missed', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.sent')], resolve, cfg);
    expect(e.dots).toHaveLength(1);
  });

  it('lands on settled, flashes, then disappears', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed')], resolve, cfg);
    run(e, 500);
    applyDotEvents(e, [ev('payment.settled')], resolve, cfg);
    expect(e.active.size).toBe(0);
    run(e, 2000, 10);
    expect(e.dots).toHaveLength(0);
  });

  it('a payment settled in the same frame still travels the whole route', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed'), ev('payment.sent'), ev('payment.settled')], resolve, cfg);
    advanceDots(e, 200, cfg);
    expect(e.dots[0]?.phase).toBe('landing');
    expect(e.dots[0]!.p).toBeLessThan(0.5);
  });

  it('a rejected dot runs to the provider hub and fades there; the re-route spawns a new dot', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed'), ev('payment.sent'), ev('payment.send_failed')], resolve, cfg, () => 0.4);
    run(e, 400);
    const failed = e.dots[0]!;
    expect(failed.phase).toBe('failing');
    expect(failed.p).toBeCloseTo(0.4, 6);
    applyDotEvents(e, [ev('payment.routed')], () => info('lyra'), cfg);
    expect(e.dots).toHaveLength(2);
    expect(e.active.get('p1')?.providerId).toBe('lyra');
    run(e, 600);
    expect(e.dots.map((d) => d.providerId)).toEqual(['lyra']);
  });

  it('a failing dot past the hub stays where it is', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed')], resolve, cfg);
    run(e, 800);
    const p = e.dots[0]!.p;
    applyDotEvents(e, [ev('payment.failed')], resolve, cfg, () => 0.4);
    advanceDots(e, 50, cfg);
    expect(e.dots[0]!.p).toBeCloseTo(p, 6);
    expect(dotAlpha(e.dots[0]!, cfg)).toBeLessThan(1);
  });

  it('caps concurrent dots and counts the drops', () => {
    const e = createDotEngine();
    applyDotEvents(e, ['a', 'b', 'c', 'd', 'e'].map((id) => ev('payment.routed', id)), resolve, cfg);
    expect(e.dots).toHaveLength(3);
    expect(e.dropped).toBe(2);
    // a dropped payment's later outcome is harmless
    applyDotEvents(e, [ev('payment.settled', 'e')], resolve, cfg);
    expect(dotCounts(e).landing).toBe(0);
  });

  it('unknown payments get no dot; outcome events without a dot are ignored', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed')], () => null, cfg);
    applyDotEvents(e, [ev('payment.settled', 'zzz'), ev('payment.send_failed', 'zzz')], resolve, cfg);
    expect(e.dots).toHaveLength(0);
  });

  it('dots without an outcome fade out after maxAgeMs', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed')], resolve, cfg);
    run(e, 5100, 50);
    expect(e.dots[0]?.phase).toBe('fading');
    expect(e.active.size).toBe(0);
    run(e, 400, 50);
    expect(e.dots).toHaveLength(0);
  });

  it('clamps huge frame gaps (tab was in the background)', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed')], resolve, cfg);
    advanceDots(e, 60_000, cfg);
    expect(e.dots[0]!.p).toBeLessThan(0.9);
    expect(e.dots[0]!.phase).toBe('flying');
  });

  it('marks probes', () => {
    const e = createDotEngine();
    applyDotEvents(e, [ev('payment.routed')], () => ({ ...info(), probe: true }), cfg);
    expect(e.dots[0]?.probe).toBe(true);
  });
});
