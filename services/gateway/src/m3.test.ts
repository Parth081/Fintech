import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { InMemoryBus } from '@ct/event-bus';
import { applyEvent, makeControlEvent, newId, type BreakerView, type ControlEvent, type ControlPayloadMap, type OrchestratorState, type PaymentState } from '@ct/contracts';
import { startGateway, type GatewayOptions } from './server';
import { ControlProjection, safeBreakers, TrafficMeter } from './control';
import { m2Payment } from './testing/m2-events';
import type { ControlMessage, GatewayControlView, Health, RerouteBrief, ServerMessage, TrafficView } from './api-types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const T0 = Date.parse('2026-10-22T09:00:00.000Z');

let seq = 0;
function ctl<T extends ControlEvent['type']>(type: T, payload: ControlPayloadMap[T], atMs = T0): ControlEvent {
  seq += 1;
  return makeControlEvent(type, payload, { eventId: `ctl-${seq}`, occurredAt: new Date(atMs).toISOString(), producer: 'orchestrator' }) as ControlEvent;
}

const ORCH_STATE: OrchestratorState = {
  ambient: { rate: 2, running: true, sent: 10 },
  pace: 'normal',
  paused: false,
  scenarios: [{ id: 'provider-outage', title: 'Provider outage', description: 'Orion goes down', durationMs: 60_000, steps: [{ id: 's1', atMs: 0, title: 'Calm', narration: 'Say hi' }] }],
  activeRun: null,
};

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  );
  const addr = server.address();
  return { server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += String(c)));
    req.on('end', () => r(b));
  });
}

/** Fake orchestrator: GET /state, POST /ambient {rate}, POST /scenarios/:id/start. */
async function fakeOrchestrator() {
  const state: OrchestratorState = structuredClone(ORCH_STATE);
  const seen: string[] = [];
  const { url } = await listen(async (req, res) => {
    const body = await readAll(req);
    seen.push(`${req.method} ${req.url} ${body}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/state') return res.end(JSON.stringify(state));
    if (req.method === 'POST' && req.url === '/ambient') {
      state.ambient.rate = (JSON.parse(body) as { rate: number }).rate;
      return res.end(JSON.stringify(state));
    }
    if (req.method === 'POST' && req.url === '/scenarios/provider-outage/start') {
      if (state.activeRun) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ error: 'run active' }));
      }
      state.activeRun = { runId: 'run-1', scenarioId: 'provider-outage', startedAt: new Date(T0).toISOString(), elapsedMs: 0, stepId: null };
      return res.end(JSON.stringify({ runId: 'run-1' }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'nope' }));
  });
  return { url, state, seen };
}

const fakeBreakers = (states: Iterable<PaymentState>): BreakerView[] => {
  let failed = 0;
  for (const s of states) if (s.facts['payment.send_failed']?.providerId === 'orion') failed++;
  return [
    { providerId: 'orion', state: failed > 0 ? 'open' : 'closed', since: failed > 0 ? new Date(T0).toISOString() : null, failureRate: failed > 0 ? 1 : 0, attempts: failed, reason: `${failed} rejected` },
  ];
};

async function setup(opts: Partial<GatewayOptions> = {}, events: Parameters<InMemoryBus['publish']>[0][] = []) {
  const bus = new InMemoryBus();
  for (const e of events) await bus.publish(e);
  const gw = await startGateway({
    bus,
    host: '127.0.0.1',
    port: 0,
    paymentApiUrl: 'http://127.0.0.1:1',
    ledgerUrl: 'http://127.0.0.1:1',
    orchestratorUrl: 'http://127.0.0.1:1',
    webDist: join(tmpdir(), `ct-no-dist-${newId()}`),
    flushIntervalMs: 10,
    statsIntervalMs: 0,
    controlIntervalMs: 50,
    breakers: fakeBreakers,
    ...opts,
  });
  cleanups.push(async () => {
    await gw.close();
    await bus.close();
  });
  await gw.replayed;
  await bus.drain();
  return { bus, gw, base: `http://127.0.0.1:${gw.port}` };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as T };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

describe('TrafficMeter', () => {
  it('buckets first-attempt routings, re-routes, rejects and settlements per provider', () => {
    const m = new TrafficMeter(5000, 4);
    for (const e of m2Payment('a', { outcome: 'settled', startMs: T0 })) m.record(e);
    for (const e of m2Payment('b', { outcome: 'retry', startMs: T0 + 6000 })) m.record(e);
    const v = m.view(T0 + 6000 + 2000);
    expect(v.providers.map((p) => p.providerId)).toEqual(expect.arrayContaining(['orion', 'lyra', 'vega']));
    const sum = (k: 'firstAttempt' | 'rerouted' | 'failed' | 'settled') => v.providers.reduce((s, p) => s + p.total[k], 0);
    expect(sum('firstAttempt')).toBe(2);
    expect(sum('rerouted')).toBe(1);
    expect(sum('failed')).toBe(1);
    expect(sum('settled')).toBe(2);
    for (const p of v.providers) expect(p.firstAttempt).toHaveLength(4);
    expect(v.toMs - v.fromMs).toBe(20_000);
  });

  it('drops events outside the window', () => {
    const m = new TrafficMeter(5000, 2);
    for (const e of m2Payment('a', { startMs: T0 })) m.record(e);
    const v = m.view(T0 + 60_000);
    expect(v.providers.every((p) => p.total.firstAttempt === 0)).toBe(true);
  });
});

describe('ControlProjection', () => {
  it('folds control events and records re-routes away from the failed provider', () => {
    const c = new ControlProjection();
    expect(c.applyControl(ctl('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'drill' }), 0)).toBe(true);
    expect(c.timeline.current().outages.orion?.mode).toBe('down');
    // Same event again: no change.
    const again = { ...ctl('control.provider_outage.ended', { providerId: 'orion' }), eventId: 'ctl-1' } as ControlEvent;
    expect(c.applyControl(again, 1)).toBe(false);

    let state: PaymentState | undefined;
    for (const e of m2Payment('p1', { outcome: 'retry', startMs: T0 })) {
      state = applyEvent(state, e);
      c.applyPayment(e, state);
    }
    const r = c.reroutes();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ paymentId: 'p1', attempt: 2, reasonCode: 'AC04' });
    expect(r[0]!.fromProviderId).not.toBe(r[0]!.toProviderId);
  });

  it('guards a throwing breaker engine', () => {
    const out = safeBreakers(() => {
      throw new Error('not implemented');
    }, [], 0);
    expect(out).toEqual({ breakers: [], error: 'not implemented' });
  });
});

describe('GET /api/control/state', () => {
  it('serves control state, breakers, orchestrator and reset availability', async () => {
    const orch = await fakeOrchestrator();
    const events = [
      ...m2Payment('p-retry', { outcome: 'retry', startMs: T0 }),
      ctl('control.scenario.started', { runId: 'run-1', scenarioId: 'provider-outage', title: 'Provider outage', seed: 's' }),
      ctl('control.scenario.step', { runId: 'run-1', scenarioId: 'provider-outage', stepId: 'down', title: 'Orion goes down', narration: 'Watch' }),
      ctl('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'drill', runId: 'run-1' }),
    ];
    const { base } = await setup({ orchestratorUrl: orch.url, launcherControlUrl: 'http://127.0.0.1:1' }, events);
    const { status, body } = await getJson<GatewayControlView>(`${base}/api/control/state`);
    expect(status).toBe(200);
    expect(body.control.scenario).toMatchObject({ runId: 'run-1', step: { stepId: 'down', title: 'Orion goes down' } });
    expect(Object.keys(body.control.outages)).toEqual(['orion']);
    expect(body.control.lastOffset).toBe(events.length - 1);
    expect(body.orchestrator?.scenarios[0]?.id).toBe('provider-outage');
    expect(body.orchestratorError).toBeUndefined();
    expect(body.resetAvailable).toBe(true);
    expect(body.reroutes.map((r: RerouteBrief) => r.paymentId)).toEqual(['p-retry']);
    expect(body.breakers).toHaveLength(1);
    expect(body.traffic.providers.length).toBeGreaterThanOrEqual(3);

    // The payment projection is unaffected by control events.
    const stats = await getJson<{ total: number }>(`${base}/api/stats`);
    expect(stats.body.total).toBe(1);
    expect((await getJson<TrafficView>(`${base}/api/control/traffic`)).body.bucketMs).toBe(5000);
  });

  it('reports orchestrator down, breaker errors and no reset', async () => {
    const { base } = await setup({
      breakers: () => {
        throw new Error('breakerStates not implemented yet');
      },
    });
    const { body } = await getJson<GatewayControlView>(`${base}/api/control/state`);
    expect(body.orchestrator).toBeNull();
    expect(body.orchestratorError).toMatch(/unreachable/);
    expect(body.breakers).toEqual([]);
    expect(body.breakerError).toMatch(/not implemented/);
    expect(body.resetAvailable).toBe(false);
    expect(body.control.scenario).toBeNull();
  });

  it('health carries an instance id', async () => {
    const a = await setup();
    const b = await setup();
    const ha = (await getJson<Health>(`${a.base}/health`)).body;
    const hb = (await getJson<Health>(`${b.base}/health`)).body;
    expect(ha.instanceId).toBeTruthy();
    expect(ha.instanceId).not.toBe(hb.instanceId);
  });
});

describe('orchestrator proxy', () => {
  it('passes method, path and body through', async () => {
    const orch = await fakeOrchestrator();
    const { base } = await setup({ orchestratorUrl: orch.url });
    const r = await getJson<OrchestratorState>(`${base}/api/control/orchestrator/ambient`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rate: 8 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ambient.rate).toBe(8);
    expect(orch.seen).toContain('POST /ambient {"rate":8}');
    const s = await getJson<OrchestratorState>(`${base}/api/control/orchestrator/state`);
    expect(s.body.ambient.rate).toBe(8);
    const start = await getJson<{ runId: string }>(`${base}/api/control/orchestrator/scenarios/provider-outage/start`, { method: 'POST', body: '{}' });
    expect(start.body.runId).toBe('run-1');
    const again = await fetch(`${base}/api/control/orchestrator/scenarios/provider-outage/start`, { method: 'POST', body: '{}' });
    expect(again.status).toBe(409);
  });

  it('answers 502 JSON when the orchestrator is down', async () => {
    const { base } = await setup();
    const r = await getJson<{ error: string }>(`${base}/api/control/orchestrator/state`);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('orchestrator unavailable');
  });
});

describe('POST /api/control/reset', () => {
  it('is 503 when the launcher URL is empty', async () => {
    const { base } = await setup({ launcherControlUrl: '' });
    const r = await getJson<{ error: string }>(`${base}/api/control/reset`, { method: 'POST' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('reset unavailable');
    expect((await fetch(`${base}/api/control/reset`)).status).toBe(405);
  });

  it('forwards to the launcher and tells every screen a reset started', async () => {
    const calls: string[] = [];
    const launcher = await listen((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, durationMs: 42 }));
      }, 50);
    });
    const { base, gw } = await setup({ launcherControlUrl: launcher.url });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => {
      const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
      messages.push(...(Array.isArray(p) ? p : [p]));
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    const r = await getJson<{ ok: boolean; durationMs: number }>(`${base}/api/control/reset`, { method: 'POST' });
    expect(r).toEqual({ status: 200, body: { ok: true, durationMs: 42 } });
    expect(calls).toEqual(['POST /reset']);
    await until(() => messages.some((m) => m.kind === 'reset'));
    expect(messages.some((m) => m.kind === 'reset')).toBe(true);
  });

  it('answers 502 when the launcher cannot be reached', async () => {
    const { base } = await setup({ launcherControlUrl: 'http://127.0.0.1:1', resetTimeoutMs: 2000 });
    const r = await getJson<{ error: string }>(`${base}/api/control/reset`, { method: 'POST' });
    expect(r.status).toBe(502);
  });
});

describe('POST /api/control/focus', () => {
  it('broadcasts a focus message for a known payment and validates input', async () => {
    const { base, gw } = await setup({}, m2Payment('p-f', { startMs: T0 }));
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => {
      const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
      messages.push(...(Array.isArray(p) ? p : [p]));
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    const post = (body: string) => fetch(`${base}/api/control/focus`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await post(JSON.stringify({ paymentId: 'p-f' }))).status).toBe(200);
    expect((await post(JSON.stringify({ paymentId: null }))).status).toBe(200);
    expect((await post(JSON.stringify({ paymentId: 'nope' }))).status).toBe(404);
    expect((await post('not json')).status).toBe(400);
    await until(() => messages.filter((m) => m.kind === 'focus').length >= 2);
    expect(messages.filter((m) => m.kind === 'focus')).toEqual([
      { kind: 'focus', paymentId: 'p-f' },
      { kind: 'focus', paymentId: null },
    ]);
  });
});

describe('control push over the WebSocket', () => {
  it('sends the view on connect and pushes control changes', async () => {
    const orch = await fakeOrchestrator();
    const { bus, gw } = await setup({ orchestratorUrl: orch.url });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const controls: ControlMessage[] = [];
    ws.on('message', (d) => {
      const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
      for (const m of Array.isArray(p) ? p : [p]) if (m.kind === 'control') controls.push(m);
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    await until(() => controls.length > 0);
    expect(controls[0]!.view.orchestrator?.ambient.rate).toBe(2);
    expect(controls[0]!.view.control.outages).toEqual({});

    await bus.publish(ctl('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'drill' }));
    await until(() => controls.some((c) => c.view.control.outages.orion !== undefined));
    expect(controls.at(-1)!.view.control.outages.orion?.reason).toBe('drill');

    // Breaker change (payment events only) is pushed too.
    for (const e of m2Payment('p-x', { outcome: 'retry', startMs: Date.now() })) await bus.publish(e);
    await until(() => controls.some((c) => c.view.breakers[0]?.state === 'open'));
    expect(controls.at(-1)!.view.breakers[0]?.state).toBe('open');

    // Quiet: no further pushes while nothing changes and no scenario runs.
    await bus.drain();
    await new Promise((r) => setTimeout(r, 400));
    const n = controls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(controls.length).toBe(n);
  });

  it('pushes at least every 2 s while a scenario runs', async () => {
    const { bus, gw } = await setup({ controlIntervalMs: 100 });
    await bus.publish(ctl('control.scenario.started', { runId: 'r', scenarioId: 'provider-outage', title: 'Outage', seed: 's' }));
    await bus.drain();
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const controls: ControlMessage[] = [];
    ws.on('message', (d) => {
      const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
      for (const m of Array.isArray(p) ? p : [p]) if (m.kind === 'control') controls.push(m);
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    await until(() => controls.length >= 3, 6000);
    expect(controls.length).toBeGreaterThanOrEqual(3);
    expect(controls.at(-1)!.view.control.scenario?.title).toBe('Outage');
  }, 10_000);
});
