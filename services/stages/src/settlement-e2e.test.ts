// End to end through every stage with the in-memory ledger: provider failures, retries, the two
// demo scenarios and reconciliation. Owned by the settlement/recon engineer.
import { afterEach, describe, expect, it } from 'vitest';
import { project, type AnyEvent, type PaymentState } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { InMemoryBus } from '@ct/event-bus';
import { createInMemoryLedger } from '@ct/ledger';
import { parseAndValidate } from '@ct/iso20022';
import { startAllStages, type StageHandle } from './runner';

let bus: InMemoryBus | undefined;
let stages: StageHandle | undefined;

afterEach(async () => {
  await stages?.stop();
  await bus?.close();
  stages = undefined;
  bus = undefined;
});

async function runPayments(n: number, scenarioOf: (i: number) => string | undefined, providerFailureScale: number) {
  bus = new InMemoryBus();
  const ledger = await createInMemoryLedger();
  stages = await startAllStages({
    bus, stageDelayMs: 0, settlementDelayMs: 0, catchUpQuietMs: 10,
    services: { ledger, sim: { seed: 'e2e', providerFailureScale } },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `e2e-${i}`;
    ids.push(id);
    const scenario = scenarioOf(i);
    await bus.publish(makeEvent('payment.initiated', id, sampleInitiatedPayload({ idempotencyKey: `k-${id}`, ...(scenario ? { scenario } : {}) })) as AnyEvent);
  }
  const deadline = Date.now() + 15_000;
  let states = new Map<string, PaymentState>();
  for (;;) {
    states = project(bus.events).states;
    if (ids.every((id) => ['reconciled', 'failed'].includes(states.get(id)?.status ?? ''))) break;
    if (Date.now() > deadline) throw new Error(`stuck: ${ids.map((id) => `${id}=${states.get(id)?.status}`).filter((s) => !/reconciled|failed/.test(s)).join(', ')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  await bus.drain();
  const ev = bus.events;
  expect(new Set(ev.map((e) => e.eventId)).size).toBe(ev.length);
  expect(project(ev).rejected).toEqual([]);
  return { ids, states, events: ev };
}

describe('settlement + reconciliation end to end', () => {
  it('provider-reject retries at another provider; recon-break reconciles with a break; others match', async () => {
    const scen = (i: number) => (i % 3 === 0 ? 'provider-reject' : i % 3 === 1 ? 'recon-break' : undefined);
    const { ids, states, events } = await runPayments(12, scen, 0);
    for (const [i, id] of ids.entries()) {
      const s = states.get(id)!;
      expect(s.status).toBe('reconciled');
      const types = events.filter((e) => e.paymentId === id).map((e) => e.type);
      const rec = s.facts['payment.reconciled']!;
      if (scen(i) === 'provider-reject') {
        expect(types.filter((t) => t === 'payment.send_failed')).toHaveLength(1);
        expect(s.facts['payment.settled']!.attempt).toBe(2);
        expect(rec.matched).toBe(true);
      } else if (scen(i) === 'recon-break') {
        expect(rec.matched).toBe(false);
        expect(rec.breaks!.join()).toMatch(/^AMOUNT_MISMATCH: statement \d+ vs ledger \d+ INR$/);
      } else {
        expect(rec).toMatchObject({ matched: true, breaks: [] });
        expect(rec.statementRef).toMatch(/^STMT-[A-Z]+-\d{8}$/);
      }
      for (const e of events.filter((x) => x.paymentId === id)) {
        const msg = (e.payload as { message?: string }).message;
        if (msg) expect(parseAndValidate(msg).errors).toEqual([]);
      }
    }
  });

  it('with a high failure scale every payment still ends reconciled or failed, never duplicated', async () => {
    const { ids, states } = await runPayments(40, () => undefined, 8);
    const failedSends = ids.reduce((n, id) => n + (states.get(id)!.history.filter((h) => h.type === 'payment.send_failed').length), 0);
    expect(failedSends).toBeGreaterThan(0);
    for (const id of ids) {
      const s = states.get(id)!;
      if (s.status === 'failed') expect(s.ledgerPosted).toBe(false);
      else expect(s.facts['payment.reconciled']!.matched).toBe(true);
    }
  });
});
