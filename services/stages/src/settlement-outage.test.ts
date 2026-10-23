// Settlement honours control.provider_outage.* (M3): 'down' rejects everything, 'degraded' rejects by a
// deterministic hash draw, outside outages nothing changes.
import { describe, expect, it } from 'vitest';
import { applyControl, INITIAL_CONTROL_STATE, makeControlEvent, project, type AnyEvent, type ControlState, type PaymentState } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { parseAndValidate } from '@ct/iso20022';
import { buildEvent } from './runner';
import type { Outcome, StageServices, StepContext } from './steps/common';
import { OUTAGE_DOWN_TEXT, outageDraw, settlementSteps } from './steps/settlement';

const [routedStep, sentStep] = settlementSteps as [(typeof settlementSteps)[number], (typeof settlementSteps)[number]];
const SIM: StageServices['sim'] = { seed: 'outage-test', providerFailureScale: 0 }; // no random rejects

function outage(mode: 'down' | 'degraded', failureRate?: number, providerId = 'orion'): ControlState {
  const e = makeControlEvent(
    'control.provider_outage.started',
    { providerId, mode, ...(failureRate !== undefined ? { failureRate } : {}), reason: 'Scenario: provider outage', runId: 'run-1' },
    { eventId: `c-${mode}-${failureRate}`, occurredAt: '2026-10-22T10:00:00.500Z', producer: 'orchestrator' },
  );
  return applyControl(INITIAL_CONTROL_STATE, e, 7);
}

const ctx = (control: ControlState): StepContext => ({ now: '2026-10-22T10:00:05.000Z', services: { sim: SIM }, view: { states: new Map() }, control });

function upToRouted(paymentId: string, providerId = 'orion'): AnyEvent[] {
  return [
    makeEvent('payment.initiated', paymentId, sampleInitiatedPayload({ idempotencyKey: `k-${paymentId}` })),
    makeEvent('payment.screened', paymentId, { result: 'clear', listVersion: 'fict-2026.1' }, { producer: 'screening' }),
    makeEvent('payment.scored', paymentId, { fraudScore: 0.04, amlAlerts: [], decision: 'approve' }, { producer: 'risk' }),
    makeEvent('payment.quoted', paymentId, {
      quoteId: 'q-1', rate: '82.958625', spreadBps: 35, sourceAmount: { amountMinor: 125_000, currency: 'USD' }, targetAmount: { amountMinor: 10_369_828, currency: 'INR' }, expiresAt: '2026-10-22T10:00:30.000Z',
    }, { producer: 'fx' }),
    makeEvent('payment.routed', paymentId, { providerId, rail: 'Rail-A (instant)', estimatedFee: { amountMinor: 150, currency: 'USD' }, alternatives: [], attempt: 1 }, { producer: 'routing', occurredAt: '2026-10-22T10:00:01.000Z' }),
  ] as AnyEvent[];
}

async function settle(paymentId: string, control: ControlState, providerId = 'orion') {
  const events = upToRouted(paymentId, providerId);
  const stateOf = (): PaymentState => project(events).states.get(paymentId)!;
  const routed = events.at(-1)!;
  // the routed -> sent step is not affected by outages
  const sentOutcome = (await routedStep.produce(routed, stateOf(), ctx(control))) as Outcome;
  expect(sentOutcome.type).toBe('payment.sent');
  const sent = buildEvent('settlement', routed, sentOutcome, '2026-10-22T10:00:02.000Z', 0);
  events.push(sent);
  const outcome = (await sentStep.produce(sent, stateOf(), ctx(control))) as Outcome;
  const again = await sentStep.produce(sent, stateOf(), ctx(control));
  expect(again).toEqual(outcome); // deterministic per trigger
  const result = buildEvent('settlement', sent, outcome, '2026-10-22T10:00:03.000Z', 0);
  events.push(result);
  expect(project(events).rejected).toEqual([]);
  return { outcome, result, state: stateOf() };
}

describe('settlement during a provider outage', () => {
  it("'down' rejects with pacs.002 RJCT NARR 'Provider unavailable (outage)' and explains it", async () => {
    const { outcome, result, state } = await settle('down-1', outage('down'));
    expect(outcome.type).toBe('payment.send_failed');
    if (result.type !== 'payment.send_failed') throw new Error('expected send_failed');
    expect(result.payload).toMatchObject({ providerId: 'orion', attempt: 1, reasonCode: 'NARR', reason: OUTAGE_DOWN_TEXT, statusMessage: 'pacs.002' });
    expect(state.status).toBe('retrying');
    expect(outcome.reasonCodes).toEqual(['PROVIDER_REJECTED', 'PROVIDER_OUTAGE', 'OUTAGE_DOWN', 'NARR']);
    expect(outcome.inputs).toMatchObject({
      outage: { providerId: 'orion', mode: 'down', failureRate: 1, since: '2026-10-22T10:00:00.500Z', runId: 'run-1' },
      controlAsOfOffset: 7,
    });
    const xml = result.payload.message!;
    expect(parseAndValidate(xml)).toMatchObject({ ok: true, messageType: 'pacs.002', errors: [] });
    expect(xml).toContain('<TxSts>RJCT</TxSts>');
    expect(xml).toContain('<Cd>NARR</Cd>');
    expect(xml).toContain(`<AddtlInf>${OUTAGE_DOWN_TEXT}</AddtlInf>`);
  });

  it('only affects the provider that is down', async () => {
    const { outcome } = await settle('other-1', outage('down', undefined, 'orion'), 'vega');
    expect(outcome.type).toBe('payment.settled');
    expect(outcome.inputs.outage).toBeUndefined();
  });

  it("'degraded' rejects about failureRate of instructions, by a deterministic hash draw", async () => {
    const control = outage('degraded', 0.4);
    let failed = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const id = `deg-${i}`;
      const { outcome } = await settle(id, control);
      const d = outageDraw({ paymentId: id, attempt: 1, providerId: 'orion' }, control.outages.orion, SIM)!;
      expect(outcome.type).toBe(d.fail ? 'payment.send_failed' : 'payment.settled');
      expect(outcome.inputs.outage).toMatchObject({ mode: 'degraded', failureRate: 0.4, draw: Number(d.draw!.toFixed(6)) });
      if (d.fail) {
        failed++;
        expect(outcome.reasonCodes).toEqual(['PROVIDER_REJECTED', 'PROVIDER_OUTAGE', 'OUTAGE_DEGRADED', 'NARR']);
      } else expect(outcome.reasonCodes).toContain('OUTAGE_DEGRADED_PASSED');
    }
    expect(failed / N).toBeGreaterThan(0.2);
    expect(failed / N).toBeLessThan(0.6);
    expect(outageDraw({ paymentId: 'x', attempt: 1, providerId: 'orion' }, outage('degraded', 1).outages.orion, SIM)!.fail).toBe(true);
    expect(outageDraw({ paymentId: 'x', attempt: 1, providerId: 'orion' }, outage('degraded', 0).outages.orion, SIM)!.fail).toBe(false);
  });

  it('outside an outage (and after it ended) behaviour is unchanged', async () => {
    const none = await settle('none-1', INITIAL_CONTROL_STATE);
    expect(none.outcome.type).toBe('payment.settled');
    expect(none.outcome.reasonCodes).toEqual(['PROVIDER_CONFIRMED', 'ACSC']);
    expect(none.outcome.inputs.outage).toBeUndefined();
    const ended = applyControl(
      outage('down'),
      makeControlEvent('control.provider_outage.ended', { providerId: 'orion', runId: 'run-1' }, { eventId: 'c-end', occurredAt: '2026-10-22T10:00:01.500Z', producer: 'orchestrator' }),
      9,
    );
    const after = await settle('after-1', ended);
    expect(after.outcome.type).toBe('payment.settled');
    expect(after.outcome.inputs.outage).toBeUndefined();
  });
});
