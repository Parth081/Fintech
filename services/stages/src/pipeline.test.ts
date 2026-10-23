import { afterEach, describe, expect, it } from 'vitest';
import { CORRIDORS, isBalanced, project, type AnyEvent, type PaymentState } from '@ct/contracts';
import { createInMemoryLedger } from '@ct/ledger';
import { providerProfile, quote, scheduleFee } from '@ct/market';
import type { EventBus } from '@ct/event-bus';
import { InMemoryBus } from '@ct/event-bus';
import { startPaymentApi, type PaymentApiHandle } from '@ct/payment-api';
import { startAllStages, startStage, type StageHandle, type StageOptions } from './runner';
import { STAGE_NAMES, type PipelineStage } from './steps';

const HAPPY = [
  'payment.initiated',
  'payment.screened',
  'payment.scored',
  'payment.quoted',
  'payment.routed',
  'payment.sent',
  'payment.settled',
  'ledger.posted',
  'payment.reconciled',
];

let bus: InMemoryBus;
let api: PaymentApiHandle | undefined;
let stages: StageHandle[] = [];
let base = '';
let ledger: Awaited<ReturnType<typeof createInMemoryLedger>> | undefined;
const SIM = { seed: 'test', providerFailureScale: 0 }; // failures and retries are covered in settlement/routing tests

/** Stage options with the injected ledger and a failure-free simulation, so sequences are exact. */
const opts = (bus_: EventBus, settlementDelayMs = 0): StageOptions => ({
  bus: bus_, stageDelayMs: 0, settlementDelayMs, catchUpQuietMs: 10, services: { ledger, sim: SIM },
});

async function setup(settle: { settlementDelayMs?: number; withStages?: boolean } = {}) {
  bus = new InMemoryBus();
  ledger = await createInMemoryLedger();
  api = await startPaymentApi({ bus, port: 0, catchUpQuietMs: 10 });
  base = `http://127.0.0.1:${api.port}`;
  if (settle.withStages !== false) stages.push(await startAllStages(opts(bus, settle.settlementDelayMs ?? 0)));
}

async function stopStages() {
  await Promise.all(stages.map((s) => s.stop()));
  stages = [];
}

afterEach(async () => {
  await stopStages();
  await api?.close();
  api = undefined;
  await bus?.close();
  await ledger?.close();
  ledger = undefined;
});

async function send(body: unknown = {}, path = '/payments/sample'): Promise<string> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(202);
  return ((await res.json()) as { paymentId: string }).paymentId;
}

const eventsOf = (paymentId: string) => bus.paymentEvents.filter((e) => e.paymentId === paymentId);
const stateOf = (paymentId: string): PaymentState | undefined => project(bus.events).states.get(paymentId);

async function waitForStatus(paymentId: string, status: string, timeoutMs = 10_000): Promise<PaymentState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = stateOf(paymentId);
    if (s?.status === status) return s;
    if (Date.now() > deadline) throw new Error(`payment ${paymentId} stuck at ${s?.status ?? 'none'}, wanted ${status}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function expectNoDuplicates() {
  const ids = bus.events.map((e) => e.eventId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(project(bus.events).rejected).toEqual([]);
}

describe('pipeline (API -> reconciled)', () => {
  it('moves one payment through every stage with traces and causation chain', async () => {
    await setup();
    const id = await send();
    await waitForStatus(id, 'reconciled');
    await bus.drain();
    const events = eventsOf(id);
    expect(events.map((e) => e.type)).toEqual(HAPPY);
    expect(events.map((e) => e.producer)).toEqual(['payment-api', 'screening', 'risk', 'fx', 'routing', 'settlement', 'settlement', 'ledger', 'reconciliation']);
    for (let i = 1; i < events.length; i++) {
      const e = events[i]!;
      expect(e.causationId).toBe(events[i - 1]!.eventId);
      expect(e.correlationId).toBe(id);
      expect(e.trace).toMatchObject({ stage: e.producer, ruleVersion: expect.stringMatching(/^[a-z0-9-]+-v\d+$/) });
      expect(e.trace!.reasonCodes.length).toBeGreaterThan(0);
      expect(e.trace!.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof e.trace!.decision).toBe('string');
    }
    const scored = events.find((e) => e.type === 'payment.scored');
    expect(scored?.type === 'payment.scored' && scored.payload.fraudScore).toBeLessThanOrEqual(0.2);
    expectNoDuplicates();
  });

  it('force-hold ends in held at risk with no later events', async () => {
    await setup();
    const id = await send({ scenario: 'force-hold' });
    await waitForStatus(id, 'held');
    await new Promise((r) => setTimeout(r, 50));
    await bus.drain();
    const events = eventsOf(id);
    expect(events.map((e) => e.type)).toEqual(['payment.initiated', 'payment.screened', 'payment.held']);
    expect(events[2]).toMatchObject({ producer: 'risk', payload: { reason: 'Manual review (scenario)', atStage: 'risk' } });
    expectNoDuplicates();
  });

  it.each([
    ['US-IN', 125_000],
    ['DE-BR', 50_000],
    ['GB-PH', 100_000],
  ])('quotes, routes and posts a balanced ledger for %s', async (corridorId, amountMinor) => {
    await setup();
    const c = CORRIDORS.find((x) => x.id === corridorId)!;
    const id = await send(
      {
        amount: { amountMinor, currency: c.sourceCurrency },
        targetCurrency: c.targetCurrency,
        corridor: c.id,
        debtor: { name: 'Fictional Sender', country: c.sourceCountry, accountId: 'ACC-SRC-1' },
        creditor: { name: 'Fictional Receiver', country: c.targetCountry, accountId: 'ACC-TGT-1' },
      },
      '/payments',
    );
    const state = await waitForStatus(id, 'reconciled');
    const source = { amountMinor, currency: c.sourceCurrency };

    // FX: priced from the market at the scored trigger's time (deterministic for the seed)
    const scoredAt = Date.parse(eventsOf(id).find((e) => e.type === 'payment.scored')!.occurredAt);
    const expected = quote({ corridorId: c.id, sourceAmount: source, atMs: scoredAt, seed: SIM.seed });
    const quoted = state.facts['payment.quoted']!;
    expect(quoted).toMatchObject({
      rate: expected.rate, midRate: expected.midRate, spreadBps: expected.spreadBps,
      sourceAmount: source, targetAmount: expected.targetAmount, expiresAt: expected.expiresAt,
    });
    expect(quoted.targetAmount.currency).toBe(c.targetCurrency);

    // Routing: the best-scoring eligible provider, with every provider explained and its catalogue fee
    const routed = state.facts['payment.routed']!;
    expect(routed.scoring).toHaveLength(3);
    const eligible = routed.scoring!.filter((p) => p.eligible);
    const best = Math.max(...eligible.map((p) => p.score));
    expect(eligible.find((p) => p.providerId === routed.providerId)?.score).toBe(best);
    const fee = scheduleFee(source, providerProfile(routed.providerId)!.fees[c.id]!);
    expect(routed.estimatedFee).toEqual(fee);
    expect(routed.attempt).toBe(1);

    // Ledger: one balanced 5-line journal; customer pays amount + fee
    const target = quoted.targetAmount;
    const entries = state.facts['ledger.posted']!.entries;
    expect(isBalanced(entries)).toBe(true);
    expect(entries).toHaveLength(5);
    expect(entries).toEqual(expect.arrayContaining([
      { account: `customer:ACC-SRC-1:${c.sourceCurrency}`, direction: 'debit', amount: { amountMinor: amountMinor + fee.amountMinor, currency: c.sourceCurrency } },
      { account: `fx-position:${c.sourceCurrency}`, direction: 'credit', amount: source },
      { account: `fee-revenue:${c.sourceCurrency}`, direction: 'credit', amount: fee },
      { account: `fx-position:${c.targetCurrency}`, direction: 'debit', amount: target },
      { account: `provider:${routed.providerId}:payable:${c.targetCurrency}`, direction: 'credit', amount: target },
    ]));
    expect(await ledger!.journals({ paymentId: id })).toHaveLength(1);
    expect((await ledger!.invariants()).ok).toBe(true);
    expect(state.facts['payment.reconciled']).toMatchObject({ matched: true, breaks: [], statementRef: expect.stringMatching(/^STMT-[A-Z]+-\d{8}$/) });
    expect(state.facts['payment.sent']).toMatchObject({ messageType: 'pacs.008' });
    expect(state.facts['payment.settled']).toMatchObject({ statusMessage: 'pacs.002' });
  });

  it('completes payments after stages are stopped midway and restarted, with no duplicate events', async () => {
    await setup({ settlementDelayMs: 40 });
    const ids = await Promise.all(Array.from({ length: 5 }, () => send()));
    await waitForStatus(ids[0]!, 'sent'); // stop while settlement is waiting
    await stopStages();
    const midway = bus.events.length;
    expect(ids.some((id) => stateOf(id)?.status !== 'reconciled')).toBe(true);

    // payments submitted while every stage is down
    const more = await Promise.all(Array.from({ length: 3 }, () => send()));
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.events.length).toBe(midway + 3);

    // bring back only the first two stages, then stop again
    for (const name of ['screening', 'risk'] as PipelineStage[]) {
      stages.push(await startStage(name, opts(bus)));
    }
    for (const id of more) await waitForStatus(id, 'scored');
    await stopStages();

    stages.push(await startAllStages(opts(bus)));
    for (const id of [...ids, ...more]) {
      await waitForStatus(id, 'reconciled');
      expect(eventsOf(id).map((e) => e.type)).toEqual(HAPPY);
    }
    await bus.drain();
    expectNoDuplicates();
  });

  it('does not create new events when a trigger is redelivered', async () => {
    await setup();
    const id = await send();
    await waitForStatus(id, 'reconciled');
    await bus.drain();
    const distinctBefore = new Set(bus.events.map((e) => e.eventId));

    // 1) producers retry the same events (at-least-once); the bus must not append copies
    for (const e of eventsOf(id)) await bus.publish(structuredClone(e));
    // 2) every stage re-reads the whole log as if its committed offset had been lost
    const amnesiac: EventBus = {
      publish: (e) => bus.publish(e),
      head: () => bus.head(),
      subscribe: (o, h) => bus.subscribe(o.ephemeral ? o : { ...o, group: `${o.group}-lost-offsets` }, h),
      close: async () => {},
    };
    stages.push(await startAllStages(opts(amnesiac)));
    await new Promise((r) => setTimeout(r, 50));
    await bus.drain();

    expect(new Set(bus.events.map((e) => e.eventId))).toEqual(distinctBefore);
    expect(bus.events.length).toBe(distinctBefore.size); // idempotent append: re-published copies are no-ops
    expect(stateOf(id)?.status).toBe('reconciled');
  });

  it('never acts on a trigger that is not a valid transition', async () => {
    await setup();
    const id = await send({ scenario: 'force-hold' });
    await waitForStatus(id, 'held');
    // a stray scored event for a held payment: invalid, so fx must not quote it
    const screened = eventsOf(id).find((e) => e.type === 'payment.screened')!;
    await bus.publish({ ...screened, eventId: 'bogus-scored', type: 'payment.scored', producer: 'risk', payload: { fraudScore: 0, amlAlerts: [], decision: 'approve' } } as AnyEvent);
    await new Promise((r) => setTimeout(r, 30));
    await bus.drain();
    expect(eventsOf(id).map((e) => e.type)).toEqual(['payment.initiated', 'payment.screened', 'payment.held', 'payment.scored']);
  });

  it('runs 20 concurrent payments to reconciled', async () => {
    await setup();
    const ids = await Promise.all(Array.from({ length: 20 }, () => send()));
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) {
      await waitForStatus(id, 'reconciled');
      expect(eventsOf(id).map((e) => e.type)).toEqual(HAPPY);
    }
    await bus.drain();
    expectNoDuplicates();
    expect(bus.events).toHaveLength(20 * HAPPY.length);
  });

  it('exposes all seven stages', () => {
    expect(STAGE_NAMES).toEqual(['screening', 'risk', 'fx', 'routing', 'settlement', 'ledger', 'reconciliation']);
  });
});
