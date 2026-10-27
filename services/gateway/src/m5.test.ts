// M5: the gateway proxies /api/assistant/* to the AI explainer and /api/booth/* to the booth service.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryBus } from '@ct/event-bus';
import { newId } from '@ct/contracts';
import { startGateway, type GatewayOptions } from './server';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Seen {
  method: string;
  path: string;
  staff: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** Fake upstream: records each request and answers via `reply`. */
async function fakeUpstream(
  reply: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body: string },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const staff = req.headers['x-booth-staff'];
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        staff: typeof staff === 'string' ? staff : undefined,
        contentType: req.headers['content-type'],
        body,
      });
      const r = reply(req, body);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

async function setup(opts: Partial<GatewayOptions> = {}) {
  const bus = new InMemoryBus();
  const gw = await startGateway({
    bus,
    host: '127.0.0.1',
    port: 0,
    paymentApiUrl: 'http://127.0.0.1:1',
    ledgerUrl: 'http://127.0.0.1:1',
    orchestratorUrl: 'http://127.0.0.1:1',
    assistantUrl: 'http://127.0.0.1:1',
    boothUrl: 'http://127.0.0.1:1',
    webDist: join(tmpdir(), `ct-no-dist-${newId()}`),
    statsIntervalMs: 0,
    controlIntervalMs: 0,
    ...opts,
  });
  cleanups.push(async () => {
    await gw.close();
    await bus.close();
  });
  await gw.replayed;
  return `http://127.0.0.1:${gw.port}`;
}

describe('assistant proxy', () => {
  it('passes POST /api/assistant/ask through with body and status', async () => {
    const up = await fakeUpstream((req, body) => ({ status: 200, body: JSON.stringify({ echo: JSON.parse(body || 'null'), path: req.url }) }));
    const base = await setup({ assistantUrl: up.url });
    const res = await fetch(`${base}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Why was it held?', context: { kind: 'system' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo: { question: string }; path: string };
    expect(body.echo.question).toBe('Why was it held?');
    expect(up.seen[0]).toMatchObject({ method: 'POST', path: '/ask', contentType: 'application/json' });
  });

  it('passes the query string of GET /api/assistant/suggestions and upstream errors', async () => {
    const up = await fakeUpstream((req) => (req.url?.startsWith('/suggestions') ? { status: 200, body: '[]' } : { status: 400, body: '{"error":"bad"}' }));
    const base = await setup({ assistantUrl: up.url });
    const ok = await fetch(`${base}/api/assistant/suggestions?context=payment:p-1`);
    expect(ok.status).toBe(200);
    expect(up.seen[0]?.path).toBe('/suggestions?context=payment:p-1');
    const bad = await fetch(`${base}/api/assistant/ask`, { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad' });
  });

  it('answers 502 JSON when the assistant is down', async () => {
    const base = await setup();
    const res = await fetch(`${base}/api/assistant/health`);
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(((await res.json()) as { error: string }).error).toBe('assistant unavailable');
  });
});

describe('booth proxy', () => {
  it('passes the X-Booth-Staff header and DELETE through', async () => {
    const up = await fakeUpstream((req) =>
      req.headers['x-booth-staff'] === '2468' ? { status: 200, body: '{"deleted":true}' } : { status: 401, body: '{"error":"staff only"}' },
    );
    const base = await setup({ boothUrl: up.url });
    const denied = await fetch(`${base}/api/booth/leads/l-1`, { method: 'DELETE' });
    expect(denied.status).toBe(401);
    expect(up.seen[0]?.staff).toBeUndefined();
    const ok = await fetch(`${base}/api/booth/leads/l-1`, { method: 'DELETE', headers: { 'x-booth-staff': '2468' } });
    expect(ok.status).toBe(200);
    expect(up.seen[1]).toMatchObject({ method: 'DELETE', path: '/leads/l-1', staff: '2468' });
  });

  it('keeps the CSV content type and disposition of the lead export', async () => {
    const up = await fakeUpstream(() => ({
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leads.csv"' },
      body: 'id,name\nl-1,Ada\n',
    }));
    const base = await setup({ boothUrl: up.url });
    const res = await fetch(`${base}/api/booth/leads/export.csv`, { headers: { 'x-booth-staff': '2468' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/leads\.csv/);
    expect(await res.text()).toBe('id,name\nl-1,Ada\n');
  });

  it('passes POST /api/booth/leads bodies and answers 502 JSON when the booth is down', async () => {
    const up = await fakeUpstream((_req, body) => ({ status: 400, body: JSON.stringify({ error: 'consent required', got: JSON.parse(body) }) }));
    const base = await setup({ boothUrl: up.url });
    const res = await fetch(`${base}/api/booth/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"A"}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { got: { name: string } }).got.name).toBe('A');

    const down = await setup();
    const r = await fetch(`${down}/api/booth/summary`, { headers: { 'x-booth-staff': '2468' } });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toBe('booth unavailable');
  });
});
