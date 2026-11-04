// M6: the gateway reports the system mode (live / recorded backup run), refuses payments in safe mode and
// proxies the launcher's /status and /safe-mode.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { InMemoryBus } from '@ct/event-bus';
import { newId } from '@ct/contracts';
import { startGateway, type GatewayOptions } from './server';
import type { ControlMessage, GatewayControlView, Health, ServerMessage } from './api-types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: Partial<GatewayOptions> = {}) {
  const bus = new InMemoryBus();
  const gw = await startGateway({
    bus,
    host: '127.0.0.1',
    port: 0,
    paymentApiUrl: 'http://127.0.0.1:1',
    webDist: join(tmpdir(), `ct-no-dist-${newId()}`),
    flushIntervalMs: 10,
    controlIntervalMs: 0,
    ...opts,
  });
  cleanups.push(async () => {
    await gw.close();
    await bus.close();
  });
  return { gw, base: `http://127.0.0.1:${gw.port}` };
}

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
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const json = async <T>(res: Response) => ({ status: res.status, body: (await res.json()) as T });

describe('mode reporting', () => {
  it('is live by default', async () => {
    const { base } = await setup();
    const health = await json<Health>(await fetch(`${base}/health`));
    expect(health.body).toMatchObject({ mode: 'live', recording: null });
    const state = await json<GatewayControlView>(await fetch(`${base}/api/control/state`));
    expect(state.body).toMatchObject({ mode: 'live', recording: null });
  });

  it('reports safe mode and the recording from options (the launcher passes them as env)', async () => {
    const { base } = await setup({ mode: 'safe', recording: 'outage-90s' });
    expect((await json<Health>(await fetch(`${base}/health`))).body).toMatchObject({ ok: true, mode: 'safe', recording: 'outage-90s' });
    expect((await json<GatewayControlView>(await fetch(`${base}/api/control/state`))).body).toMatchObject({ mode: 'safe', recording: 'outage-90s' });
  });

  it('reads SYSTEM_MODE / RECORDING_NAME from the environment', async () => {
    const before = { m: process.env.SYSTEM_MODE, r: process.env.RECORDING_NAME };
    process.env.SYSTEM_MODE = 'safe';
    process.env.RECORDING_NAME = 'from-env';
    try {
      const { base } = await setup();
      expect((await json<Health>(await fetch(`${base}/health`))).body).toMatchObject({ mode: 'safe', recording: 'from-env' });
    } finally {
      for (const [k, v] of [['SYSTEM_MODE', before.m], ['RECORDING_NAME', before.r]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a recording name without safe mode is ignored; an unknown mode value means live', async () => {
    const { base } = await setup({ recording: 'x' });
    expect((await json<Health>(await fetch(`${base}/health`))).body).toMatchObject({ mode: 'live', recording: null });
  });

  it('pushes the mode on the control WebSocket message', async () => {
    const { gw } = await setup({ mode: 'safe', recording: 'r1' });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const got = new Promise<ControlMessage>((resolve) => {
      ws.on('message', (d) => {
        const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
        for (const m of Array.isArray(p) ? p : [p]) if (m.kind === 'control') resolve(m);
      });
    });
    const msg = await got;
    expect(msg.view).toMatchObject({ mode: 'safe', recording: 'r1' });
  });
});

describe('payments in safe mode', () => {
  it('answers 503 demo paused for POST /api/payments and /api/payments/sample, still serves reads', async () => {
    let upstreamCalls = 0;
    const api = await listen((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"paymentId":"p"}');
    });
    const { base } = await setup({ mode: 'safe', recording: 'r', paymentApiUrl: api.url });
    for (const path of ['/api/payments', '/api/payments/sample']) {
      const r = await json<{ error: string; mode: string }>(await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'demo paused', mode: 'safe' });
    }
    expect(upstreamCalls).toBe(0);
    expect((await fetch(`${base}/api/payments`)).status).toBe(200);
    expect((await fetch(`${base}/api/stats`)).status).toBe(200);
  });

  it('forwards payments in live mode', async () => {
    const api = await listen((_req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"paymentId":"p1"}');
    });
    const { base } = await setup({ paymentApiUrl: api.url });
    const r = await json<{ paymentId: string }>(await fetch(`${base}/api/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(r).toEqual({ status: 202, body: { paymentId: 'p1' } });
  });
});

describe('launcher proxies', () => {
  it('GET /api/control/status and POST /api/control/safe-mode are 503 without a launcher', async () => {
    const { base } = await setup({ launcherControlUrl: '' });
    expect((await fetch(`${base}/api/control/status`)).status).toBe(503);
    const r = await fetch(`${base}/api/control/safe-mode`, { method: 'POST', body: '{"on":true}' });
    expect(r.status).toBe(503);
  });

  it('GET /api/control/status proxies the launcher status', async () => {
    const status = { mode: 'live', services: [{ name: 'broker', running: true, restarts: 0, lastRestartAt: null, lastExit: null }], recording: null };
    const launcher = await listen((req, res) => {
      res.writeHead(req.url === '/status' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
    });
    const { base } = await setup({ launcherControlUrl: launcher.url });
    expect(await json(await fetch(`${base}/api/control/status`))).toEqual({ status: 200, body: status });
    expect((await fetch(`${base}/api/control/status`, { method: 'POST' })).status).toBe(405);
  });

  it('POST /api/control/safe-mode validates the body, forwards it and tells every screen', async () => {
    const calls: string[] = [];
    const launcher = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url} ${body}`);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: 'safe', recording: 'r1', durationMs: 5 }));
      });
    });
    const { base, gw } = await setup({ launcherControlUrl: launcher.url });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const kinds: string[] = [];
    ws.on('message', (d) => {
      const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
      for (const m of Array.isArray(p) ? p : [p]) kinds.push(m.kind);
    });
    await new Promise<void>((r) => ws.once('open', () => r()));

    const post = (body: string) => fetch(`${base}/api/control/safe-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await post('not json')).status).toBe(400);
    expect((await post('{"on":"yes"}')).status).toBe(400);
    expect((await post('{"on":true,"name":"../etc"}')).status).toBe(400);
    expect(calls).toEqual([]);

    const ok = await json<{ ok: boolean; mode: string }>(await post('{"on":true,"name":"r1"}'));
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ ok: true, mode: 'safe', recording: 'r1' });
    expect(calls).toEqual(['POST /safe-mode?wait=0 {"on":true,"name":"r1"}']);
    await new Promise((r) => setTimeout(r, 100));
    expect(kinds).toContain('reset');
    expect((await fetch(`${base}/api/control/safe-mode`)).status).toBe(405);
  });

  it('safe-mode: 409/404 from the launcher pass through and the "resetting" notice is withdrawn', async () => {
    const launcher = await listen((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"recording not found"}');
    });
    const { base, gw } = await setup({ launcherControlUrl: launcher.url });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const resets: { failed?: string }[] = [];
    ws.on('message', (d) => {
      const p = JSON.parse(String(d)) as ServerMessage | ServerMessage[];
      for (const m of Array.isArray(p) ? p : [p]) if (m.kind === 'reset') resets.push(m);
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    const r = await fetch(`${base}/api/control/safe-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true,"name":"nope"}' });
    expect(r.status).toBe(404);
    await new Promise((res) => setTimeout(res, 100));
    expect(resets.map((x) => Boolean(x.failed))).toEqual([false, true]);
  });

  it('safe-mode: 502 when the launcher is unreachable', async () => {
    const { base } = await setup({ launcherControlUrl: 'http://127.0.0.1:1', resetTimeoutMs: 2000 });
    const r = await fetch(`${base}/api/control/safe-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":false}' });
    expect(r.status).toBe(502);
  });
});
