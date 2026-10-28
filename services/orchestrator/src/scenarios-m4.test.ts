// M4 scenario engine: FX shock actions, crafted payments on the scenario clock, and the three M4 scripts.
import { afterEach, describe, expect, it } from 'vitest';
import { ControlTimeline, deterministicId, isControlEvent, makeControlEvent, type ControlEvent } from '@ct/contracts';
import { InMemoryBus } from '@ct/event-bus';
import type { GeneratedPayment } from '../../../tools/traffic/generator';
import type { SendResult } from '../../../tools/traffic/send';
import { FakeClock } from './clock';
import { startOrchestrator, type OrchestratorHandle } from './orchestrator';
import { craftedKey, craftedRequest, runTag, SCENARIOS, validateScript, type ScenarioScript } from './scenarios';
import { FRAUD_RING, FRAUD_RING_FAN_IN, FRAUD_RING_FAN_OUT, FX_SPIKE, SANCTIONS_HIT } from './scenarios-m4';

interface Sent {
  at: number;
  key: string;
  body: GeneratedPayment['body'];
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

/** Orchestrator with a fake sender that records every crafted payment (ambient ones are ignored). */
async function setup(opts: { bus?: InMemoryBus; failFirst?: number } = {}) {
  const bus = opts.bus ?? new InMemoryBus();
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const keys = new Set<string>();
  let failures = opts.failFirst ?? 0;
  const send = async (_url: string, p: GeneratedPayment): Promise<SendResult> => {
    if (!p.idempotencyKey.startsWith('scenario-')) return { outcome: 'accepted', status: 202, paymentId: p.idempotencyKey };
    if (failures > 0) {
      failures -= 1;
      return { outcome: 'error', status: 503, detail: 'unavailable' };
    }
    const dup = keys.has(p.idempotencyKey);
    keys.add(p.idempotencyKey);
    if (!dup) sent.push({ at: clock.now(), key: p.idempotencyKey, body: p.body });
    return { outcome: dup ? 'duplicate' : 'accepted', status: 202, paymentId: p.idempotencyKey };
  };
  const orch = await startOrchestrator({ bus, clock, host: '127.0.0.1', port: 0, seed: 'm4-seed', ambientRate: 0, paymentApiUrl: 'http://127.0.0.1:1', send });
  cleanups.push(() => orch.close());
  const base = `http://127.0.0.1:${orch.port}`;
  return { bus, clock, orch, base, sent };
}

async function post(base: string, path: string, body: unknown = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function advance(clock: FakeClock, orch: OrchestratorHandle, ms: number, slice = 500) {
  for (let done = 0; done < ms; done += slice) {
    await clock.advance(Math.min(slice, ms - done));
    await orch.idle();
    await new Promise((r) => setImmediate(r));
  }
}

const controls = (bus: InMemoryBus) => bus.events.filter(isControlEvent) as ControlEvent[];
const label = (e: ControlEvent) => (e.type === 'control.scenario.step' ? `step:${e.payload.stepId}` : e.type.replace('control.', ''));
function controlState(bus: InMemoryBus) {
  const t = new ControlTimeline();
  bus.events.forEach((e, i) => {
    if (isControlEvent(e)) t.apply(e, i);
  });
  return t.current();
}

describe('M4 scenario scripts', () => {
  it('are valid, about the right length, and narrate every step', () => {
    for (const s of [FRAUD_RING, FX_SPIKE, SANCTIONS_HIT]) {
      expect(() => validateScript(s)).not.toThrow();
      expect(SCENARIOS).toContain(s);
      for (const step of s.steps) expect(step.narration?.length ?? 0).toBeGreaterThan(40);
    }
    expect(FRAUD_RING.durationMs).toBe(60_000);
    expect(FX_SPIKE.durationMs).toBe(60_000);
    expect(SANCTIONS_HIT.durationMs).toBeLessThanOrEqual(60_000);
  });

  it('fraud ring: fan-in from new accounts to one beneficiary, structured just below 10,000, plus a fan-out leg', () => {
    expect(FRAUD_RING_FAN_IN.length).toBeGreaterThanOrEqual(6);
    expect(new Set(FRAUD_RING_FAN_IN.map((p) => p.creditor.accountId)).size).toBe(1);
    expect(new Set(FRAUD_RING_FAN_IN.map((p) => p.debtor.accountId)).size).toBe(FRAUD_RING_FAN_IN.length);
    for (const p of FRAUD_RING_FAN_IN) expect(p.amount.amountMinor).toBeGreaterThan(900_000), expect(p.amount.amountMinor).toBeLessThan(1_000_000);
    expect(new Set(FRAUD_RING_FAN_OUT.map((p) => p.debtor.accountId)).size).toBe(1);
    expect(new Set(FRAUD_RING_FAN_OUT.map((p) => p.creditor.accountId)).size).toBe(FRAUD_RING_FAN_OUT.length);
  });

  it('crafted accounts are new in every run; keys are deterministic', () => {
    const a = craftedRequest(FRAUD_RING_FAN_IN[0]!, 'run-1-fraud-ring');
    const b = craftedRequest(FRAUD_RING_FAN_IN[0]!, 'run-2-fraud-ring');
    expect(a.debtor.accountId).toBe(`MULE-US-${runTag('run-1-fraud-ring')}-01`);
    expect(a.debtor.accountId).not.toBe(b.debtor.accountId);
    expect(a.debtor.accountId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    expect(craftedRequest(FRAUD_RING_FAN_IN[0]!, 'run-1-fraud-ring')).toEqual(a);
    expect(FRAUD_RING_FAN_IN[0]!.debtor.accountId).toContain('{run}'); // the script itself is not mutated
    expect(craftedKey('run-1-fraud-ring', 'mules-pay-in', 'fan-in', 3)).toBe('scenario-run-1-fraud-ring-mules-pay-in-fan-in-3');
  });

  it('validation rejects open FX shocks, mismatched corridors and sends that outlast the scenario', () => {
    const base: ScenarioScript = { id: 't', title: 't', description: 't', durationMs: 10_000, steps: [] };
    const shock = { kind: 'fx_shock.start', shockId: 'x', corridorId: 'GB-PH', driftBps: 100, noiseMultiplier: 2, rampMs: 0, reason: 'r' } as const;
    expect(() => validateScript({ ...base, steps: [{ id: 'a', atMs: 0, title: 'a', actions: [shock] }] })).toThrow(/FX shock left open/);
    expect(() => validateScript({ ...base, steps: [{ id: 'a', atMs: 0, title: 'a', actions: [{ ...shock, corridorId: 'XX-YY' }] }] })).toThrow(/unknown corridor/);
    expect(() => validateScript({ ...base, steps: [{ id: 'a', atMs: 0, title: 'a', actions: [{ kind: 'fx_shock.end', shockId: 'x' }] }] })).toThrow(/never started/);
    const p = FRAUD_RING_FAN_IN[0]!;
    expect(() => validateScript({ ...base, steps: [{ id: 'a', atMs: 0, title: 'a', actions: [{ kind: 'payments.send', label: 'x', payments: [{ ...p, corridor: 'GB-PH' }] }] }] })).toThrow(/does not match corridor/);
    expect(() => validateScript({ ...base, steps: [{ id: 'a', atMs: 5_000, title: 'a', actions: [{ kind: 'payments.send', label: 'x', payments: [p, p, p], spacingMs: 3_000 }] }] })).toThrow(/still sending/);
    expect(() => validateScript({ ...base, steps: [{ id: 'a', atMs: 0, title: 'a', actions: [{ kind: 'payments.send', label: 'Bad Label', payments: [p] }] }] })).toThrow(/slug/);
  });
});

describe('M4 scenario engine', () => {
  it('fx-spike publishes the shock and its end at the scripted times, with deterministic ids, and sends quotes traffic', async () => {
    const { bus, clock, orch, base, sent } = await setup();
    const { body } = await post(base, '/scenarios/fx-spike/start', {});
    const runId = body.runId as string;
    expect(runId).toBe('run-1-fx-spike');
    await advance(clock, orch, FX_SPIKE.durationMs + 1_000);
    const evs = controls(bus);
    expect(evs.map(label)).toEqual([
      'scenario.started',
      'step:baseline',
      'step:spike',
      'fx_shock.started',
      'step:spreads-widen',
      'step:calm',
      'fx_shock.ended',
      'step:after',
      'scenario.ended',
    ]);
    const t0 = Date.parse(evs[0]!.occurredAt);
    const started = evs.find((e) => e.type === 'control.fx_shock.started')!;
    const ended = evs.find((e) => e.type === 'control.fx_shock.ended')!;
    expect(Date.parse(started.occurredAt) - t0).toBe(8_000);
    expect(Date.parse(ended.occurredAt) - t0).toBe(36_000);
    expect(started.payload).toEqual({ shockId: `gbp-php-spike@${runId}`, corridorId: 'GB-PH', driftBps: 250, noiseMultiplier: 4, rampMs: 5_000, reason: expect.stringContaining('GBP/PHP'), runId });
    expect(ended.payload).toEqual({ shockId: `gbp-php-spike@${runId}`, runId });
    expect(started.eventId).toBe(deterministicId('orchestrator', runId, 'step', 'spike', 'action', '0'));
    expect(ended.eventId).toBe(deterministicId('orchestrator', runId, 'step', 'calm', 'action', '0'));
    expect(controlState(bus).fxShocks).toEqual({});

    // 4 before, 6 during the shock, 4 after; all GB-PH; on the scenario clock.
    expect(sent).toHaveLength(14);
    expect(sent.every((s) => s.body.corridor === 'GB-PH')).toBe(true);
    const rel = sent.map((s) => s.at - t0);
    expect(rel.slice(0, 4)).toEqual([0, 1_000, 2_000, 3_000]);
    expect(rel.slice(4, 10)).toEqual([16_000, 17_500, 19_000, 20_500, 22_000, 23_500]);
    expect(rel.slice(10)).toEqual([44_000, 45_000, 46_000, 47_000]);
    expect(sent[4]!.key).toBe(craftedKey(runId, 'spreads-widen', 'during', 0));

    // A second run on a fresh log is byte-identical in event ids and payment keys.
    const again = await setup();
    await post(again.base, '/scenarios/fx-spike/start', {});
    await advance(again.clock, again.orch, FX_SPIKE.durationMs + 1_000);
    expect(controls(again.bus).map((e) => e.eventId)).toEqual(evs.map((e) => e.eventId));
    expect(again.sent.map((s) => s.key)).toEqual(sent.map((s) => s.key));
  });

  it('fraud-ring sends the fan-in burst then the fan-out leg with fresh accounts per run', async () => {
    const { clock, orch, base, sent } = await setup();
    await post(base, '/scenarios/fraud-ring/start', {});
    await advance(clock, orch, FRAUD_RING.durationMs + 1_000);
    expect(sent).toHaveLength(FRAUD_RING_FAN_IN.length + FRAUD_RING_FAN_OUT.length);
    const fanIn = sent.filter((s) => s.key.includes('-fan-in-'));
    expect(new Set(fanIn.map((s) => s.body.creditor.accountId)).size).toBe(1);
    expect(fanIn[0]!.body.creditor.accountId).toBe(`MULE-IN-${runTag('run-1-fraud-ring')}-HUB`);
    expect(orch.state().activeRun).toBeNull();

    await post(base, '/scenarios/fraud-ring/start', {});
    await advance(clock, orch, FRAUD_RING.durationMs + 1_000);
    const second = sent.slice(FRAUD_RING_FAN_IN.length + FRAUD_RING_FAN_OUT.length);
    expect(second).toHaveLength(FRAUD_RING_FAN_IN.length + FRAUD_RING_FAN_OUT.length);
    expect(second[0]!.body.debtor.accountId).not.toBe(sent[0]!.body.debtor.accountId);
  });

  it('sanctions-hit sends one payment per listed-party step', async () => {
    const { clock, orch, base, sent } = await setup();
    await post(base, '/scenarios/sanctions-hit/start', {});
    await advance(clock, orch, SANCTIONS_HIT.durationMs + 1_000);
    expect(sent.map((s) => s.key)).toEqual([craftedKey('run-1-sanctions-hit', 'listed-company', 'entity', 0), craftedKey('run-1-sanctions-hit', 'listed-person', 'person', 0)]);
  });

  it('stop during the shock ends the shock, then the scenario, and cancels unsent payments', async () => {
    const { bus, clock, orch, base, sent } = await setup();
    const { body } = await post(base, '/scenarios/fx-spike/start', {});
    const runId = body.runId as string;
    await advance(clock, orch, 18_000);
    expect(Object.keys(controlState(bus).fxShocks)).toEqual([`gbp-php-spike@${runId}`]);
    const before = sent.length;
    expect(before).toBe(6); // 4 before + 2 during
    expect((await post(base, '/scenarios/stop')).body).toEqual({ stopped: true });
    const tail = controls(bus).slice(-2);
    expect(tail.map(label)).toEqual(['fx_shock.ended', 'scenario.ended']);
    expect(tail[0]!.eventId).toBe(deterministicId('orchestrator', runId, 'restore-fx', `gbp-php-spike@${runId}`));
    expect(controlState(bus)).toMatchObject({ fxShocks: {}, scenario: null });
    await advance(clock, orch, 60_000, 5_000);
    expect(sent).toHaveLength(before);
  });

  it('pausing freezes crafted sends with the scenario clock', async () => {
    const { clock, orch, base, sent } = await setup();
    await post(base, '/scenarios/fraud-ring/start', {});
    await advance(clock, orch, 8_000); // fan-in started at 6 s: two sent (6.0, 7.5)
    expect(sent).toHaveLength(2);
    await post(base, '/pause', { paused: true });
    await advance(clock, orch, 20_000, 2_000);
    expect(sent).toHaveLength(2);
    await post(base, '/pause', { paused: false });
    await advance(clock, orch, 1_000);
    expect(sent).toHaveLength(3);
  });

  it('retries a failed send with the same Idempotency-Key', async () => {
    const { clock, orch, base, sent } = await setup({ failFirst: 2 });
    await post(base, '/scenarios/sanctions-hit/start', {});
    await advance(clock, orch, 6_000);
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1);
    expect(sent[0]!.key).toBe(craftedKey('run-1-sanctions-hit', 'listed-company', 'entity', 0));
  });

  it('restart recovery ends a dangling FX shock (from a crashed run or published by someone else)', async () => {
    const bus = new InMemoryBus();
    const first = await setup({ bus });
    const { body } = await post(first.base, '/scenarios/fx-spike/start', {});
    const runId = body.runId as string;
    await advance(first.clock, first.orch, 12_000);
    await first.orch.close({ restore: false }); // crash: nothing restored
    await bus.publish(
      makeControlEvent('control.fx_shock.started', { shockId: 'manual', corridorId: 'US-IN', driftBps: 50, noiseMultiplier: 2, rampMs: 0, reason: 'manual' }, { eventId: 'manual-shock', occurredAt: new Date().toISOString(), producer: 'presenter' }),
    );
    expect(Object.keys(controlState(bus).fxShocks).sort()).toEqual([`gbp-php-spike@${runId}`, 'manual'].sort());
    await setup({ bus });
    expect(controlState(bus)).toMatchObject({ fxShocks: {}, scenario: null });
    const ends = controls(bus).filter((e) => e.type === 'control.fx_shock.ended');
    expect(ends.map((e) => e.eventId)).toContain(deterministicId('orchestrator', runId, 'restore-fx', `gbp-php-spike@${runId}`));
    const n = controls(bus).length;
    await setup({ bus }); // idempotent
    expect(controls(bus)).toHaveLength(n);
  });
});
