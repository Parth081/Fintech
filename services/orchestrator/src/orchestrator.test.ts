import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ControlTimeline,
  deterministicId,
  isControlEvent,
  makeControlEvent,
  type AnyEvent,
  type ControlEvent,
  type OrchestratorState,
} from '@ct/contracts';
import { InMemoryBus } from '@ct/event-bus';
import { startPaymentApi, type PaymentApiHandle } from '@ct/payment-api';
import { ambientPayment } from './ambient';
import { FakeClock } from './clock';
import { startOrchestrator, type OrchestratorHandle, type OrchestratorOptions } from './orchestrator';
import { PROVIDER_DEGRADED, PROVIDER_OUTAGE, SCENARIOS, validateScript } from './scenarios';

// ---- fake Payment API: dedupes by Idempotency-Key like the real one ----
interface FakeApi {
  url: string;
  keys: string[];
  posts: number;
  close(): Promise<void>;
}
async function fakePaymentApi(): Promise<FakeApi> {
  const keys: string[] = [];
  const api = { url: '', keys, posts: 0, close: async () => {} } as FakeApi;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      api.posts += 1;
      const key = String(req.headers['idempotency-key'] ?? '');
      const dup = keys.includes(key);
      if (!dup) keys.push(key);
      res.writeHead(dup ? 200 : 202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ paymentId: key, status: 'initiated', ...(dup ? { duplicate: true } : {}) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise<void>((r) => server.close(() => r()));
  return api;
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function setup(over: Partial<OrchestratorOptions> & { bus?: InMemoryBus; clock?: FakeClock; api?: FakeApi } = {}) {
  const bus = over.bus ?? new InMemoryBus();
  const clock = over.clock ?? new FakeClock();
  const api = over.api ?? (await fakePaymentApi());
  if (!over.api) cleanups.push(() => api.close());
  const orch = await startOrchestrator({ host: '127.0.0.1', port: 0, seed: 'test-seed', ambientRate: 0, paymentApiUrl: api.url, ...over, bus, clock });
  cleanups.push(() => orch.close());
  const base = `http://127.0.0.1:${orch.port}`;
  return { bus, clock, api, orch, base };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const controls = (bus: InMemoryBus) => bus.events.filter(isControlEvent) as ControlEvent[];
const describeEvent = (e: ControlEvent) =>
  e.type === 'control.scenario.step' ? `step:${e.payload.stepId}` : e.type.replace('control.', '');
function controlState(bus: InMemoryBus) {
  const t = new ControlTimeline();
  bus.events.forEach((e, i) => {
    if (isControlEvent(e)) t.apply(e, i);
  });
  return t.current();
}

/** Advance the fake clock in slices so real HTTP/promise work interleaves with the timeline. */
async function advance(clock: FakeClock, orch: OrchestratorHandle, ms: number, slice = 1000) {
  for (let done = 0; done < ms; done += slice) {
    await clock.advance(Math.min(slice, ms - done));
    await orch.idle();
  }
}

describe('scenario scripts', () => {
  it('are valid, ordered and close every outage they open', () => {
    for (const s of SCENARIOS) expect(() => validateScript(s)).not.toThrow();
    expect(PROVIDER_OUTAGE.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(PROVIDER_OUTAGE.durationMs).toBeLessThanOrEqual(75_000);
    expect(SCENARIOS.map((s) => s.id)).toEqual(['provider-outage', 'provider-degraded', 'fraud-ring', 'fx-spike', 'sanctions-hit']);
    expect(() => validateScript({ ...PROVIDER_OUTAGE, steps: PROVIDER_OUTAGE.steps.filter((s) => s.id !== 'orion-recovers') })).toThrow(/left open/);
  });
});

describe('orchestrator HTTP API', () => {
  it('serves every route with the documented status codes', async () => {
    const { base } = await setup();
    expect(await call(base, 'GET', '/health')).toEqual({ status: 200, body: { ok: true } });

    const st = await call(base, 'GET', '/state');
    expect(st.status).toBe(200);
    const state = st.body as unknown as OrchestratorState;
    expect(state).toMatchObject({ ambient: { rate: 0, running: false, sent: 0 }, pace: 'normal', paused: false, activeRun: null });
    expect(state.scenarios.map((s) => s.id)).toEqual(['provider-outage', 'provider-degraded', 'fraud-ring', 'fx-spike', 'sanctions-hit']);
    expect(state.scenarios[0]!.steps[1]).toMatchObject({ id: 'orion-down', atMs: 10_000, narration: expect.stringContaining('Orion just failed') });
    expect(state.scenarios[0]!.steps[0]).not.toHaveProperty('actions');

    expect((await call(base, 'GET', '/nope')).status).toBe(404);
    expect((await call(base, 'POST', '/health')).status).toBe(405);
    expect((await call(base, 'POST', '/state')).status).toBe(405);
    expect((await call(base, 'GET', '/scenarios/stop')).status).toBe(405);
    expect((await call(base, 'GET', '/scenarios/provider-outage/start')).status).toBe(405);

    expect(await call(base, 'POST', '/scenarios/stop')).toEqual({ status: 200, body: { stopped: false } });
    expect((await call(base, 'POST', '/scenarios/nope/start', {})).status).toBe(404);
    expect((await call(base, 'POST', '/scenarios/provider-outage/start', '{bad')).status).toBe(400);
    expect((await call(base, 'POST', '/scenarios/provider-outage/start', { seed: {} })).status).toBe(400);

    const started = await call(base, 'POST', '/scenarios/provider-outage/start', { seed: 'demo' });
    expect(started).toEqual({ status: 200, body: { runId: 'run-1-provider-outage' } });
    const conflict = await call(base, 'POST', '/scenarios/provider-degraded/start');
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'scenario_active', details: { runId: 'run-1-provider-outage' } });
    const during = (await call(base, 'GET', '/state')).body as unknown as OrchestratorState;
    expect(during.activeRun).toMatchObject({ runId: 'run-1-provider-outage', scenarioId: 'provider-outage', stepId: 'baseline' });
    expect(await call(base, 'POST', '/scenarios/stop')).toEqual({ status: 200, body: { stopped: true } });
    expect((await call(base, 'GET', '/state')).body.activeRun).toBeNull();

    for (const bad of [{}, { rate: -1 }, { rate: 51 }, { rate: '4' }, { rate: null }]) {
      expect((await call(base, 'POST', '/ambient', bad)).status).toBe(400);
    }
    const amb = await call(base, 'POST', '/ambient', { rate: 4 });
    expect(amb.status).toBe(200);
    expect(amb.body.ambient).toMatchObject({ rate: 4, running: true });

    expect((await call(base, 'POST', '/pace', { preset: 'warp' })).status).toBe(400);
    const pace = await call(base, 'POST', '/pace', { preset: 'slow' });
    expect(pace.status).toBe(200);
    expect(pace.body.pace).toBe('slow');

    expect((await call(base, 'POST', '/pause', { paused: 'yes' })).status).toBe(400);
    const pause = await call(base, 'POST', '/pause', { paused: true });
    expect(pause.status).toBe(200);
    expect(pause.body.paused).toBe(true);
  });
});

describe('scenario engine', () => {
  const expectedOutage = [
    'scenario.started',
    'step:baseline',
    'step:orion-down',
    'provider_outage.started',
    'step:rerouting',
    'step:orion-recovers',
    'provider_outage.ended',
    'step:half-open',
    'step:back-to-normal',
    'step:summary',
    'scenario.ended',
  ];

  async function runFull(scenarioId: string, durationMs: number) {
    const ctx = await setup({ ambientRate: 2 });
    const r = await call(ctx.base, 'POST', `/scenarios/${scenarioId}/start`);
    expect(r.status).toBe(200);
    await ctx.orch.idle();
    expect(ctx.orch.state().ambient.rate).toBe(7); // raised during the scenario
    await advance(ctx.clock, ctx.orch, durationMs + 1000);
    return { ...ctx, runId: r.body.runId as string };
  }

  it('publishes the provider-outage timeline in order, at the scripted times, with deterministic ids', async () => {
    const { bus, orch, runId } = await runFull('provider-outage', PROVIDER_OUTAGE.durationMs);
    const evs = controls(bus);
    expect(evs.map(describeEvent)).toEqual(expectedOutage);
    expect(evs.every((e) => e.producer === 'orchestrator')).toBe(true);

    const t0 = Date.parse(evs[0]!.occurredAt);
    const at = (label: string) => Date.parse(evs.find((e) => describeEvent(e) === label)!.occurredAt) - t0;
    expect(at('step:orion-down')).toBe(10_000);
    expect(at('provider_outage.started')).toBe(10_000);
    expect(at('provider_outage.ended')).toBe(35_000);
    expect(at('scenario.ended')).toBe(72_000);

    const outage = evs.find((e) => e.type === 'control.provider_outage.started')!;
    expect(outage.payload).toEqual({ providerId: 'orion', mode: 'down', reason: expect.any(String), runId });
    const step = evs.find((e) => e.type === 'control.scenario.step' && e.payload.stepId === 'orion-down')!;
    expect(step.payload).toMatchObject({ runId, scenarioId: 'provider-outage', title: 'Orion goes down', narration: expect.stringContaining('circuit breaker') });
    expect(evs.at(-1)!.payload).toEqual({ runId, scenarioId: 'provider-outage', outcome: 'completed' });

    expect(evs[0]!.eventId).toBe(deterministicId('orchestrator', runId, 'started'));
    expect(evs[1]!.eventId).toBe(deterministicId('orchestrator', runId, 'step', 'baseline'));
    expect(outage.eventId).toBe(deterministicId('orchestrator', runId, 'step', 'orion-down', 'action', '0'));
    expect(evs.at(-1)!.eventId).toBe(deterministicId('orchestrator', runId, 'ended'));

    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
    expect(orch.state().activeRun).toBeNull();
    expect(orch.state().ambient.rate).toBe(2); // restored

    // Same run on a fresh log gives byte-identical event ids.
    const again = await runFull('provider-outage', PROVIDER_OUTAGE.durationMs);
    expect(controls(again.bus).map((e) => e.eventId)).toEqual(evs.map((e) => e.eventId));
  });

  it('runs provider-degraded with a 60% partial failure', async () => {
    const { bus } = await runFull('provider-degraded', PROVIDER_DEGRADED.durationMs);
    const evs = controls(bus);
    expect(evs.map(describeEvent)).toEqual([
      'scenario.started',
      'step:baseline',
      'step:orion-degraded',
      'provider_outage.started',
      'step:breaker-opens',
      'step:orion-healthy',
      'provider_outage.ended',
      'step:summary',
      'scenario.ended',
    ]);
    expect(evs.find((e) => e.type === 'control.provider_outage.started')!.payload).toMatchObject({ providerId: 'orion', mode: 'degraded', failureRate: 0.6 });
    expect(controlState(bus).outages).toEqual({});
  });

  it('stop during the outage ends the outage first, then the scenario, and nothing more is published', async () => {
    const { bus, clock, orch, base } = await setup({ ambientRate: 3 });
    const { body } = await call(base, 'POST', '/scenarios/provider-outage/start');
    const runId = body.runId as string;
    await advance(clock, orch, 12_000);
    expect(controlState(bus).outages.orion).toMatchObject({ mode: 'down', runId });

    expect((await call(base, 'POST', '/scenarios/stop')).body).toEqual({ stopped: true });
    const evs = controls(bus);
    expect(evs.slice(-2).map(describeEvent)).toEqual(['provider_outage.ended', 'scenario.ended']);
    expect(evs.at(-2)!.eventId).toBe(deterministicId('orchestrator', runId, 'restore', 'orion'));
    expect(evs.at(-1)!.payload).toMatchObject({ outcome: 'stopped' });
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
    expect(orch.state().ambient.rate).toBe(3);

    const count = controls(bus).length;
    await advance(clock, orch, 80_000, 5000);
    expect(controls(bus)).toHaveLength(count);
    // A new run can start afterwards, with a new run id.
    expect((await call(base, 'POST', '/scenarios/provider-outage/start')).body).toEqual({ runId: 'run-2-provider-outage' });
  });

  it('close() mid-run restores the outage (graceful shutdown)', async () => {
    const { bus, clock, orch, base } = await setup();
    await call(base, 'POST', '/scenarios/provider-outage/start');
    await advance(clock, orch, 15_000);
    await orch.close();
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
  });

  it('restart recovery closes a dangling outage and scenario left by a crashed orchestrator', async () => {
    const bus = new InMemoryBus();
    const api = await fakePaymentApi();
    cleanups.push(() => api.close());
    const first = await setup({ bus, api });
    await call(first.base, 'POST', '/scenarios/provider-outage/start');
    await advance(first.clock, first.orch, 12_000);
    await first.orch.close({ restore: false }); // simulated crash: nothing restored
    expect(controlState(bus).outages.orion).toBeDefined();
    expect(controlState(bus).scenario).not.toBeNull();

    // An outage published by someone else (no runId) is closed too.
    await bus.publish(
      makeControlEvent('control.provider_outage.started', { providerId: 'vega', mode: 'degraded', failureRate: 0.2, reason: 'manual' }, { eventId: 'manual-vega', occurredAt: new Date().toISOString(), producer: 'presenter' }),
    );

    const second = await setup({ bus, api });
    const tail = controls(bus).slice(-3);
    expect(tail.map(describeEvent).sort()).toEqual(['provider_outage.ended', 'provider_outage.ended', 'scenario.ended'].sort());
    expect(tail.find((e) => e.type === 'control.scenario.ended')!.payload).toMatchObject({ runId: 'run-1-provider-outage', outcome: 'stopped' });
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });

    // Recovery is idempotent: a third start finds nothing to close.
    const n = controls(bus).length;
    await setup({ bus, api });
    expect(controls(bus)).toHaveLength(n);
    // Run numbering continues after the log's runs.
    expect((await call(second.base, 'POST', '/scenarios/provider-degraded/start')).body).toEqual({ runId: 'run-2-provider-degraded' });
  });

  it('a run ended by another producer (e.g. a second instance recovering the log) is abandoned', async () => {
    const bus = new InMemoryBus();
    const first = await setup({ bus, ambientRate: 1 });
    await call(first.base, 'POST', '/scenarios/provider-outage/start');
    await advance(first.clock, first.orch, 12_000);
    await setup({ bus, api: first.api }); // recovers: ends the outage and the run
    await vi.waitFor(() => expect(first.orch.state().activeRun).toBeNull());
    expect(first.orch.state().ambient.rate).toBe(1);
    const n = controls(bus).length;
    await advance(first.clock, first.orch, 70_000, 5000);
    expect(controls(bus)).toHaveLength(n);
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
  });

  it('pausing freezes the scenario clock and resuming continues where it left off', async () => {
    const { bus, clock, orch, base } = await setup();
    await call(base, 'POST', '/scenarios/provider-outage/start');
    await advance(clock, orch, 5_000);
    await call(base, 'POST', '/pause', { paused: true });
    await advance(clock, orch, 30_000, 5000);
    expect(controls(bus).some((e) => e.type === 'control.provider_outage.started')).toBe(false);
    expect(orch.state().activeRun?.elapsedMs).toBe(5_000);
    await call(base, 'POST', '/pause', { paused: false });
    await advance(clock, orch, 5_000);
    expect(controls(bus).some((e) => e.type === 'control.provider_outage.started')).toBe(true);
  });
});

describe('ambient traffic', () => {
  it('sends seeded payments at the configured rate with deterministic idempotency keys', async () => {
    const { clock, orch, base, api } = await setup({ ambientRate: 4 });
    await advance(clock, orch, 5_000, 250);
    await vi.waitFor(() => expect(orch.state().ambient.sent).toBe(20));
    expect([...api.keys].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `ambient-test-seed-${i}`).sort());

    await call(base, 'POST', '/ambient', { rate: 10 });
    await advance(clock, orch, 1_000, 100);
    await vi.waitFor(() => expect(orch.state().ambient.sent).toBe(30));

    expect((await call(base, 'POST', '/ambient', { rate: 0 })).body.ambient).toMatchObject({ rate: 0, running: false });
    await advance(clock, orch, 5_000, 500);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.posts).toBe(30);

    // The generator is deterministic: same seed + index => same request.
    expect(ambientPayment('test-seed', 7)).toEqual(ambientPayment('test-seed', 7));
    expect(ambientPayment('test-seed', 7).body).not.toEqual(ambientPayment('other', 7).body);
  });

  it('pausing stops ambient traffic; resuming continues it', async () => {
    const { clock, orch, base, api } = await setup({ ambientRate: 5 });
    await call(base, 'POST', '/pause', { paused: true });
    await advance(clock, orch, 3_000, 200);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.posts).toBe(0);
    await call(base, 'POST', '/pause', { paused: false });
    await advance(clock, orch, 2_000, 200);
    await vi.waitFor(() => expect(api.posts).toBe(10));
  });

  it('a restarted orchestrator continues after the payments already in the log (no double send)', async () => {
    const bus = new InMemoryBus();
    const pay: PaymentApiHandle = await startPaymentApi({ bus, host: '127.0.0.1', port: 0, catchUpQuietMs: 10 });
    cleanups.push(() => pay.close());
    const paymentApiUrl = `http://127.0.0.1:${pay.port}`;
    const initiated = () => bus.events.filter((e): e is Extract<AnyEvent, { type: 'payment.initiated' }> => e.type === 'payment.initiated');

    const clock1 = new FakeClock();
    const first = await startOrchestrator({ bus, clock: clock1, port: 0, seed: 'restart', ambientRate: 5, paymentApiUrl });
    await advance(clock1, first, 2_000, 200);
    await vi.waitFor(() => expect(initiated()).toHaveLength(10));
    await first.close();

    const clock2 = new FakeClock();
    const second = await startOrchestrator({ bus, clock: clock2, port: 0, seed: 'restart', ambientRate: 5, paymentApiUrl });
    cleanups.push(() => second.close());
    expect(second.state().ambient.sent).toBe(10);
    await advance(clock2, second, 1_000, 200);
    await vi.waitFor(() => expect(initiated()).toHaveLength(15));
    const keys = initiated().map((e) => e.payload.idempotencyKey);
    expect(new Set(keys).size).toBe(15);
    expect(keys.slice(10)).toEqual(Array.from({ length: 5 }, (_, i) => `ambient-restart-${10 + i}`));

    // A re-send of an index already in the log is deduped by the Payment API (idempotent).
    const p = ambientPayment('restart', 3);
    const res = await fetch(`${paymentApiUrl}/payments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': p.idempotencyKey }, body: JSON.stringify(p.body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(initiated()).toHaveLength(15);
  });
});

describe('pace and pause controls', () => {
  it('publish control.demo.speed presets and control.demo.paused, and restore them from the log on restart', async () => {
    const { bus, base, api } = await setup();
    await call(base, 'POST', '/pace', { preset: 'slow' });
    await call(base, 'POST', '/pace', { preset: 'fast' });
    await call(base, 'POST', '/pace', { preset: 'normal' });
    await call(base, 'POST', '/pause', { paused: true });
    const evs = controls(bus);
    expect(evs.map((e) => [e.type, e.payload])).toEqual([
      ['control.demo.speed', { stageDelayMs: 1500, settlementDelayMs: 3000, label: 'slow' }],
      ['control.demo.speed', { stageDelayMs: 0, settlementDelayMs: 150, label: 'fast' }],
      ['control.demo.speed', { stageDelayMs: null, settlementDelayMs: null, label: 'normal' }],
      ['control.demo.paused', { paused: true }],
    ]);
    expect(new Set(evs.map((e) => e.eventId)).size).toBe(4);
    expect(controlState(bus)).toMatchObject({ speed: null, paused: true });

    await call(base, 'POST', '/pace', { preset: 'slow' });
    const restarted = await setup({ bus, api });
    expect(restarted.orch.state()).toMatchObject({ pace: 'slow', paused: true });
  });
});
