// M4 end to end with real stages + InMemoryBus + in-memory ledger: screening/risk alert chains, operator
// release / reject / retry / refund, configuration taking effect from its log position, FX shocks.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  isBalanced,
  makeControlEvent,
  project,
  SCHEMA_VERSION,
  type Actor,
  type AnyEvent,
  type ConfigKey,
  type ConfigValues,
  type EventType,
  type PayloadMap,
  type PaymentState,
} from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { InMemoryBus } from '@ct/event-bus';
import { createInMemoryLedger, type LedgerStore } from '@ct/ledger';
import { quote, shocksFromControl } from '@ct/market';
import { startAllStages, type StageHandle } from './runner';

const ANA: Actor = { userId: 'u-ana', name: 'Ana Analyst', role: 'compliance_analyst' };
const MAX: Actor = { userId: 'u-max', name: 'Max Manager', role: 'compliance_manager' };

let bus: InMemoryBus;
let ledger: LedgerStore | undefined;
let stages: StageHandle | undefined;
let n = 0;

afterEach(async () => {
  await stages?.stop();
  await bus?.close();
  stages = undefined;
});
afterAll(async () => {
  await ledger?.close(); // one PGlite ledger for the whole file (payment ids are unique per test)
});

async function setup(providerFailureScale = 0) {
  bus = new InMemoryBus();
  ledger ??= await createInMemoryLedger();
  stages = await startAllStages({ bus, stageDelayMs: 0, settlementDelayMs: 0, catchUpQuietMs: 10, services: { ledger, sim: { seed: 'm4-e2e', providerFailureScale } } });
}

const now = () => new Date().toISOString();
const stateOf = (id: string): PaymentState | undefined => project(bus.events).states.get(id);
const eventsOf = (id: string) => bus.paymentEvents.filter((e) => e.paymentId === id);

async function waitFor(id: string, status: string, timeoutMs = 10_000): Promise<PaymentState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = stateOf(id);
    if (s?.status === status) return s;
    if (Date.now() > deadline) throw new Error(`payment ${id} at ${s?.status ?? 'none'}, wanted ${status}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pay(over: Partial<PayloadMap['payment.initiated']> = {}): Promise<string> {
  n += 1;
  const id = `m4-${n}-${Math.random().toString(36).slice(2, 8)}`;
  const debtor = over.debtor ?? { name: 'Fictional Sender', country: 'US', accountId: `ACC-US-${id}` };
  await bus.publish(makeEvent('payment.initiated', id, sampleInitiatedPayload({ idempotencyKey: `k-${id}`, ...over, debtor }), { occurredAt: now() }) as AnyEvent);
  return id;
}

async function ops<T extends EventType>(type: T, id: string, payload: PayloadMap[T]) {
  const last = eventsOf(id).at(-1)!;
  await bus.publish({
    eventId: `ops-${type}-${id}`, type, schemaVersion: SCHEMA_VERSION, paymentId: id, occurredAt: now(), correlationId: id,
    causationId: last.eventId, producer: 'ops', payload,
    trace: { stage: 'ops', decision: type, reasonCodes: ['OPERATOR_ACTION'], inputs: {}, ruleVersion: 'ops-v1', latencyMs: 0 },
  } as AnyEvent);
}

let cfgVersion = 0;
async function config<K extends ConfigKey>(key: K, value: ConfigValues[K]) {
  cfgVersion += 1;
  await bus.publish(makeControlEvent('control.config.updated', { key, value, version: cfgVersion, changeRequestId: `CR-${cfgVersion}`, actor: ANA, approvedBy: MAX }, {
    eventId: `cfg-${cfgVersion}-${Math.random()}`, occurredAt: now(), producer: 'orchestrator',
  }));
}

function expectCleanLog() {
  const ids = bus.events.map((e) => e.eventId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(project(bus.events).rejected).toEqual([]);
}

describe('M4 risk chain and operator actions end to end', () => {
  it('sanctions hit -> held with the alert; release -> settles; refund -> balanced reversal journal', async () => {
    await setup();
    const id = await pay({ creditor: { name: 'Volkhov Maritime Holding', country: 'IN', accountId: 'SIM-IN-S1' } });
    const held = await waitFor(id, 'held');
    const types = eventsOf(id).map((e) => e.type);
    expect(types).toEqual(['payment.initiated', 'risk.alert_raised', 'payment.screened', 'payment.held']);
    const alert = eventsOf(id)[1]!;
    expect(alert).toMatchObject({ producer: 'screening', payload: { kind: 'sanctions', rule: 'SANCTIONS_FUZZY_MATCH', evidence: { field: 'creditor', entry: { id: 'FCL-0001' } } } });
    expect(held.facts['payment.screened']).toMatchObject({ result: 'hit' });
    expect(held.facts['payment.held']).toMatchObject({ atStage: 'risk', alertIds: [alert.type === 'risk.alert_raised' ? alert.payload.alertId : ''] });
    expect(eventsOf(id)[3]!.trace).toMatchObject({ ruleVersion: 'risk-engine-v1', inputs: { policyVersion: 'risk-engine-v1', screening: { result: 'hit' } } });

    await ops('payment.released', id, { actor: ANA, approvedBy: MAX, reason: 'False positive: different company', caseId: 'CASE-1' });
    const done = await waitFor(id, 'reconciled');
    const quoted = eventsOf(id).find((e) => e.type === 'payment.quoted')!;
    expect(quoted.trace!.reasonCodes).toContain('RELEASED_BY_OPERATOR');
    expect(done.facts['ledger.posted']).toBeDefined();

    await ops('payment.refund_requested', id, { actor: ANA, approvedBy: MAX, reason: 'Customer complaint' });
    const refunded = await waitFor(id, 'refunded');
    const settlement = done.facts['ledger.posted']!;
    const refund = refunded.facts['payment.refunded']!;
    expect(isBalanced(refund.entries)).toBe(true);
    expect(refund.entries).toEqual(settlement.entries.map((e) => ({ ...e, direction: e.direction === 'debit' ? 'credit' : 'debit' })));
    const journals = await ledger!.journals({ paymentId: id });
    expect(journals.map((j) => j.kind)).toEqual(['settlement', 'refund']);
    expect(journals[1]!.journalId).toBe(refund.journalId);
    expect((await ledger!.invariants()).ok).toBe(true);
    // idempotent per payment: a second posting returns the same journal
    const again = await ledger!.postRefund({ paymentId: id, causationEventId: 'another-request' });
    expect(again).toMatchObject({ journalId: refund.journalId, created: false });
    expect(await ledger!.journals({ paymentId: id })).toHaveLength(2);
    await bus.drain();
    expectCleanLog();
  });

  it('operator reject of a held payment is terminal: nothing moves, nothing is posted', async () => {
    await setup();
    const id = await pay({ scenario: 'force-hold' });
    await waitFor(id, 'held');
    await ops('payment.rejected', id, { actor: ANA, reason: 'Confirmed fraud', atStage: 'ops', caseId: 'CASE-2' });
    await waitFor(id, 'rejected');
    await new Promise((r) => setTimeout(r, 50));
    await bus.drain();
    expect(eventsOf(id).map((e) => e.type).slice(-2)).toEqual(['payment.held', 'payment.rejected']);
    expect(await ledger!.journals({ paymentId: id })).toEqual([]);
    expectCleanLog();
  });

  it('fraud-ring mules: alert chain (fraud + AML) then held with every alert id', async () => {
    await setup();
    const hub = { name: 'Marigold Bullion Traders', country: 'IN', accountId: 'MULE-IN-HUB' };
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await pay({ amount: { amountMinor: (9_800 + i * 40) * 100, currency: 'USD' }, debtor: { name: `Mule ${i}`, country: 'US', accountId: `MULE-US-${i}` }, creditor: hub }));
      await waitFor(ids[i]!, 'held');
    }
    const last = eventsOf(ids[3]!);
    const alerts = last.filter((e) => e.type === 'risk.alert_raised').map((e) => (e as AnyEvent & { type: 'risk.alert_raised' }).payload);
    expect(alerts.map((a) => a.rule)).toEqual(['FRAUD_MODEL_HIGH', 'AML_FAN_IN', 'AML_STRUCTURING']);
    expect(last.at(-1)).toMatchObject({ type: 'payment.held', payload: { alertIds: alerts.map((a) => a.alertId) } });
    const fanIn = alerts.find((a) => a.rule === 'AML_FAN_IN')!;
    expect(fanIn.evidence.relatedPaymentIds).toEqual(expect.arrayContaining([ids[0], ids[1], ids[2]]));
    // chain causation: each alert caused by the previous event
    for (let i = 2; i < last.length; i++) expect(last[i]!.causationId).toBe(last[i - 1]!.eventId);
    await bus.drain();
    expectCleanLog();
  });

  it('retry after failure starts a fresh attempt budget with continued attempt numbers', async () => {
    await setup();
    for (const p of ['orion', 'lyra', 'vega']) {
      await bus.publish(makeControlEvent('control.provider_outage.started', { providerId: p, mode: 'down', reason: 'test' }, { eventId: `down-${p}`, occurredAt: now(), producer: 'orchestrator' }));
    }
    const id = await pay();
    const failed = await waitFor(id, 'failed');
    expect(failed.facts['payment.failed']).toMatchObject({ attempts: 3, atStage: 'routing' });
    for (const p of ['orion', 'lyra', 'vega']) {
      await bus.publish(makeControlEvent('control.provider_outage.ended', { providerId: p }, { eventId: `up-${p}`, occurredAt: now(), producer: 'orchestrator' }));
    }
    await ops('payment.retry_requested', id, { actor: ANA, reason: 'Providers back up' });
    const done = await waitFor(id, 'reconciled');
    const routed = eventsOf(id).filter((e) => e.type === 'payment.routed').at(-1)!;
    expect(routed).toMatchObject({ payload: { attempt: 4 } });
    expect(routed.type === 'payment.routed' && routed.payload.excludedProviders).toHaveLength(3);
    expect(routed.trace!.reasonCodes).toContain('OPERATOR_RETRY_BUDGET');
    expect(done.facts['payment.settled']!.attempt).toBe(4);
    expect(await ledger!.journals({ paymentId: id })).toHaveLength(1);
    await bus.drain();
    expectCleanLog();
  });

  it('routing honours disabled providers, forced-open breakers and weights from config', async () => {
    await setup();
    const before = await pay();
    await waitFor(before, 'reconciled');
    await config('provider.enabled', { orion: false, lyra: true, vega: true });
    await config('provider.forcedBreaker', { lyra: 'open' });
    await config('routing.weights', { success: 0, cost: 1, speed: 0 });
    const id = await pay();
    const s = await waitFor(id, 'reconciled');
    const routed = s.facts['payment.routed']!;
    expect(routed.providerId).toBe('vega');
    expect(routed.scoring!.find((p) => p.providerId === 'orion')).toMatchObject({ eligible: false, excludedReason: 'PROVIDER_DISABLED' });
    expect(routed.scoring!.find((p) => p.providerId === 'lyra')).toMatchObject({ eligible: false, excludedReason: 'CIRCUIT_FORCED_OPEN' });
    const trace = eventsOf(id).find((e) => e.type === 'payment.routed')!.trace!;
    expect(trace.reasonCodes).toEqual(expect.arrayContaining(['PROVIDER_DISABLED_BY_OPERATOR', 'CIRCUIT_FORCED_OPEN_REROUTED']));
    expect(trace.inputs).toMatchObject({ weights: { success: 0, cost: 1, speed: 0 } });
    // nothing left: never fall back to an operator-excluded provider. On a FIRST attempt routing ends the
    // payment as failed (NO_ELIGIBLE_PROVIDER) — the contract allows payment.failed from 'quoted' since M4 —
    // instead of leaving it stuck; an operator can retry it once a provider is back.
    await config('provider.enabled', { orion: false, lyra: true, vega: false });
    const none = await pay();
    await waitFor(none, 'failed');
    await bus.drain();
    expect(eventsOf(none).some((e) => e.type === 'payment.routed')).toBe(false);
    expect(stateOf(none)!.facts['payment.failed']).toMatchObject({ atStage: 'routing' });
    // the payment before the config change was routed normally
    expect(stateOf(before)!.facts['payment.routed']!.scoring!.every((p) => p.excludedReason !== 'PROVIDER_DISABLED')).toBe(true);
    await bus.drain();
    expectCleanLog();
  });

  it('risk config applies only to payments after the config event', async () => {
    await setup();
    const a = await pay();
    await waitFor(a, 'reconciled');
    await config('risk.manualReviewAboveUsd', 1_000);
    const b = await pay();
    const held = await waitFor(b, 'held');
    expect(eventsOf(b).filter((e) => e.type === 'risk.alert_raised').map((e) => (e as AnyEvent & { type: 'risk.alert_raised' }).payload.rule)).toContain('AML_LARGE_VALUE_REVIEW');
    expect(eventsOf(b).at(-1)!.trace!.inputs).toMatchObject({ config: { 'risk.manualReviewAboveUsd': 1_000 }, configVersions: { 'risk.manualReviewAboveUsd': cfgVersion } });
    expect(held.facts['payment.held']!.alertIds!.length).toBeGreaterThan(0);
    expect(stateOf(a)!.status).toBe('reconciled');
    await bus.drain();
    expectCleanLog();
  });

  it('FX applies active shocks from the log, with reasons in the trace', async () => {
    await setup();
    const shock = { shockId: 'spike', corridorId: 'US-IN', driftBps: 300, noiseMultiplier: 4, rampMs: 0, reason: 'test spike' };
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await bus.publish(makeControlEvent('control.fx_shock.started', shock, { eventId: 'shock-1', occurredAt: startedAt, producer: 'orchestrator' }));
    const id = await pay();
    const s = await waitFor(id, 'reconciled');
    const q = eventsOf(id).find((e) => e.type === 'payment.quoted')!;
    const at = Date.parse(eventsOf(id).find((e) => e.type === 'payment.scored')!.occurredAt);
    const shocks = shocksFromControl({ spike: { ...shock, since: startedAt } });
    const expected = quote({ corridorId: 'US-IN', sourceAmount: s.initiated.amount, atMs: at, seed: 'm4-e2e', shocks });
    const calm = quote({ corridorId: 'US-IN', sourceAmount: s.initiated.amount, atMs: at, seed: 'm4-e2e', shocks: [] });
    expect(s.facts['payment.quoted']).toMatchObject({ midRate: expected.midRate, rate: expected.rate, spreadBps: expected.spreadBps });
    expect(expected.midRate).not.toBe(calm.midRate);
    expect(q.trace!.reasonCodes).toContain('FX_SHOCK_ACTIVE');
    expect(q.trace!.inputs).toMatchObject({ fxShocks: [{ shockId: 'spike', driftBps: 300 }] });
    // ended: quotes are calm again
    await bus.publish(makeControlEvent('control.fx_shock.ended', { shockId: 'spike' }, { eventId: 'shock-1-end', occurredAt: now(), producer: 'orchestrator' }));
    const after = await pay();
    await waitFor(after, 'reconciled');
    expect(eventsOf(after).find((e) => e.type === 'payment.quoted')!.trace!.reasonCodes).not.toContain('FX_SHOCK_ACTIVE');
    await bus.drain();
    expectCleanLog();
  });
});
