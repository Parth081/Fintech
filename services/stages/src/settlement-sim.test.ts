import { describe, expect, it } from 'vitest';
import { project, type AnyEvent, type PaymentState } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { parseAndValidate, uetrFor } from '@ct/iso20022';
import { providerProfile } from '@ct/market';
import { buildEvent } from './runner';
import type { Outcome, StageServices, StepContext } from './steps/common';
import { settlementDraw, settlementSteps } from './steps/settlement';

const [routedStep, sentStep] = settlementSteps as [(typeof settlementSteps)[number], (typeof settlementSteps)[number]];

const INR = { amountMinor: 10_369_828, currency: 'INR' };
const USD = { amountMinor: 125_000, currency: 'USD' };

function upToRouted(paymentId: string, opts: { scenario?: string; providerId?: string; attempt?: number } = {}): AnyEvent[] {
  return [
    makeEvent('payment.initiated', paymentId, sampleInitiatedPayload({ idempotencyKey: `k-${paymentId}`, ...(opts.scenario ? { scenario: opts.scenario } : {}) })),
    makeEvent('payment.screened', paymentId, { result: 'clear', listVersion: 'fict-2026.1' }, { producer: 'screening' }),
    makeEvent('payment.scored', paymentId, { fraudScore: 0.04, amlAlerts: [], decision: 'approve' }, { producer: 'risk' }),
    makeEvent('payment.quoted', paymentId, { quoteId: 'q-1', rate: '82.958625', spreadBps: 35, sourceAmount: USD, targetAmount: INR, expiresAt: '2026-10-22T10:00:30.000Z' }, { producer: 'fx' }),
    makeEvent('payment.routed', paymentId, {
      providerId: opts.providerId ?? 'orion', rail: 'Rail-A (instant)', estimatedFee: { amountMinor: 150, currency: 'USD' }, alternatives: [], attempt: opts.attempt ?? 1,
    }, { producer: 'routing', occurredAt: '2026-10-22T10:00:01.000Z' }),
  ] as AnyEvent[];
}

const ctx = (sim?: StageServices['sim'], states: Map<string, PaymentState> = new Map()): StepContext => ({
  now: '2026-10-22T10:00:05.000Z',
  services: sim ? { sim } : {},
  view: { states },
});

async function run(events: AnyEvent[], sim?: StageServices['sim']) {
  const stateOf = () => project(events).states.get(events[0]!.paymentId)!;
  const routed = events[events.length - 1]!;
  const sentOutcome = (await routedStep.produce(routed, stateOf(), ctx(sim))) as Outcome;
  const sent = buildEvent('settlement', routed, sentOutcome, '2026-10-22T10:00:02.000Z', 0);
  events.push(sent);
  const outcome = (await sentStep.produce(sent, stateOf(), ctx(sim))) as Outcome;
  const result = buildEvent('settlement', sent, outcome, '2026-10-22T10:00:03.000Z', 0);
  events.push(result);
  expect(project(events).rejected).toEqual([]);
  return { sent, result, state: stateOf() };
}

describe('settlement: routed -> sent', () => {
  it('builds a valid pacs.008 with the quoted amounts, provider BIC and per-attempt message id', async () => {
    const { sent } = await run(upToRouted('pay-1'), { seed: 's', providerFailureScale: 0 });
    if (sent.type !== 'payment.sent') throw new Error('expected sent');
    expect(sent.payload).toMatchObject({ providerId: 'orion', messageType: 'pacs.008', attempt: 1 });
    expect(sent.payload.messageId).toMatch(/^MSG-[0-9A-F]{12}$/);
    const xml = sent.payload.message!;
    expect(parseAndValidate(xml)).toMatchObject({ ok: true, messageType: 'pacs.008', errors: [] });
    expect(xml).toContain('<IntrBkSttlmAmt Ccy="INR">103698.28</IntrBkSttlmAmt>');
    expect(xml).toContain('<InstdAmt Ccy="USD">1250.00</InstdAmt>');
    expect(xml).toContain('<XchgRate>82.958625</XchgRate>');
    expect(xml).toContain(`<BICFI>${providerProfile('orion')!.bic}</BICFI>`);
    expect(xml).toContain('<EndToEndId>pay-1</EndToEndId>');
    expect(sent.trace?.ruleVersion).toBe('settlement-sim-v1');

    const again = await run(upToRouted('pay-1'), { seed: 's', providerFailureScale: 0 });
    expect(again.sent.payload).toEqual(sent.payload); // deterministic

    const second = await run(upToRouted('pay-1', { attempt: 2, providerId: 'vega' }), { seed: 's', providerFailureScale: 0 });
    if (second.sent.type !== 'payment.sent') throw new Error('expected sent');
    expect(second.sent.payload.messageId).not.toBe(sent.payload.messageId);
    expect(second.sent.payload.attempt).toBe(2);
  });

  it('ignores a stale routed trigger (an earlier attempt)', async () => {
    const events = upToRouted('pay-stale');
    const r1 = events[events.length - 1]!;
    const state = project(events).states.get('pay-stale')!;
    const newer = { ...state, facts: { ...state.facts, 'payment.routed': { ...state.facts['payment.routed']!, attempt: 2, providerId: 'vega' } } };
    expect(await routedStep.produce(r1, newer, ctx())).toBeNull();
  });
});

describe('settlement: sent -> settled | send_failed', () => {
  it('settles with ACSC pacs.002, value date and a statement entry', async () => {
    const { result } = await run(upToRouted('pay-ok'), { seed: 's', providerFailureScale: 0 });
    if (result.type !== 'payment.settled') throw new Error(`expected settled, got ${result.type}`);
    const p = result.payload;
    expect(p).toMatchObject({ providerId: 'orion', statusMessage: 'pacs.002', attempt: 1, settledAmount: INR, valueDate: '2026-10-22' });
    expect(p.settlementRef).toMatch(/^STL-/);
    expect(p.statementEntry).toMatchObject({ statementId: 'STMT-ORION-20261022', providerId: 'orion', amount: INR, bookingDate: '2026-10-22', endToEndId: 'pay-ok' });
    expect(p.statementEntry!.entryRef).toMatch(/^NTRY-[0-9A-F]{12}$/);
    expect(parseAndValidate(p.message!)).toMatchObject({ ok: true, messageType: 'pacs.002', errors: [] });
    expect(p.message).toContain('<TxSts>ACSC</TxSts>');
    expect(p.message).toContain(`<OrgnlUETR>${uetrFor('pay-ok')}</OrgnlUETR>`);
    expect(result.trace).toMatchObject({ decision: 'settled', ruleVersion: 'settlement-sim-v1' });
    expect(result.trace!.inputs).toMatchObject({ providerId: 'orion', attempt: 1, failureProbability: 0 });
  });

  it('same input gives the same outcome and the same XML', async () => {
    const a = await run(upToRouted('pay-det'), { seed: 'x', providerFailureScale: 5 });
    const b = await run(upToRouted('pay-det'), { seed: 'x', providerFailureScale: 5 });
    expect(b.result.type).toBe(a.result.type);
    expect(b.result.payload).toEqual(a.result.payload);
    // redelivery of the very same trigger against the same state: identical outcome
    const events = upToRouted('pay-det2');
    const sim = { seed: 'x', providerFailureScale: 5 };
    await run(events, sim);
    const sent = events[events.length - 2]!;
    const before = project(events.slice(0, -1)).states.get('pay-det2')!;
    const o1 = await sentStep.produce(sent, before, ctx(sim));
    const o2 = await sentStep.produce(sent, before, { ...ctx(sim), now: '2027-01-01T00:00:00.000Z' });
    expect(o2).toEqual(o1);
  });

  it('provider-reject fails attempt 1 with a RJCT pacs.002, and a retry at another provider settles', async () => {
    const first = await run(upToRouted('pay-rej', { scenario: 'provider-reject' }), { seed: 's', providerFailureScale: 0 });
    if (first.result.type !== 'payment.send_failed') throw new Error(`expected send_failed, got ${first.result.type}`);
    expect(first.result.payload).toMatchObject({ providerId: 'orion', attempt: 1, reasonCode: 'AG01', statusMessage: 'pacs.002' });
    expect(first.result.payload.reason.length).toBeGreaterThan(10);
    expect(parseAndValidate(first.result.payload.message!)).toMatchObject({ ok: true, errors: [] });
    expect(first.result.payload.message).toContain('<TxSts>RJCT</TxSts>');
    expect(first.result.trace!.reasonCodes).toEqual(expect.arrayContaining(['PROVIDER_REJECTED', 'AG01', 'SCENARIO_PROVIDER_REJECT']));
    expect(first.state.status).toBe('retrying');

    // routing re-routes (attempt 2, vega); the simulator now settles
    const events = [...upToRouted('pay-rej', { scenario: 'provider-reject' })];
    const sim = { seed: 's', providerFailureScale: 0 };
    const r1 = await run(events, sim);
    expect(r1.result.type).toBe('payment.send_failed');
    events.push(makeEvent('payment.routed', 'pay-rej', {
      providerId: 'vega', rail: 'Rail-C (correspondent)', estimatedFee: { amountMinor: 300, currency: 'USD' }, alternatives: [], attempt: 2, excludedProviders: ['orion'],
    }, { producer: 'routing' }) as AnyEvent);
    const r2 = await run(events, sim);
    expect(r2.result.type).toBe('payment.settled');
    expect(r2.state.status).toBe('settled');
  });

  it('scale 0 never fails (10k draws)', () => {
    for (let i = 0; i < 10_000; i++) {
      for (const providerId of ['orion', 'lyra', 'vega']) {
        expect(settlementDraw({ paymentId: `p-${i}`, attempt: 1, providerId }, { seed: 'control-tower', providerFailureScale: 0 }).fail).toBe(false);
      }
    }
  });

  it.each([
    ['lyra', 1],
    ['orion', 1],
    ['lyra', 3],
  ])('failure rate for %s at scale %d is near (1 - baseSuccessRate) x scale over 10k draws', (providerId, scale) => {
    const p = (1 - providerProfile(providerId)!.baseSuccessRate) * scale;
    const n = 10_000;
    let fails = 0;
    const codes = new Set<string>();
    for (let i = 0; i < n; i++) {
      const d = settlementDraw({ paymentId: `p-${i}`, attempt: 1, providerId }, { seed: 'control-tower', providerFailureScale: scale });
      if (d.fail) {
        fails++;
        codes.add(d.reasonCode!);
      }
    }
    const sd = Math.sqrt((p * (1 - p)) / n);
    expect(Math.abs(fails / n - p)).toBeLessThan(4 * sd);
    expect(codes.size).toBeGreaterThan(1); // reasons vary
  });

  it('defaults to seed control-tower and scale 1 when no sim service is injected', () => {
    const d = settlementDraw({ paymentId: 'p', attempt: 1, providerId: 'orion' }, undefined);
    expect(d).toMatchObject({ seed: 'control-tower', providerFailureScale: 1 });
    expect(d.failureProbability).toBeCloseTo(0.03, 10);
  });

  it('recon-break settles 1 minor unit short, in the statement entry too', async () => {
    const { result } = await run(upToRouted('pay-brk', { scenario: 'recon-break' }), { seed: 's', providerFailureScale: 0 });
    if (result.type !== 'payment.settled') throw new Error('expected settled');
    expect(result.payload.settledAmount).toEqual({ amountMinor: INR.amountMinor - 1, currency: 'INR' });
    expect(result.payload.statementEntry!.amount).toEqual(result.payload.settledAmount);
    expect(result.trace!.reasonCodes).toContain('SCENARIO_RECON_BREAK');
  });
});
