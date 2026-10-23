// Routing with circuit breakers (M3): open excludes, half-open admits hash-selected probes, all-open
// falls back to the least-bad provider, a recovered provider starts with fresh health.
import { describe, expect, it } from 'vitest';
import { INITIAL_CONTROL_STATE, type AnyEvent, type PaymentState } from '@ct/contracts';
import { breakerDetails, isProbeAllowed } from '@ct/market';
import { buildEvents, buildState, type PaymentSpec } from '@ct/market/src/testing';
import { buildEvent } from './runner';
import { HEALTH_LAG_MS, routingSteps } from './steps/routing';
import type { Step, StepContext } from './steps';

const T = Date.parse('2026-10-22T12:00:00.000Z');
const onQuoted = routingSteps[0] as Step;
const onFailed = routingSteps[1] as Step;
const ctx = (states: ReadonlyMap<string, PaymentState>, now = '2030-01-01T00:00:00.000Z'): StepContext => ({ now, services: {}, view: { states }, control: INITIAL_CONTROL_STATE });

// Event timing of testing.buildEvents: quoted at start+300, a first attempt's outcome at start+1500.
const QUOTED_AT = 300;
const FAIL_OUTCOME_AT = 1500;

/** `count` payments whose attempt on `providerId` fails, outcomes `spacing` apart, the last at `lastOutcomeMs`. */
function addFailures(view: Map<string, PaymentState>, providerId: string, lastOutcomeMs: number, count = 5, spacing = 500, tag = providerId) {
  for (let i = 0; i < count; i++) {
    const s = buildState({ paymentId: `fail-${tag}-${i}`, startMs: lastOutcomeMs - FAIL_OUTCOME_AT - (count - 1 - i) * spacing, attempts: [{ providerId, ok: false }] });
    view.set(s.paymentId, s);
  }
}

function pickId(prefix: string, probe: boolean): string {
  for (let i = 0; ; i++) if (isProbeAllowed(`${prefix}-${i}`, 'orion') === probe) return `${prefix}-${i}`;
}

function quoted(paymentId: string, quotedAtMs: number, corridorId = 'US-IN', amountMinor = 125_000): { trigger: AnyEvent; state: PaymentState } {
  const spec: PaymentSpec = { paymentId, corridorId, amountMinor, startMs: quotedAtMs - QUOTED_AT, truncateAfter: 'payment.quoted' };
  return { trigger: buildEvents(spec).at(-1)!, state: buildState(spec) };
}

async function routed(trigger: AnyEvent, state: PaymentState, view: Map<string, PaymentState>, step = onQuoted) {
  const out = await step.produce(trigger, state, ctx(view));
  if (out?.type !== 'payment.routed') throw new Error(`expected routed, got ${out?.type}`);
  return out;
}

const Q = T + 3_600_000; // trigger time used below
const ASOF = Q - HEALTH_LAG_MS;

describe('routing: open breaker', () => {
  it('excludes the provider (CIRCUIT_OPEN) and reroutes, with the breakers in the trace', async () => {
    const view = new Map<string, PaymentState>();
    addFailures(view, 'orion', ASOF - 5_000);
    expect(breakerDetails(view.values(), ASOF).orion!.state).toBe('open');
    const { trigger, state } = quoted(pickId('open', true), Q); // even a probe-selected payment is excluded while open
    const out = await routed(trigger, state, view);
    expect(out.payload.providerId).toBe('vega');
    expect(out.payload.scoring!.find((s) => s.providerId === 'orion')).toMatchObject({ eligible: false, excludedReason: 'CIRCUIT_OPEN' });
    expect(out.payload.alternatives.map((a) => a.providerId)).toEqual(['lyra']);
    expect(out.reasonCodes).toContain('CIRCUIT_OPEN_REROUTED');
    expect(out.inputs).toMatchObject({
      breakerAsOf: new Date(ASOF).toISOString(),
      circuitBlocked: ['orion'],
      withoutBreakers: 'vega', // its health is already hurt by the failures; the breaker makes it a hard stop
      breakers: { orion: { state: 'open', admission: 'reject-open', attempts: 5, failureRate: 1 }, vega: { state: 'closed', admission: 'admit' }, lyra: { state: 'closed' } },
    });
    expect((out.inputs.breakers as Record<string, { reason: string }>).orion!.reason).toMatch(/^Open: 4 of the last 4 instructions rejected/);
    expect(buildEvent('routing', trigger, out, 'n', 0).type).toBe('payment.routed');
  });

  it('no breaker activity leaves the M2 decision untouched', async () => {
    const { trigger, state } = quoted('quiet', Q);
    const out = await routed(trigger, state, new Map());
    expect(out.payload.providerId).toBe('orion');
    expect(out.reasonCodes).toEqual(['BEST_SCORE', 'FASTEST']);
    expect((out.inputs.breakers as Record<string, { state: string }>).orion!.state).toBe('closed');
  });
});

describe('routing: half-open breaker', () => {
  const view = new Map<string, PaymentState>();
  addFailures(view, 'orion', ASOF - 17_000); // opened ~17s before asOf -> half-open for ~2s

  it('sends probe-selected payments to the half-open provider', async () => {
    expect(breakerDetails(view.values(), ASOF).orion!.state).toBe('half-open');
    const { trigger, state } = quoted(pickId('probe', true), Q);
    const out = await routed(trigger, state, view);
    expect(out.payload.providerId).toBe('orion');
    expect(out.reasonCodes).toContain('CIRCUIT_HALF_OPEN_PROBE');
    expect((out.inputs.breakers as Record<string, { admission: string }>).orion!.admission).toBe('probe');
  });

  it('keeps other payments away (CIRCUIT_HALF_OPEN)', async () => {
    const { trigger, state } = quoted(pickId('noprobe', false), Q);
    const out = await routed(trigger, state, view);
    expect(out.payload.providerId).not.toBe('orion');
    expect(out.payload.scoring!.find((s) => s.providerId === 'orion')).toMatchObject({ eligible: false, excludedReason: 'CIRCUIT_HALF_OPEN' });
    expect(out.inputs.circuitBlocked).toEqual(['orion']);
    expect(out.reasonCodes).toContain('CIRCUIT_HALF_OPEN_REROUTED');
  });

  it('a successful probe closes the breaker and the provider gets traffic back with fresh health', async () => {
    const v = new Map<string, PaymentState>();
    const tripAt = ASOF - 40_000;
    addFailures(v, 'orion', tripAt); // 4th failure at tripAt - 500 opens it; half-open 15s later
    const halfOpenAt = tripAt - 500 + 15_000;
    const probe = buildState({ paymentId: 'probe-ok', startMs: halfOpenAt + 500, attempts: [{ providerId: 'orion', ok: true }] });
    v.set(probe.paymentId, probe);
    const b = breakerDetails(v.values(), ASOF).orion!;
    expect(b).toMatchObject({ state: 'closed', recoveredAtMs: halfOpenAt + 2_000 });
    const { trigger, state } = quoted(pickId('back', false), Q);
    const out = await routed(trigger, state, v);
    expect(out.payload.providerId).toBe('orion');
    expect(out.reasonCodes).toEqual(expect.arrayContaining(['BEST_SCORE', 'RECOVERED_AFTER_OUTAGE']));
    expect(out.inputs.healthResetAfterRecovery).toEqual({ orion: new Date(halfOpenAt + 2_000).toISOString() });
    expect((out.inputs.health as Record<string, { failed: number; settled: number }>).orion).toMatchObject({ failed: 0, settled: 1 });
  });
});

describe('routing: every eligible provider blocked by its breaker', () => {
  it('falls back to the best open provider instead of failing the payment (DE-BR: orion + vega open)', async () => {
    const view = new Map<string, PaymentState>();
    addFailures(view, 'orion', ASOF - 5_000);
    addFailures(view, 'vega', ASOF - 5_000);
    const { trigger, state } = quoted('fallback-1', Q, 'DE-BR', 50_000);
    const out = await routed(trigger, state, view);
    expect(['orion', 'vega']).toContain(out.payload.providerId);
    expect(out.reasonCodes).toContain('ALL_CIRCUITS_OPEN_FALLBACK');
    expect(out.reasonCodes).not.toContain('CIRCUIT_OPEN_REROUTED');
    expect(out.payload.scoring!.filter((s) => s.eligible).map((s) => s.providerId).sort()).toEqual(['orion', 'vega']);
    expect(out.inputs.fallbackRule).toMatch(/least-bad/);
  });

  it('prefers a half-open provider over an open one', async () => {
    const view = new Map<string, PaymentState>();
    addFailures(view, 'orion', ASOF - 17_000); // half-open
    addFailures(view, 'vega', ASOF - 5_000); // open
    const { trigger, state } = quoted(pickId('fb-half', false), Q, 'DE-BR', 50_000); // not a probe, still admitted
    const out = await routed(trigger, state, view);
    expect(out.payload.providerId).toBe('orion');
    expect(out.reasonCodes).toContain('ALL_CIRCUITS_OPEN_FALLBACK');
    expect(out.payload.scoring!.find((s) => s.providerId === 'vega')).toMatchObject({ eligible: false, excludedReason: 'CIRCUIT_OPEN' });
  });

  it('a retry whose only remaining provider is open still goes out (bounded by the 3-attempt limit)', async () => {
    const spec: PaymentSpec = { paymentId: 'fb-retry', corridorId: 'DE-BR', amountMinor: 50_000, startMs: Q - FAIL_OUTCOME_AT, attempts: [{ providerId: 'vega', ok: false }] };
    const trigger = buildEvents(spec).at(-1)!;
    expect(trigger.type).toBe('payment.send_failed');
    const view = new Map<string, PaymentState>();
    addFailures(view, 'orion', ASOF - 5_000);
    const out = await routed(trigger, buildState(spec), view, onFailed);
    expect(out.payload).toMatchObject({ providerId: 'orion', attempt: 2, excludedProviders: ['vega'] });
    expect(out.reasonCodes).toEqual(expect.arrayContaining(['RETRY_AFTER_FAILURE', 'ALL_CIRCUITS_OPEN_FALLBACK', 'ONLY_ELIGIBLE_PROVIDER']));
  });
});

describe('routing breakers are replay-deterministic', () => {
  it('outcomes after trigger - lag do not change the decision', async () => {
    const view = new Map<string, PaymentState>();
    addFailures(view, 'orion', ASOF - 17_000);
    const { trigger, state } = quoted(pickId('det', true), Q);
    const first = await onQuoted.produce(trigger, state, ctx(view));
    // a flood of late outcomes (a failed probe, more failures) stamped after asOf
    addFailures(view, 'orion', ASOF + 3_000, 10, 100, 'late');
    const s = buildState({ paymentId: 'late-ok', startMs: ASOF - 500, attempts: [{ providerId: 'orion', ok: true, latencyMs: 10 }] });
    view.set(s.paymentId, s);
    const replay = await onQuoted.produce(trigger, state, ctx(view, '2031-01-01T00:00:00.000Z'));
    expect(replay).toEqual(first);
    expect(first?.type === 'payment.routed' && first.payload.providerId).toBe('orion');
  });
});
