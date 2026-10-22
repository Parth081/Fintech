import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { InMemoryBus } from '@ct/event-bus';
import { newId, type AnyEvent } from '@ct/contracts';
import { happyPath, makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { startGateway, type GatewayHandle } from './server';
import type { PaymentDetail, PaymentSummary, ServerMessage, Stats, UpdateMessage } from './api-types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: { paymentApiUrl?: string; webDist?: string } = {}) {
  const bus = new InMemoryBus();
  const gw: GatewayHandle = await startGateway({
    bus,
    host: '127.0.0.1',
    port: 0,
    paymentApiUrl: opts.paymentApiUrl ?? 'http://127.0.0.1:1',
    webDist: opts.webDist ?? join(tmpdir(), `ct-no-dist-${newId()}`),
    flushIntervalMs: 10,
  });
  cleanups.push(async () => {
    await gw.close();
    await bus.close();
  });
  const base = `http://127.0.0.1:${gw.port}`;
  return { bus, gw, base };
}

async function publishAll(bus: InMemoryBus, events: AnyEvent[]) {
  for (const e of events) await bus.publish(e);
  await bus.drain();
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

/** Raw GET that does not normalise `..` segments (fetch would). */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('projection over the bus', () => {
  it('builds summaries, stats and detail from a happy path', async () => {
    const { bus, base } = await setup();
    const a = happyPath('pay-a');
    const b = happyPath('pay-b').slice(0, 5); // stops at routed
    await publishAll(bus, [...a, ...b]);

    const health = await getJson<{ ok: boolean; payments: number; events: number }>(`${base}/health`);
    expect(health.body).toMatchObject({ ok: true, payments: 2, events: 14, replayed: true });

    const list = await getJson<PaymentSummary[]>(`${base}/api/payments?limit=50`);
    expect(list.body.map((p) => p.paymentId)).toEqual(['pay-b', 'pay-a']);
    const [pb, pa] = list.body;
    expect(pa).toMatchObject({
      status: 'reconciled',
      corridor: 'US-IN',
      amount: { amountMinor: 125_000, currency: 'USD' },
      targetAmount: { amountMinor: 10_406_250, currency: 'INR' },
      providerId: 'orion',
      stepIndex: 7,
      ledgerPosted: true,
      endToEndMs: 9000,
    });
    expect(pb).toMatchObject({ status: 'routed', stepIndex: 4, providerId: 'orion' });

    const limited = await getJson<PaymentSummary[]>(`${base}/api/payments?limit=1`);
    expect(limited.body).toHaveLength(1);

    const stats = await getJson<Stats>(`${base}/api/stats`);
    expect(stats.body).toMatchObject({ total: 2, reconciled: 1, inFlight: 1, held: 0, rejectedEvents: 0, avgEndToEndMs: 9000 });
    expect(stats.body.byStatus.routed).toBe(1);

    const detail = await getJson<PaymentDetail>(`${base}/api/payments/pay-a`);
    expect(detail.status).toBe(200);
    expect(detail.body.state.status).toBe('reconciled');
    expect(detail.body.events.map((e) => e.type)).toEqual(a.map((e) => e.type));

    const missing = await getJson<{ error: string }>(`${base}/api/payments/nope`);
    expect(missing.status).toBe(404);
  });

  it('reports held payments with stepIndex -1 and keeps traces', async () => {
    const { bus, base } = await setup();
    const id = 'pay-held';
    await publishAll(bus, [
      makeEvent('payment.initiated', id, sampleInitiatedPayload({ scenario: 'force-hold' })),
      makeEvent('payment.screened', id, { result: 'clear', listVersion: 'v1' }, { producer: 'screening' }),
      makeEvent('payment.held', id, { reason: 'AML review', atStage: 'risk' }, {
        producer: 'risk',
        trace: { stage: 'risk', decision: 'hold', reasonCodes: ['FORCED_HOLD'], inputs: { score: 0.9 }, ruleVersion: 'r1', latencyMs: 3 },
      }),
    ] as AnyEvent[]);
    const [p] = (await getJson<PaymentSummary[]>(`${base}/api/payments`)).body;
    expect(p).toMatchObject({ status: 'held', stepIndex: -1, lastPipelineIndex: 1, scenario: 'force-hold', reason: 'AML review' });
    const detail = (await getJson<PaymentDetail>(`${base}/api/payments/${id}`)).body;
    expect(detail.events.at(-1)?.trace?.reasonCodes).toEqual(['FORCED_HOLD']);
    const stats = (await getJson<Stats>(`${base}/api/stats`)).body;
    expect(stats).toMatchObject({ held: 1, inFlight: 0, avgEndToEndMs: null });
  });

  it('puts invalid events in the rejected list without crashing; duplicates are ignored', async () => {
    const { bus, base } = await setup();
    const events = happyPath('pay-x');
    await publishAll(bus, [
      events[0]!,
      events[0]!, // duplicate eventId: idempotent, not an error
      events[2]!, // scored before screened: invalid
      makeEvent('payment.screened', 'ghost', { result: 'clear', listVersion: 'v1' }), // unknown payment
      { garbage: true } as unknown as AnyEvent,
      events[1]!,
    ]);
    const stats = (await getJson<Stats>(`${base}/api/stats`)).body;
    expect(stats.rejectedEvents).toBe(3);
    expect(stats.total).toBe(1);
    const rejected = (await getJson<{ error: string }[]>(`${base}/api/rejected`)).body;
    expect(rejected).toHaveLength(3);
    expect(rejected[0]!.error).toMatch(/Invalid transition/);
    const detail = (await getJson<PaymentDetail>(`${base}/api/payments/pay-x`)).body;
    expect(detail.state.status).toBe('screened');
    expect(detail.events).toHaveLength(2);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe('websocket', () => {
  it('sends a snapshot then live events in order', async () => {
    const { bus, gw } = await setup();
    await publishAll(bus, happyPath('pay-old'));

    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    cleanups.push(() => ws.terminate());
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as ServerMessage | ServerMessage[];
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const live = happyPath('pay-new');
    await publishAll(bus, live);
    const updates = () => messages.filter((m): m is UpdateMessage => m.kind === 'update');
    const deadline = Date.now() + 3000;
    while (updates().flatMap((m) => m.events).length < live.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const first = messages[0];
    expect(first?.kind).toBe('snapshot');
    if (first?.kind === 'snapshot') {
      expect(first.payments.map((p) => p.paymentId)).toEqual(['pay-old']);
      expect(first.stats.reconciled).toBe(1);
    }
    expect(updates().flatMap((m) => m.events).map((e) => e.type)).toEqual(live.map((e) => e.type));
    const last = updates().at(-1)!;
    expect(last.payments.at(-1)?.paymentId).toBe('pay-new');
    expect(last.payments.at(-1)?.status).toBe('reconciled');
    expect(last.stats.reconciled).toBe(2);
  });

  it('rejects upgrades on other paths', async () => {
    const { gw } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/other`);
    const err = await new Promise<unknown>((resolve) => {
      ws.once('error', resolve);
      ws.once('open', () => resolve(null));
    });
    expect(err).toBeTruthy();
  });
});

describe('payment API proxy', () => {
  it('passes body, status and Idempotency-Key through', async () => {
    const seen: { method?: string; url?: string; key?: string; body: string }[] = [];
    const fake: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, key: req.headers['idempotency-key'] as string | undefined, body });
        res.writeHead(req.url === '/payments' ? 202 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ paymentId: 'p-123', via: req.url }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => fake.close(() => r())));
    const addr = fake.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const { base } = await setup({ paymentApiUrl: `http://127.0.0.1:${port}` });

    const a = await fetch(`${base}/api/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k-1' },
      body: '{"corridor":"US-IN"}',
    });
    expect(a.status).toBe(202);
    expect(await a.json()).toEqual({ paymentId: 'p-123', via: '/payments' });

    const b = await fetch(`${base}/api/payments/sample`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"scenario":"force-hold"}',
    });
    expect(b.status).toBe(200);
    expect(seen).toEqual([
      { method: 'POST', url: '/payments', key: 'k-1', body: '{"corridor":"US-IN"}' },
      { method: 'POST', url: '/payments/sample', key: undefined, body: '{"scenario":"force-hold"}' },
    ]);
  });

  it('returns 502 JSON when the payment API is down', async () => {
    const dead: Server = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const addr = dead.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((r) => dead.close(() => r()));
    const { base } = await setup({ paymentApiUrl: `http://127.0.0.1:${port}` });
    const res = await fetch(`${base}/api/payments/sample`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'payment API unavailable' });
  });
});

describe('static files', () => {
  it('serves files with content types, SPA fallback and blocks traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-gw-static-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets', 'app.css'), 'body{}');
    writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET');
    const { base, gw } = await setup({ webDist: dist });

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect(await index.text()).toContain('<div id="root">');

    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const css = await fetch(`${base}/assets/app.css`);
    expect(css.headers.get('content-type')).toMatch(/text\/css/);

    const spa = await fetch(`${base}/payments/some-id`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<div id="root">');

    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);

    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%5c..%5csecret.txt', '/%2e%2e%2f%2e%2e%2fsecret.txt']) {
      const r = await rawGet(gw.port, p);
      expect(r.body, p).not.toContain('TOP-SECRET');
    }
  });

  it('explains how to build the UI when dist is missing', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UI not built: run npm run build:web');
  });
});
