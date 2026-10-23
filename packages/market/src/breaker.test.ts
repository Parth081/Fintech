import { describe, expect, it } from 'vitest';
import type { PaymentState } from '@ct/contracts/browser';
import {
  breakerAdmission,
  breakerDetails,
  breakerFor,
  breakerFromOutcomes,
  breakerStates,
  DEFAULT_BREAKER_OPTIONS,
  isProbeAllowed,
  probeDraw,
  type BreakerOutcome,
} from './index';
import { buildState } from './testing';

const T = Date.parse('2026-10-22T12:00:00.000Z');
let n = 0;
/** An attempt sent at `sent` (s after T) with its outcome `dt` ms later. */
const at = (sentS: number, ok: boolean, dtMs = 1000): BreakerOutcome => ({ sentAtMs: T + sentS * 1000, outcomeAtMs: T + sentS * 1000 + dtMs, ok, key: `k${n++}` });
const ok = (s: number, dt?: number) => at(s, true, dt);
const ko = (s: number, dt?: number) => at(s, false, dt);
const S = (s: number) => T + s * 1000;

describe('breaker state machine', () => {
  const tripping = [ok(0), ko(1), ok(2), ko(3), ko(4), ko(5)]; // 4th failure outcome at 6s: 4 of 6 failed

  it('stays closed below the threshold and opens at the 4th failure with >= 50% failure rate', () => {
    expect(breakerFromOutcomes('orion', tripping.slice(0, 5), S(10)).state).toBe('closed'); // 3 failures
    const justBefore = breakerFromOutcomes('orion', tripping, S(6)); // outcome at exactly 6s is not before atMs
    expect(justBefore.state).toBe('closed');
    const b = breakerFromOutcomes('orion', tripping, S(6) + 1);
    expect(b).toMatchObject({ state: 'open', sinceMs: S(6), since: new Date(S(6)).toISOString(), trips: 1, trip: { failures: 4, attempts: 6 }, halfOpenAtMs: S(21) });
    expect(b.reason).toMatch(/^Open: 4 of the last 6 instructions rejected within 20s\. Traffic is re-routed; probing again at 12:00:21\.$/);
  });

  it('does not open below the failure rate or when failures are spread over more than the window', () => {
    const lowRate = [ko(0), ko(1), ko(2), ko(3), ...Array.from({ length: 6 }, (_, i) => ok(0.1 + i * 0.1))];
    expect(breakerFromOutcomes('orion', lowRate, S(10)).state).toBe('closed'); // 4 of 10
    const spread = [ko(0), ko(8), ko(16), ko(24)]; // never 4 inside 20s
    expect(breakerFromOutcomes('orion', spread, S(60)).state).toBe('closed');
    const tight = [ko(0), ko(8), ko(16), ko(18)];
    expect(breakerFromOutcomes('orion', tight, S(60)).state).not.toBe('closed');
  });

  it('goes half-open openMs after opening, by time alone', () => {
    expect(breakerFromOutcomes('orion', tripping, S(21) - 1).state).toBe('open');
    const h = breakerFromOutcomes('orion', tripping, S(21));
    expect(h).toMatchObject({ state: 'half-open', sinceMs: S(21) });
    expect(h.reason).toMatch(/^Half-open since 12:00:21: 25% of payments go through as probes/);
  });

  it('half-open -> closed on a successful probe; stragglers sent before half-open do not count', () => {
    const straggler = ok(5, 20_000); // sent before the trip, settles at 25s while half-open
    const probe = ok(30); // sent after half-open (21s), settles at 31s
    const s1 = breakerFromOutcomes('orion', [...tripping, straggler], S(26));
    expect(s1.state).toBe('half-open');
    const s2 = breakerFromOutcomes('orion', [...tripping, straggler, probe], S(31) + 1);
    expect(s2).toMatchObject({ state: 'closed', sinceMs: S(31), recoveredAtMs: S(31), lastProbe: { ok: true, atMs: S(31) } });
    expect(s2.reason).toMatch(/^Closed: recovered at 12:00:31 after a successful probe/);
    // failures of attempts sent before half-open, reported after recovery, do not re-trip it
    const late = [ko(10, 25_000), ko(11, 25_000), ko(12, 25_000), ko(13, 25_000)];
    expect(breakerFromOutcomes('orion', [...tripping, straggler, probe, ...late], S(40)).state).toBe('closed');
    // but fresh failures after recovery do
    const fresh = [ko(32), ko(33), ko(34), ko(35)];
    expect(breakerFromOutcomes('orion', [...tripping, probe, ...fresh], S(37)).state).toBe('open');
  });

  it('half-open -> open again after 2 failed probes, then half-open after another openMs', () => {
    const failedProbes = [ko(21.5), ko(22)]; // outcomes at 22.5s and 23s
    expect(breakerFromOutcomes('orion', [...tripping, failedProbes[0]!], S(23) + 1).state).toBe('half-open'); // one is not enough
    const b = breakerFromOutcomes('orion', [...tripping, ...failedProbes], S(23) + 1);
    expect(b).toMatchObject({ state: 'open', sinceMs: S(23), trips: 2, halfOpenAtMs: S(38), lastProbe: { ok: false, atMs: S(23) } });
    expect(b.reason).toMatch(/^Open: 2 probe instructions rejected \(last at 12:00:23\)/);
    expect(breakerFromOutcomes('orion', [...tripping, ...failedProbes], S(38)).state).toBe('half-open');
    expect(breakerFromOutcomes('orion', [...tripping, ...failedProbes, ok(40)], S(42)).state).toBe('closed');
    // the probe-failure count restarts with every half-open period
    expect(breakerFromOutcomes('orion', [...tripping, ...failedProbes, ko(39)], S(41)).state).toBe('half-open');
    // a single ordinary reject followed by a success closes it
    expect(breakerFromOutcomes('orion', [...tripping, ko(21.5), ok(22)], S(23) + 1).state).toBe('closed');
    expect(breakerFromOutcomes('orion', [...tripping, ko(21.5)], S(23), { probeFailuresToReopen: 1 }).state).toBe('open');
  });

  it('ignores outcomes while open (fallback traffic)', () => {
    const whileOpen = [ok(7), ok(8), ok(9)];
    expect(breakerFromOutcomes('orion', [...tripping, ...whileOpen], S(15)).state).toBe('open');
  });

  it('is deterministic: input order does not matter and later outcomes do not change the past', () => {
    const all = [...tripping, ko(21.5), ko(22), ok(39), ko(41), ok(45)];
    const shuffled = [...all].reverse();
    for (const t of [S(6) + 1, S(21), S(23) + 1, S(38), S(40) + 1, S(60)]) {
      const a = breakerFromOutcomes('orion', all, t);
      expect(breakerFromOutcomes('orion', shuffled, t)).toEqual(a);
      const withFuture = [...all, ...Array.from({ length: 20 }, (_, i) => ko((t - T) / 1000 + i * 0.1, 0))];
      expect(breakerFromOutcomes('orion', withFuture, t)).toEqual(a);
    }
  });

  it('honours options', () => {
    const b = breakerFromOutcomes('orion', [ko(0), ko(1)], S(5), { failureThreshold: 2, openMs: 1000 });
    expect(b.state).toBe('half-open');
    expect(DEFAULT_BREAKER_OPTIONS).toMatchObject({ failureThreshold: 4, failureRateThreshold: 0.5, windowMs: 20_000, openMs: 15_000, probeFraction: 0.25, probeFailuresToReopen: 2 });
  });
});

describe('breakerStates from payment states', () => {
  const states: PaymentState[] = [];
  for (let i = 0; i < 6; i++) states.push(buildState({ paymentId: `ok-${i}`, startMs: T + i * 1000, attempts: [{ providerId: 'vega', ok: true }] }));
  // orion fails 5 payments in a row (each retried on lyra)
  for (let i = 0; i < 5; i++) states.push(buildState({ paymentId: `f-${i}`, startMs: T + 10_000 + i * 500, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'lyra', ok: true }] }));

  it('returns a view for every catalogue provider with a plain-English reason', () => {
    const views = breakerStates(states, T + 20_000);
    expect(views.map((v) => v.providerId)).toEqual(['orion', 'lyra', 'vega']);
    const orion = views[0]!;
    expect(orion).toMatchObject({ providerId: 'orion', state: 'open', attempts: 5, failureRate: 1 });
    expect(orion.since).toMatch(/^2026-10-22T12:00:1\d\.\d{3}Z$/);
    expect(Object.keys(orion).sort()).toEqual(['attempts', 'failureRate', 'providerId', 'reason', 'since', 'state']);
    expect(views[1]).toMatchObject({ state: 'closed', since: null, failureRate: 0 });
    expect(views[2]!.reason).toMatch(/^Closed: (no instructions|0 of)/);
    expect(breakerFor(states, 'orion', T + 20_000).state).toBe('open');
    expect(breakerDetails(states, T + 1_000).orion!.state).toBe('closed');
  });

  it('is fast with 10k+ payment states', () => {
    const many: PaymentState[] = [];
    for (let i = 0; i < 12_000; i++) {
      const fail = i % 7 === 0;
      many.push(buildState({ paymentId: `m-${i}`, startMs: T + i * 100, attempts: fail ? [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: true }] : [{ providerId: i % 2 ? 'lyra' : 'orion', ok: true }] }));
    }
    breakerStates(many, T + 1_300_000); // warm the attempt cache
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) breakerStates(many, T + 1_300_000 + k);
    expect((performance.now() - t0) / 10).toBeLessThan(100);
  });
});

describe('probe selection', () => {
  it('is a deterministic hash draw admitting about probeFraction of payments', () => {
    let admitted = 0;
    for (let i = 0; i < 10_000; i++) if (isProbeAllowed(`p-${i}`, 'orion')) admitted++;
    expect(admitted / 10_000).toBeGreaterThan(0.23);
    expect(admitted / 10_000).toBeLessThan(0.27);
    expect(probeDraw('p-1', 'orion')).toBe(probeDraw('p-1', 'orion'));
    expect(probeDraw('p-1', 'orion')).not.toBe(probeDraw('p-1', 'lyra'));
    expect(isProbeAllowed('p-1', 'orion', 0)).toBe(false);
    expect(isProbeAllowed('p-1', 'orion', 1)).toBe(true);
  });

  it('maps breaker states to admissions', () => {
    const probeId = Array.from({ length: 100 }, (_, i) => `x-${i}`).find((id) => isProbeAllowed(id, 'orion'))!;
    const nonProbe = Array.from({ length: 100 }, (_, i) => `x-${i}`).find((id) => !isProbeAllowed(id, 'orion'))!;
    const b = { providerId: 'orion', probeFraction: 0.25 };
    expect(breakerAdmission({ ...b, state: 'closed' }, nonProbe)).toBe('admit');
    expect(breakerAdmission({ ...b, state: 'open' }, probeId)).toBe('reject-open');
    expect(breakerAdmission({ ...b, state: 'half-open' }, probeId)).toBe('probe');
    expect(breakerAdmission({ ...b, state: 'half-open' }, nonProbe)).toBe('reject-half-open');
  });
});
