// M5 attract loop: idle auto-start, cycles, touch / presenter take-over, never an outage left open.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlTimeline, deterministicId, isControlEvent, type ControlEvent } from '@ct/contracts';
import { InMemoryBus } from '@ct/event-bus';
import { ATTRACT_LOOP, attractIdleFromEnv, DEFAULT_ATTRACT_IDLE_MS, type OrchestratorStateWithAttract } from './attract';
import { FakeClock } from './clock';
import { startOrchestrator, type OrchestratorHandle, type OrchestratorOptions } from './orchestrator';
import { PROVIDER_OUTAGE, validateScript } from './scenarios';

async function fakePaymentApi(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ paymentId: String(req.headers['idempotency-key'] ?? ''), status: 'initiated' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function setup(over: Partial<OrchestratorOptions> = {}) {
  const bus = (over.bus as InMemoryBus | undefined) ?? new InMemoryBus();
  const clock = (over.clock as FakeClock | undefined) ?? new FakeClock();
  const api = await fakePaymentApi();
  cleanups.push(() => api.close());
  const orch = await startOrchestrator({ host: '127.0.0.1', port: 0, seed: 'attract-seed', ambientRate: 0, paymentApiUrl: api.url, ...over, bus, clock });
  cleanups.push(() => orch.close());
  return { bus, clock, orch, base: `http://127.0.0.1:${orch.port}` };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as OrchestratorStateWithAttract & Record<string, unknown> };
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
async function advance(clock: FakeClock, orch: OrchestratorHandle, ms: number, slice = 1000) {
  for (let done = 0; done < ms; done += slice) {
    await clock.advance(Math.min(slice, ms - done));
    await orch.idle();
  }
}

const CYCLE = [
  'scenario.started',
  'step:flow',
  'step:orion-down',
  'provider_outage.started',
  'step:rerouted',
  'step:orion-back',
  'provider_outage.ended',
  'step:recovered',
  'step:ledger',
  'step:invite',
  'scenario.ended',
];

describe('attract loop script', () => {
  it('is a valid ~90 s condensed outage story that closes its outage', () => {
    expect(() => validateScript(ATTRACT_LOOP)).not.toThrow();
    expect(ATTRACT_LOOP.durationMs).toBe(90_000);
    expect(ATTRACT_LOOP.steps.map((s) => s.id)).toEqual(['flow', 'orion-down', 'rerouted', 'orion-back', 'recovered', 'ledger', 'invite']);
    expect(ATTRACT_LOOP.steps.map((s) => s.title)).toEqual(
      expect.arrayContaining(['Payments flowing across 3 corridors', 'Orion just failed', 'Traffic re-routed — nothing lost', 'Ledger still balanced to the cent']),
    );
    // shorter than the presenter scenario, same shape
    expect(ATTRACT_LOOP.durationMs).toBeGreaterThan(PROVIDER_OUTAGE.durationMs);
  });

  it('reads the idle time from the environment', () => {
    expect(attractIdleFromEnv(undefined)).toBe(DEFAULT_ATTRACT_IDLE_MS);
    expect(attractIdleFromEnv('')).toBe(DEFAULT_ATTRACT_IDLE_MS);
    expect(attractIdleFromEnv('0')).toBe(0);
    expect(attractIdleFromEnv('45000')).toBe(45_000);
    expect(attractIdleFromEnv('soon')).toBe(DEFAULT_ATTRACT_IDLE_MS);
    expect(attractIdleFromEnv('-5')).toBe(DEFAULT_ATTRACT_IDLE_MS);
  });
});

describe('attract mode', () => {
  it('is off by default in the library and never starts by itself', async () => {
    const { bus, clock, orch, base } = await setup();
    const st = (await call(base, 'GET', '/state')).body;
    expect(st.attract).toMatchObject({ enabled: false, playing: false, idleMs: 0, startsInMs: null, cycle: 0, run: null, lastStop: null });
    expect(st.attract.script.id).toBe('attract');
    expect(st.scenarios.map((s) => s.id)).not.toContain('attract'); // not a presenter scenario
    expect((await call(base, 'POST', '/scenarios/attract/start')).status).toBe(404);
    await advance(clock, orch, 300_000, 10_000);
    expect(controls(bus)).toHaveLength(0);
  });

  it('starts after the idle time, plays the 90 s cycle and repeats with deterministic run ids', async () => {
    const { bus, clock, orch, base } = await setup({ ambientRate: 2, attract: { idleMs: 30_000 } });
    expect(orch.state().attract).toMatchObject({ enabled: true, playing: false, startsInMs: 30_000 });
    await advance(clock, orch, 29_000);
    expect(orch.state().attract).toMatchObject({ playing: false, startsInMs: 1_000, idleForMs: 29_000 });
    expect(controls(bus)).toHaveLength(0);

    await advance(clock, orch, 1_000);
    const s1 = orch.state();
    expect(s1.attract).toMatchObject({ playing: true, cycle: 1, startsInMs: null, run: { runId: 'run-1-attract', stepId: 'flow' } });
    expect(s1.activeRun).toMatchObject({ runId: 'run-1-attract', scenarioId: 'attract' });
    expect(s1.ambient.rate).toBe(7);

    await advance(clock, orch, 14_000);
    expect(controlState(bus).outages.orion).toMatchObject({ mode: 'down', runId: 'run-1-attract' });
    expect(controlState(bus).scenario).toMatchObject({ scenarioId: 'attract', step: { stepId: 'orion-down', title: 'Orion just failed' } });

    await advance(clock, orch, 76_000);
    const evs = controls(bus);
    expect(evs.slice(0, CYCLE.length).map(label)).toEqual(CYCLE);
    const t0 = Date.parse(evs[0]!.occurredAt);
    const at = (l: string) => Date.parse(evs.find((e) => label(e) === l)!.occurredAt) - t0;
    expect(at('provider_outage.started')).toBe(14_000);
    expect(at('provider_outage.ended')).toBe(38_000);
    expect(at('step:ledger')).toBe(68_000);
    expect(at('scenario.ended')).toBe(90_000);
    expect(evs[0]!.eventId).toBe(deterministicId('orchestrator', 'run-1-attract', 'started'));
    expect(evs[CYCLE.length - 1]!.payload).toMatchObject({ runId: 'run-1-attract', outcome: 'completed' });

    // next cycle straight away
    expect(evs[CYCLE.length]).toMatchObject({ type: 'control.scenario.started', payload: { runId: 'run-2-attract', scenarioId: 'attract' } });
    expect(orch.state().attract).toMatchObject({ playing: true, cycle: 2, run: { runId: 'run-2-attract' } });

    // the same idle period on a fresh log gives identical event ids
    const again = await setup({ ambientRate: 2, attract: { idleMs: 30_000 } });
    await advance(again.clock, again.orch, 120_000);
    expect(controls(again.bus).slice(0, CYCLE.length).map((e) => e.eventId)).toEqual(evs.slice(0, CYCLE.length).map((e) => e.eventId));
  });

  it('a kiosk touch mid-outage stops the loop, closes the outage, and the idle timer starts again', async () => {
    const { bus, clock, orch, base } = await setup({ ambientRate: 2, attract: { idleMs: 10_000 } });
    await advance(clock, orch, 10_000 + 20_000); // 20 s into the loop: Orion is down
    expect(controlState(bus).outages.orion).toBeDefined();

    const touched = await call(base, 'POST', '/attract/touch', {});
    expect(touched.status).toBe(200);
    expect(touched.body.attract).toMatchObject({ enabled: true, playing: false, lastStop: 'touch', run: null, idleForMs: 0, startsInMs: 10_000 });
    expect(touched.body.activeRun).toBeNull();
    expect(controls(bus).slice(-2).map(label)).toEqual(['provider_outage.ended', 'scenario.ended']);
    expect(controls(bus).at(-1)!.payload).toMatchObject({ runId: 'run-1-attract', outcome: 'stopped' });
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
    expect(orch.state().ambient.rate).toBe(2);

    // repeated touches keep pushing the restart back
    await advance(clock, orch, 8_000);
    await call(base, 'POST', '/attract/touch');
    await advance(clock, orch, 8_000);
    expect(orch.state().attract.playing).toBe(false);
    await advance(clock, orch, 2_000);
    expect(orch.state().attract).toMatchObject({ playing: true, cycle: 1, run: { runId: 'run-2-attract' }, lastStop: null });
  });

  it('a presenter scenario takes over (attract outage closed first) and the loop never runs during it', async () => {
    const { bus, clock, orch, base } = await setup({ attract: { idleMs: 5_000 } });
    await advance(clock, orch, 5_000 + 16_000);
    expect(controlState(bus).outages.orion).toMatchObject({ runId: 'run-1-attract' });

    const started = await call(base, 'POST', '/scenarios/provider-degraded/start');
    expect(started).toMatchObject({ status: 200, body: { runId: 'run-2-provider-degraded' } });
    const seq = controls(bus).map(label);
    const i = seq.lastIndexOf('scenario.started');
    expect(seq.slice(i - 2, i + 1)).toEqual(['provider_outage.ended', 'scenario.ended', 'scenario.started']);
    expect(orch.state().attract).toMatchObject({ playing: false, lastStop: 'presenter', startsInMs: null });

    // far past the idle time while the presenter scenario runs: no attract
    await advance(clock, orch, 40_000);
    expect(orch.state().activeRun?.scenarioId).toBe('provider-degraded');
    expect(orch.state().attract.playing).toBe(false);
    await advance(clock, orch, 9_000); // degraded ends at 48 s
    expect(orch.state().activeRun).toBeNull();
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
    // idle counts from the end of the presenter scenario
    expect(orch.state().attract.startsInMs).toBeGreaterThan(3_000);
    await advance(clock, orch, 6_000);
    expect(orch.state().attract).toMatchObject({ playing: true, run: { runId: 'run-3-attract' } });
  });

  it('presenter commands (ambient, pace, stop) stop the loop and reset the idle time', async () => {
    const { bus, clock, orch, base } = await setup({ attract: { idleMs: 5_000 } });
    await advance(clock, orch, 6_000);
    expect(orch.state().attract.playing).toBe(true);
    const amb = await call(base, 'POST', '/ambient', { rate: 3 });
    expect(amb.body.attract).toMatchObject({ playing: false, lastStop: 'presenter', startsInMs: 5_000 });
    expect(amb.body.ambient.rate).toBe(3);
    expect(controlState(bus).scenario).toBeNull();

    await advance(clock, orch, 5_000);
    expect(orch.state().attract.playing).toBe(true);
    expect(await call(base, 'POST', '/scenarios/stop')).toMatchObject({ status: 200, body: { stopped: true } });
    expect(orch.state().attract).toMatchObject({ playing: false, lastStop: 'presenter' });
    expect(orch.state().ambient.rate).toBe(3);

    await advance(clock, orch, 4_000);
    await call(base, 'POST', '/pace', { preset: 'normal' });
    await advance(clock, orch, 4_000);
    expect(orch.state().attract.playing).toBe(false);

    // paused: never starts by itself
    await call(base, 'POST', '/pause', { paused: true });
    await advance(clock, orch, 60_000, 5_000);
    expect(orch.state().attract).toMatchObject({ playing: false, startsInMs: null });
    await call(base, 'POST', '/pause', { paused: false });
    await advance(clock, orch, 5_000);
    expect(orch.state().attract.playing).toBe(true);
    expect(controlState(bus).outages).toEqual({});
  });

  it('POST /attract switches it on (plays now) and off (stops cleanly), and validates its body', async () => {
    const { bus, clock, orch, base } = await setup();
    expect((await call(base, 'GET', '/attract')).status).toBe(405);
    expect((await call(base, 'GET', '/attract/touch')).status).toBe(405);
    for (const bad of [{}, { enabled: 'yes' }, { enabled: true, idleMs: -1 }, { enabled: true, idleMs: 'x' }]) {
      expect((await call(base, 'POST', '/attract', bad)).status).toBe(400);
    }
    const on = await call(base, 'POST', '/attract', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.attract).toMatchObject({ enabled: true, playing: true, cycle: 1, idleMs: 0 });
    await advance(clock, orch, 15_000);
    expect(controlState(bus).outages.orion).toBeDefined();

    const off = await call(base, 'POST', '/attract', { enabled: false });
    expect(off.body.attract).toMatchObject({ enabled: false, playing: false, lastStop: 'disabled', startsInMs: null });
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
    const n = controls(bus).length;
    await advance(clock, orch, 200_000, 10_000);
    expect(controls(bus)).toHaveLength(n);

    // with an idle time it waits for it after a touch
    const timed = await call(base, 'POST', '/attract', { enabled: true, idleMs: 20_000 });
    expect(timed.body.attract).toMatchObject({ enabled: true, playing: true, idleMs: 20_000 });
    await call(base, 'POST', '/attract/touch');
    expect(orch.state().attract).toMatchObject({ playing: false, startsInMs: 20_000 });

    // a presenter scenario is running: enabling does not interrupt it
    await call(base, 'POST', '/scenarios/provider-outage/start');
    const during = await call(base, 'POST', '/attract', { enabled: true });
    expect(during.body.attract).toMatchObject({ enabled: true, playing: false, startsInMs: null });
    expect(during.body.activeRun?.scenarioId).toBe('provider-outage');
  });

  it('close() while the loop plays leaves no outage open', async () => {
    const { bus, clock, orch } = await setup({ attract: { idleMs: 1_000 } });
    await advance(clock, orch, 1_000 + 20_000);
    expect(controlState(bus).outages.orion).toBeDefined();
    await orch.close();
    expect(controlState(bus)).toMatchObject({ outages: {}, scenario: null });
  });
});
