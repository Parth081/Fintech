import { describe, expect, it } from 'vitest';
import type { AnyEvent, PaymentState } from '@ct/contracts';
import { INITIAL_CONTROL_STATE } from '@ct/contracts';
import { quote } from '@ct/market';
import { buildEvents, buildState } from '@ct/market/src/testing';
import { buildEvent } from './runner';
import { fxSteps, QUOTE_TTL_MS } from './steps/fx';
import type { StepContext } from './steps';

const T = Date.parse('2026-10-22T12:00:00.000Z');
const step = fxSteps[0]!;
const ctx = (now: string, seed?: string): StepContext => ({ now, services: seed ? { sim: { seed, providerFailureScale: 1 } } : {}, view: { states: new Map() }, control: INITIAL_CONTROL_STATE });

function scoredFixture(corridorId: string, amountMinor: number): { trigger: AnyEvent; state: PaymentState } {
  const spec = { paymentId: `fx-${corridorId}-${amountMinor}`, corridorId, amountMinor, startMs: T, truncateAfter: 'payment.scored' as const };
  const events = buildEvents(spec);
  return { trigger: events.at(-1)!, state: buildState(spec) };
}

describe('fx step', () => {
  it.each([
    ['US-IN', 125_000],
    ['DE-BR', 50_000],
    ['GB-PH', 2_500_000],
  ])('quotes %s at the trigger time with the market policy', async (corridorId, amountMinor) => {
    const { trigger, state } = scoredFixture(corridorId, amountMinor);
    const out = await step.produce(trigger, state, ctx(new Date(T + 99_000).toISOString()));
    expect(out?.type).toBe('payment.quoted');
    if (out?.type !== 'payment.quoted') return;
    const q = quote({ corridorId, sourceAmount: state.initiated.amount, atMs: Date.parse(trigger.occurredAt) });
    expect(out.payload).toMatchObject({
      rate: q.rate, midRate: q.midRate, rateTimestamp: q.rateTimestamp, spreadBps: q.spreadBps,
      sourceAmount: state.initiated.amount, targetAmount: q.targetAmount,
    });
    expect(Date.parse(out.payload.expiresAt) - Date.parse(trigger.occurredAt)).toBe(QUOTE_TTL_MS);
    expect(out.ruleVersion).toBe('fx-engine-v1');
    expect(out.reasonCodes).toContain('MARKET_MID_RATE');
    expect(out.inputs).toMatchObject({ midRate: q.midRate, amountTier: q.tier, spreadComponents: q.components });
  });

  it('is replay-safe: same trigger, different wall clock -> identical event payload', async () => {
    const { trigger, state } = scoredFixture('US-IN', 125_000);
    const a = await step.produce(trigger, state, ctx('2026-10-22T12:00:05.000Z'));
    const b = await step.produce(trigger, state, ctx('2027-01-01T00:00:00.000Z'));
    expect(b).toEqual(a);
    const ea = buildEvent('fx', trigger, a!, 'x', 0);
    const eb = buildEvent('fx', trigger, b!, 'y', 1);
    expect(eb.eventId).toBe(ea.eventId);
    expect(eb.payload).toEqual(ea.payload);
  });

  it('takes the seed from ctx.services.sim', async () => {
    const { trigger, state } = scoredFixture('US-IN', 125_000);
    const a = await step.produce(trigger, state, ctx('n'));
    const b = await step.produce(trigger, state, ctx('n', 'other-seed'));
    expect(a?.type === 'payment.quoted' && b?.type === 'payment.quoted' && a.payload.midRate !== b.payload.midRate).toBe(true);
  });

  it('ignores non-approve decisions', async () => {
    const { trigger, state } = scoredFixture('US-IN', 125_000);
    const held = { ...trigger, payload: { fraudScore: 0.9, amlAlerts: [], decision: 'hold' } } as AnyEvent;
    expect(await step.produce(held, state, ctx('n'))).toBeNull();
  });
});
