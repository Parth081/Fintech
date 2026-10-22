import { describe, expect, it } from 'vitest';
import { applyEvent, canApply, type AnyEvent, type PaymentState } from '@ct/contracts';
import { buildEvents, buildState, type PaymentSpec } from '@ct/market/src/testing';
import { buildEvent } from './runner';
import { HEALTH_LAG_MS, MAX_ROUTING_ATTEMPTS, routingSteps } from './steps/routing';
import type { Step, StepContext } from './steps';

const T = Date.parse('2026-10-22T12:00:00.000Z');
const onQuoted = routingSteps[0] as Step;
const onFailed = routingSteps[1] as Step;
const ctx = (states: ReadonlyMap<string, PaymentState> = new Map(), now = '2030-01-01T00:00:00.000Z'): StepContext => ({ now, services: {}, view: { states } });

function fixture(spec: PaymentSpec): { trigger: AnyEvent; state: PaymentState } {
  const events = buildEvents(spec);
  return { trigger: events.at(-1)!, state: buildState(spec) };
}

const quotedFixture = (corridorId = 'US-IN', amountMinor = 125_000) =>
  fixture({ paymentId: `r-${corridorId}-${amountMinor}`, corridorId, amountMinor, startMs: T + 3_600_000, truncateAfter: 'payment.quoted' });

describe('routing step: payment.quoted -> payment.routed attempt 1', () => {
  it('picks the best score and explains it', async () => {
    const { trigger, state } = quotedFixture();
    const out = await onQuoted.produce(trigger, state, ctx());
    expect(out?.type).toBe('payment.routed');
    if (out?.type !== 'payment.routed') return;
    expect(out.payload).toMatchObject({
      providerId: 'orion', rail: 'Rail-A (instant)', estimatedFee: { amountMinor: 400, currency: 'USD' }, attempt: 1, excludedProviders: [],
      alternatives: [{ providerId: 'vega', score: 0.692 }, { providerId: 'lyra', score: 0.545 }],
    });
    expect(out.payload.scoring!.map((s) => s.providerId)).toEqual(['orion', 'vega', 'lyra']);
    expect(out.reasonCodes).toEqual(['BEST_SCORE', 'FASTEST']);
    expect(out.ruleVersion).toBe('routing-v1');
    expect(canApply(state, buildEvent('routing', trigger, out, 'n', 0))).toBe(true);
  });

  it('routes big tickets to the cheapest reliable provider', async () => {
    const { trigger, state } = quotedFixture('US-IN', 10_000_000);
    const out = await onQuoted.produce(trigger, state, ctx());
    expect(out?.type === 'payment.routed' && out.payload.providerId).toBe('vega');
    expect(out?.reasonCodes).toEqual(['BEST_SCORE', 'LOWEST_FEE', 'HIGHEST_SUCCESS']);
  });

  it('marks providers that do not serve the corridor', async () => {
    const { trigger, state } = quotedFixture('DE-BR', 50_000);
    const out = await onQuoted.produce(trigger, state, ctx());
    if (out?.type !== 'payment.routed') throw new Error('expected routed');
    expect(out.payload.scoring!.find((s) => s.providerId === 'lyra')).toMatchObject({ eligible: false, excludedReason: 'CORRIDOR_NOT_SERVED' });
    expect(out.payload.alternatives.map((a) => a.providerId)).not.toContain('lyra');
  });

  it('uses observed health from the view', async () => {
    const view = new Map<string, PaymentState>();
    for (let i = 0; i < 300; i++) {
      const s = buildState({ paymentId: `h-${i}`, startMs: T + 3_000_000 + i * 1000, attempts: [{ providerId: 'orion', ok: i % 3 === 0 }] });
      view.set(s.paymentId, s);
    }
    const { trigger, state } = quotedFixture();
    const out = await onQuoted.produce(trigger, state, ctx(view));
    if (out?.type !== 'payment.routed') throw new Error('expected routed');
    expect(out.payload.providerId).toBe('vega');
    expect((out.inputs.health as Record<string, { failed: number }>).orion!.failed).toBe(200);
  });

  it('does not route a stale quoted trigger while the payment is retrying', async () => {
    const spec = { paymentId: 'stale', startMs: T, attempts: [{ providerId: 'orion', ok: false }] };
    const quoted = buildEvents(spec).find((e) => e.type === 'payment.quoted')!;
    expect(await onQuoted.produce(quoted, buildState(spec), ctx())).toBeNull();
  });
});

describe('routing step: payment.send_failed -> retry or payment.failed', () => {
  it('retries on another provider, excluding the failed one', async () => {
    const { trigger, state } = fixture({ paymentId: 'retry-1', startMs: T, attempts: [{ providerId: 'orion', ok: false }] });
    const out = await onFailed.produce(trigger, state, ctx());
    if (out?.type !== 'payment.routed') throw new Error('expected routed');
    expect(out.payload).toMatchObject({ providerId: 'vega', attempt: 2, excludedProviders: ['orion'] });
    expect(out.payload.scoring!.find((s) => s.providerId === 'orion')).toMatchObject({ eligible: false, excludedReason: 'FAILED_THIS_PAYMENT' });
    expect(out.reasonCodes).toContain('RETRY_AFTER_FAILURE');
    expect(canApply(state, buildEvent('routing', trigger, out, 'n', 0))).toBe(true);
  });

  it('accumulates exclusions across attempts', async () => {
    const { trigger, state } = fixture({ paymentId: 'retry-2', startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: false }] });
    const out = await onFailed.produce(trigger, state, ctx());
    if (out?.type !== 'payment.routed') throw new Error('expected routed');
    expect(out.payload).toMatchObject({ providerId: 'lyra', attempt: 3, excludedProviders: ['orion', 'vega'], alternatives: [] });
    expect(out.reasonCodes).toEqual(expect.arrayContaining(['ONLY_ELIGIBLE_PROVIDER', 'RETRY_AFTER_FAILURE']));
  });

  it('fails the payment when every provider has failed (US-IN, 3 attempts)', async () => {
    const { trigger, state } = fixture({ paymentId: 'all-fail', startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: false }, { providerId: 'lyra', ok: false }] });
    const out = await onFailed.produce(trigger, state, ctx());
    expect(out).toMatchObject({ type: 'payment.failed', payload: { atStage: 'routing', attempts: MAX_ROUTING_ATTEMPTS }, reasonCodes: ['RETRY_LIMIT_REACHED'] });
    const ev = buildEvent('routing', trigger, out!, 'n', 0);
    expect(applyEvent(state, ev).status).toBe('failed');
  });

  it('fails when no eligible provider is left before the attempt limit (DE-BR has two)', async () => {
    const { trigger, state } = fixture({ paymentId: 'debr-fail', corridorId: 'DE-BR', amountMinor: 50_000, startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: false }] });
    const out = await onFailed.produce(trigger, state, ctx());
    expect(out).toMatchObject({ type: 'payment.failed', payload: { atStage: 'routing', attempts: 2 }, reasonCodes: ['NO_ELIGIBLE_PROVIDER'] });
  });

  it('ignores a send_failed that is not the latest one', async () => {
    const spec = { paymentId: 'old-fail', startMs: T, attempts: [{ providerId: 'orion', ok: false }, { providerId: 'vega', ok: false }] };
    const first = buildEvents(spec).find((e) => e.type === 'payment.send_failed')!;
    expect(await onFailed.produce(first, buildState(spec), ctx())).toBeNull();
  });
});

describe('routing determinism under replay', () => {
  it('produces the same event when re-run later with more outcomes in the view', async () => {
    const { trigger, state } = quotedFixture();
    const triggerMs = Date.parse(trigger.occurredAt);
    const view = new Map<string, PaymentState>();
    // outcomes well before the trigger: part of the decision
    for (let i = 0; i < 40; i++) {
      const s = buildState({ paymentId: `old-${i}`, startMs: triggerMs - 600_000 + i * 1000, attempts: [{ providerId: 'orion', ok: i % 4 !== 0 }] });
      view.set(s.paymentId, s);
    }
    const first = await onQuoted.produce(trigger, state, ctx(view, '2026-10-22T13:00:01.000Z'));
    // later outcomes (stamped after trigger - lag) must not change the decision
    for (let i = 0; i < 400; i++) {
      const s = buildState({ paymentId: `late-${i}`, startMs: triggerMs - HEALTH_LAG_MS + 10 + i * 50, attempts: [{ providerId: 'orion', ok: false }] });
      view.set(s.paymentId, s);
    }
    const replay = await onQuoted.produce(trigger, state, ctx(view, '2026-10-23T09:00:00.000Z'));
    expect(replay).toEqual(first);
    expect(buildEvent('routing', trigger, replay!, 'a', 0).payload).toEqual(buildEvent('routing', trigger, first!, 'b', 0).payload);
  });

  it('retry decisions are equally stable', async () => {
    const { trigger, state } = fixture({ paymentId: 'stable-retry', startMs: T, attempts: [{ providerId: 'orion', ok: false }] });
    const a = await onFailed.produce(trigger, state, ctx(new Map([[state.paymentId, state]])));
    const b = await onFailed.produce(trigger, state, ctx(new Map([[state.paymentId, state]]), '2031-01-01T00:00:00.000Z'));
    expect(b).toEqual(a);
  });
});
