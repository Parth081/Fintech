// M4: /api/ops/* proxy to the operations service and the console's extra payment filters.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryBus } from '@ct/event-bus';
import { newId } from '@ct/contracts';
import { startGateway, type GatewayOptions } from './server';
import { m2Payment } from './testing/m2-events';
import type { PaymentSummary, PaymentTrend } from './api-types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const T0 = Date.parse('2026-10-22T09:00:00.000Z');

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
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
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += String(c)));
    req.on('end', () => r(b));
  });
}

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
    opsUrl: 'http://127.0.0.1:1',
    webDist: join(tmpdir(), `ct-no-dist-${newId()}`),
    flushIntervalMs: 10,
    statsIntervalMs: 0,
    controlIntervalMs: 0,
    breakers: () => [],
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

describe('/api/ops/* proxy', () => {
  it('passes method, path, query, body and Authorization through; returns status, X-Total-Count and content type', async () => {
    const seen: { method?: string; url?: string; auth?: string; body: string; ctype?: string }[] = [];
    const opsUrl = await listen(async (req, res) => {
      const body = await readAll(req);
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, ctype: req.headers['content-type'] });
      if (req.url?.startsWith('/audit/export.csv')) {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit.csv"' });
        return res.end('id,action\na1,auth.login\n');
      }
      if (req.url?.startsWith('/cases')) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-total-count': '42' });
        return res.end(JSON.stringify([{ caseId: 'CASE-1' }]));
      }
      if (req.url === '/payments/p1/retry') {
        res.writeHead(req.headers.authorization ? 202 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(req.headers.authorization ? { eventId: 'e1' } : { error: 'unauthorized' }));
      }
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', permission: 'audit.read' }));
    });
    const { base } = await setup({ opsUrl });

    const list = await fetch(`${base}/api/ops/cases?status=open&limit=5`, { headers: { authorization: 'Bearer tok-1' } });
    expect(list.status).toBe(200);
    expect(list.headers.get('x-total-count')).toBe('42');
    expect(await list.json()).toEqual([{ caseId: 'CASE-1' }]);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/cases?status=open&limit=5', auth: 'Bearer tok-1', body: '' });

    const post = await fetch(`${base}/api/ops/payments/p1/retry`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-2', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'provider back up' }),
    });
    expect(post.status).toBe(202);
    expect(await post.json()).toEqual({ eventId: 'e1' });
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/payments/p1/retry', auth: 'Bearer tok-2', ctype: 'application/json' });
    expect(JSON.parse(seen[1]!.body)).toEqual({ reason: 'provider back up' });

    const noAuth = await fetch(`${base}/api/ops/payments/p1/retry`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(seen[2]!.auth).toBeUndefined();

    const forbidden = await fetch(`${base}/api/ops/audit`, { headers: { authorization: 'Bearer x' } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ permission: 'audit.read' });

    const csv = await fetch(`${base}/api/ops/audit/export.csv?actor=u-maya`, { headers: { authorization: 'Bearer x' } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('audit.csv');
    expect(await csv.text()).toBe('id,action\na1,auth.login\n');

    const del = await fetch(`${base}/api/ops/developer/keys/k1`, { method: 'DELETE', headers: { authorization: 'Bearer x' } });
    expect(del.status).toBe(403);
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/developer/keys/k1' });
  });

  it('answers 502 JSON when the ops service is down', async () => {
    const { base } = await setup({ opsUrl: 'http://127.0.0.1:1' });
    const res = await fetch(`${base}/api/ops/overview`);
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'ops service unavailable' });
  });
});

describe('/api/payments console filters', () => {
  it('filters by text, currency, amount range and date range, with X-Total-Count', async () => {
    const events = [
      ...m2Payment('pay-small', { startMs: T0, amountMinor: 5_000 }),
      ...m2Payment('pay-big', { startMs: T0 + 60_000, amountMinor: 900_000 }),
      ...m2Payment('pay-eu', { startMs: T0 + 120_000, corridorIndex: 1, amountMinor: 250_000 }),
    ];
    const { base } = await setup({}, events);
    const get = async (qs: string) => {
      const res = await fetch(`${base}/api/payments?${qs}`);
      return { total: Number(res.headers.get('x-total-count')), ids: ((await res.json()) as PaymentSummary[]).map((p) => p.paymentId) };
    };
    expect(await get('limit=10')).toEqual({ total: 3, ids: ['pay-eu', 'pay-big', 'pay-small'] });
    expect((await get('q=PAY-BIG')).ids).toEqual(['pay-big']);
    expect((await get('q=northwind')).total).toBe(3); // debtor name
    expect((await get('q=MSG-pay-small')).ids).toEqual(['pay-small']); // pacs.008 message id
    expect((await get('minAmount=1000')).ids).toEqual(['pay-eu', 'pay-big']);
    expect((await get('minAmount=1000&maxAmount=5000')).ids).toEqual(['pay-eu']);
    const eu = await get('currency=EUR');
    expect(eu.ids).toEqual(['pay-eu']);
    expect((await get(`from=${encodeURIComponent(new Date(T0 + 30_000).toISOString())}&to=${encodeURIComponent(new Date(T0 + 90_000).toISOString())}`)).ids).toEqual(['pay-big']);
    expect((await get('q=nothing-matches')).total).toBe(0);
    expect((await get('minAmount=abc')).total).toBe(3); // ignored
  });
});

describe('/api/payments/trend', () => {
  it('counts payments initiated and failed per minute over the window', async () => {
    const events = [
      ...m2Payment('t1', { startMs: T0 + 5_000 }),
      ...m2Payment('t2', { startMs: T0 + 10_000, outcome: 'failed' }),
      ...m2Payment('t3', { startMs: T0 + 70_000 }),
      ...m2Payment('old', { startMs: T0 - 3_600_000 }),
    ];
    const { base } = await setup({ now: () => T0 + 90_000 }, events);
    const res = await fetch(`${base}/api/payments/trend?minutes=5`);
    const t = (await res.json()) as PaymentTrend;
    expect(t.bucketMs).toBe(60_000);
    expect(t.initiated).toHaveLength(5);
    expect(t.initiated.slice(-2)).toEqual([2, 1]);
    expect(t.failed.slice(-2)).toEqual([1, 0]);
    expect(t.initiated.reduce((a, b) => a + b, 0)).toBe(3);
    expect(t.fromMs).toBe(T0 + 120_000 - 5 * 60_000);
  });
});
