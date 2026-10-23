import { describe, expect, it } from 'vitest';
import { makeControlEvent, type AnyEvent, type BusEvent, type ControlEventType, type ControlPayloadMap, type ProviderScore } from '@ct/contracts';
import { happyPath, makeEvent } from '@ct/contracts/testing';
import { LogAnalyzer } from './analyze';
import {
  checkBreakerOpened,
  checkControlSequence,
  checkNoTrafficWhileOpen,
  checkRecovery,
  checkReset,
  findBreakerOpen,
  findOpenViolations,
  recoveryComplete,
  runTimeline,
  ScenarioLog,
} from './m3-analyze';
import { parseVerifyM3Args } from './m3-args';

// A synthetic log builder with an explicit clock (ms from T0).
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const RUN = 'run-1-provider-outage';
const STEPS = ['baseline', 'orion-down', 'rerouting', 'orion-recovers', 'half-open', 'back-to-normal', 'summary'];

class Builder {
  readonly events: BusEvent[] = [];
  private n = 0;
  constructor(private readonly prefix = 'c') {}
  control<T extends ControlEventType>(type: T, payload: ControlPayloadMap[T], atMs: number): this {
    this.events.push(makeControlEvent(type, payload, { eventId: `${this.prefix}-${this.n++}`, occurredAt: iso(atMs), producer: 'orchestrator' }) as BusEvent);
    return this;
  }
  step(stepId: string, atMs: number): this {
    return this.control('control.scenario.step', { runId: RUN, scenarioId: 'provider-outage', stepId, title: stepId }, atMs);
  }
  /** A payment.routed decision at atMs (decided 2 s earlier, as routing does). */
  routed(paymentId: string, providerId: string, atMs: number, o: { attempt?: number; orion?: string; probe?: boolean } = {}): this {
    const scoring: ProviderScore[] = ['orion', 'lyra', 'vega'].map((id) => ({
      providerId: id,
      eligible: !(id === 'orion' && o.orion),
      ...(id === 'orion' && o.orion ? { excludedReason: o.orion } : {}),
      fee: { amountMinor: 100, currency: 'USD' },
      successRate: 0.9,
      latencyMs: 1000,
      score: 1,
    }));
    const e = makeEvent(
      'payment.routed',
      paymentId,
      { providerId, rail: 'x', estimatedFee: { amountMinor: 100, currency: 'USD' }, alternatives: [], attempt: o.attempt ?? 1, scoring },
      { producer: 'routing', occurredAt: iso(atMs) },
    );
    e.trace = {
      stage: 'routing',
      decision: providerId,
      reasonCodes: o.probe ? ['BEST_SCORE', 'CIRCUIT_HALF_OPEN_PROBE'] : ['BEST_SCORE'],
      inputs: { breakerAsOf: iso(atMs - 2000) },
      ruleVersion: 'routing-v1',
      latencyMs: 1,
    };
    this.events.push(e);
    return this;
  }
  settled(paymentId: string, providerId: string, atMs: number): this {
    this.events.push(makeEvent('payment.settled', paymentId, { providerId, settlementRef: `s-${paymentId}`, statusMessage: 'pacs.002' }, { producer: 'settlement', occurredAt: iso(atMs) }));
    return this;
  }
  build(): ScenarioLog {
    const log = new ScenarioLog();
    this.events.forEach((e, i) => log.apply(i, e));
    return log;
  }
}

/** The story of a good run: outage at 10 s, breaker open at ~14 s, half-open at ~29 s, recovery after 35 s. */
function goodRun(): Builder {
  const b = new Builder()
    .control('control.scenario.started', { runId: RUN, scenarioId: 'provider-outage', title: 'Provider outage', seed: 's' }, 0)
    .step('baseline', 0)
    .routed('p1', 'orion', 2000)
    .settled('p1', 'orion', 3000)
    .step('orion-down', 10_000)
    .control('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'test', runId: RUN }, 10_000)
    .routed('p2', 'orion', 11_000) // still closed: allowed
    .routed('p3', 'lyra', 14_000, { orion: 'CIRCUIT_OPEN' })
    .step('rerouting', 18_000)
    .routed('p4', 'vega', 20_000, { orion: 'CIRCUIT_OPEN' })
    .routed('p2', 'lyra', 21_000, { attempt: 2, orion: 'CIRCUIT_OPEN' }) // retry after orion failed
    .routed('p5', 'lyra', 29_500, { orion: 'CIRCUIT_HALF_OPEN' })
    .control('control.provider_outage.ended', { providerId: 'orion', runId: RUN }, 35_000)
    .step('orion-recovers', 35_000)
    .routed('p6', 'orion', 36_000, { probe: true })
    .settled('p6', 'orion', 37_000)
    .step('half-open', 42_000)
    .routed('p7', 'orion', 44_000)
    .settled('p7', 'orion', 45_000)
    .step('back-to-normal', 55_000)
    .step('summary', 63_000)
    .control('control.scenario.ended', { runId: RUN, scenarioId: 'provider-outage', outcome: 'completed' }, 72_000);
  return b;
}

describe('verify:m3 analysis on synthetic logs', () => {
  it('passes a good run: sequence, breaker open within the bound, respected, recovered', () => {
    const log = goodRun().build();
    const tl = runTimeline(log, RUN);
    expect(tl).toMatchObject({ providerId: 'orion', outcome: 'completed', outageStartedAt: T0 + 10_000, outageEndedAt: T0 + 35_000 });
    expect(checkControlSequence(log, RUN, STEPS).ok).toBe(true);
    const open = findBreakerOpen(log, tl);
    expect(open.firstOpen?.paymentId).toBe('p3');
    expect(open.delayMs).toBe(4000);
    expect(checkBreakerOpened(log, tl, 10_000).ok).toBe(true);
    const v = findOpenViolations(log, tl);
    expect(v.violations).toEqual([]);
    expect(v.window).toMatchObject({ fromMs: T0 + 14_000, toMs: T0 + 29_500 });
    expect(v.retriesToProviderInWindow).toBe(0);
    expect(checkNoTrafficWhileOpen(log, tl).ok).toBe(true);
    expect(recoveryComplete(log, tl)).toBe(true);
    const rec = checkRecovery(log, tl);
    expect(rec.ok).toBe(true);
    expect(rec.detail).toMatch(/2 first-attempt route\(s\) to orion .*\(1 probe\(s\)\), 2 settled/);
  });

  it('detects a breaker that opened too late, after the outage, or never', () => {
    const late = goodRun();
    late.events.splice(late.events.findIndex((e) => e.type === 'payment.routed' && e.paymentId === 'p3'), 1);
    const log = late.build();
    const tl = runTimeline(log, RUN);
    expect(findBreakerOpen(log, tl).delayMs).toBe(10_000); // p4 at 20 s
    expect(checkBreakerOpened(log, tl, 10_000).ok).toBe(true);
    expect(checkBreakerOpened(log, tl, 9_000).ok).toBe(false);

    const never = new Builder()
      .control('control.scenario.started', { runId: RUN, scenarioId: 'provider-outage', title: 't', seed: 's' }, 0)
      .control('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'x', runId: RUN }, 10_000)
      .routed('p1', 'orion', 12_000)
      .control('control.provider_outage.ended', { providerId: 'orion', runId: RUN }, 35_000)
      .routed('p2', 'lyra', 36_000, { orion: 'CIRCUIT_OPEN' }) // only after the outage
      .control('control.scenario.ended', { runId: RUN, scenarioId: 'provider-outage', outcome: 'completed' }, 72_000)
      .build();
    const tl2 = runTimeline(never, RUN);
    const c = checkBreakerOpened(never, tl2, 60_000);
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/AFTER the outage ended/);
    expect(checkNoTrafficWhileOpen(never, tl2).ok).toBe(false); // never went half-open
  });

  it('flags a first-attempt payment routed to orion while its breaker was open, but not a retry or an earlier decision', () => {
    const b = goodRun();
    const at = b.events.findIndex((e) => e.type === 'payment.routed' && e.paymentId === 'p4');
    const bad = new Builder().routed('p-bad', 'orion', 22_000).events[0]!;
    const retry = new Builder().routed('p-retry', 'orion', 23_000, { attempt: 2 }).events[0]!;
    // Decided at 12 s (before the first open decision at 14 s - 2 s = 12 s? no: 11.9 s), landed later in the log.
    const early = new Builder().routed('p-early', 'orion', 13_900).events[0]!;
    b.events.splice(at + 1, 0, bad, retry, early);
    const log = b.build();
    const tl = runTimeline(log, RUN);
    const v = findOpenViolations(log, tl);
    expect(v.violations.map((x) => x.paymentId)).toEqual(['p-bad']);
    expect(v.retriesToProviderInWindow).toBe(1);
    const c = checkNoTrafficWhileOpen(log, tl);
    expect(c.ok).toBe(false);
    expect(c.examples).toHaveLength(1);
  });

  it('uses the independently recomputed breaker to catch a route while it was open outside the observed window', () => {
    const b = goodRun();
    // Orion re-opened after a failed probe (30-45 s in this fake); p7 at 44 s decided at 42 s would be inside it.
    const log = b.build();
    const tl = runTimeline(log, RUN);
    const stateAt = (_p: string, ms: number) => (ms >= T0 + 30_000 && ms < T0 + 45_000 ? 'open' : 'closed') as 'open' | 'closed';
    const v = findOpenViolations(log, tl, { breakerStateAt: stateAt });
    // p6 decided at 34 s and p7 at 42 s fall in the recomputed open window.
    expect(v.violations.map((x) => x.paymentId)).toEqual(['p6', 'p7']);
    expect(v.violations[0]!.why).toMatch(/recomputed/);
  });

  it('fails recovery when orion only gets probes or nothing settles', () => {
    const b = goodRun();
    b.events.splice(b.events.findIndex((e) => e.type === 'payment.routed' && e.paymentId === 'p7'), 2); // drop p7 routed + settled
    const log = b.build();
    const tl = runTimeline(log, RUN);
    expect(recoveryComplete(log, tl)).toBe(false);
    expect(checkRecovery(log, tl).ok).toBe(false);
    // A straggler settled by orion after the outage, routed BEFORE it ended, does not count.
    const s = new Builder()
      .control('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'x', runId: RUN }, 10_000)
      .routed('old', 'orion', 9_000)
      .control('control.provider_outage.ended', { providerId: 'orion', runId: RUN }, 35_000)
      .settled('old', 'orion', 36_000)
      .build();
    expect(checkRecovery(s, runTimeline(s, RUN)).ok).toBe(false);
  });

  it('checks the control sequence: order, missing end, open outage, unknown or repeated steps', () => {
    const noEnd = goodRun();
    noEnd.events.pop();
    noEnd.events.splice(noEnd.events.findIndex((e) => e.type === 'control.provider_outage.ended'), 1);
    const c = checkControlSequence(noEnd.build(), RUN, STEPS);
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/expected control.scenario.ended/);
    expect(c.detail).toMatch(/still open at the end: orion/);
    expect(c.detail).toMatch(/still active/);

    const steps = goodRun();
    steps.events.splice(5, 0, ...new Builder('x').step('summary', 9_000).step('bogus', 9_500).events);
    const c2 = checkControlSequence(steps.build(), RUN, STEPS);
    expect(c2.ok).toBe(false);
    expect(c2.detail).toMatch(/unknown step "bogus"/);
    expect(c2.detail).toMatch(/out of order or repeated/);
  });

  it('LogAnalyzer keeps control events out of payment states (no state-machine errors)', () => {
    const log = new LogAnalyzer();
    const events: BusEvent[] = [...goodRun().events.filter((e) => e.type.startsWith('control.')), ...(happyPath('p-ok') as AnyEvent[])];
    events.forEach((e, i) => log.apply(i, e));
    expect(log.invalid).toEqual([]);
    expect(log.controls).toHaveLength(11);
    expect([...log.payments.keys()]).toEqual(['p-ok']);
  });

  it('checks the reset duration', () => {
    expect(checkReset({ durationMs: 4800, logEventsAfter: 20 }, 10_000).ok).toBe(true);
    expect(checkReset({ durationMs: 10_500 }, 10_000).ok).toBe(false);
    expect(checkReset({ durationMs: null, error: '409 busy' }, 10_000).ok).toBe(false);
    expect(checkReset({ durationMs: 3000, logEventsAfter: 50_000 }, 10_000).ok).toBe(false); // the log was not wiped
  });
});

describe('parseVerifyM3Args', () => {
  it('uses defaults and parses flags', () => {
    expect(parseVerifyM3Args([])).toMatchObject({ runs: 10, scenario: 'provider-outage', ambientRate: 3, maxResetMs: 10_000, breakerBoundMs: 10_000, basePort: 27170 });
    expect(parseVerifyM3Args(['--runs', '2', '--ambient=5', '--max-reset', '8000', '--keep'])).toMatchObject({ runs: 2, ambientRate: 5, maxResetMs: 8000, keep: true });
    expect(parseVerifyM3Args(['--url', 'http://127.0.0.1:7072/', '--control-url', 'http://127.0.0.1:7079'])).toMatchObject({
      url: 'http://127.0.0.1:7072',
      controlUrl: 'http://127.0.0.1:7079',
    });
  });
  it('rejects bad input', () => {
    expect(() => parseVerifyM3Args(['--runs', '0'])).toThrow(/runs/);
    expect(() => parseVerifyM3Args(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseVerifyM3Args(['--control-url', 'http://x'])).toThrow(/need --url/);
    expect(() => parseVerifyM3Args(['--ambient', '99'])).toThrow(/ambient/);
  });
});
