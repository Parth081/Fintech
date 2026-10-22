// End-to-end proof of M1 "done when": the real processes (broker, payment API, 7 stage
// processes, gateway) run on this machine on 127.0.0.1 only, and a payment travels from
// start to settled and reconciled, visible through the same API and WebSocket the screen uses.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { isBalanced, PIPELINE, type AnyEvent, type PaymentState } from '@ct/contracts';
import { launch } from '../../tools/launcher/launch';

const PORTS = { broker: 17070, paymentApi: 17071, gateway: 17072 };
const dataDir = mkdtempSync(join(tmpdir(), 'ct-e2e-'));
let system: Awaited<ReturnType<typeof launch>>;
let gw = '';

async function startSystem() {
  system = await launch({
    host: '127.0.0.1',
    ports: PORTS,
    dataDir,
    stageDelayMs: 0,
    settlementDelayMs: 50,
    quiet: true,
    buildWeb: false,
  });
  gw = system.urls.gateway.replace(/\/$/, '');
}

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${gw}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

async function waitForStatus(paymentId: string, statuses: string[], timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${gw}/api/payments/${paymentId}`);
    if (res.status === 200) {
      const body = (await res.json()) as { state: PaymentState; events: AnyEvent[] };
      if (statuses.includes(body.state.status)) return body;
    }
    if (Date.now() > deadline) throw new Error(`payment ${paymentId} did not reach ${statuses.join('/')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const HAPPY_SEQUENCE = [
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

describe('M1 walking skeleton (real processes)', () => {
  beforeAll(startSystem, 120000);
  afterAll(async () => {
    await system?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }, 60000);

  it('binds every service to localhost only', () => {
    for (const url of Object.values(system.urls)) expect(url).toMatch(/^(http|ws):\/\/127\.0\.0\.1:/);
  });

  it('moves one payment from initiated to settled and reconciled', async () => {
    const created = await json<{ paymentId: string }>('/api/payments/sample', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect([200, 202]).toContain(created.status);
    const { state, events } = await waitForStatus(created.body.paymentId, ['reconciled']);

    expect(events.map((e) => e.type)).toEqual(HAPPY_SEQUENCE);
    expect(state.history.map((h) => h.status)).toEqual([...PIPELINE.slice(0, 7), 'settled', 'reconciled']);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);

    // every step is a separate producer and records why it decided what it did
    expect(new Set(events.map((e) => e.producer))).toEqual(
      new Set(['payment-api', 'screening', 'risk', 'fx', 'routing', 'settlement', 'ledger', 'reconciliation']),
    );
    for (const e of events) {
      expect(e.trace, `${e.type} has a decision trace`).toBeDefined();
      expect(e.trace!.reasonCodes.length).toBeGreaterThan(0);
    }
    // causation chain links each event to the one before it
    for (let i = 1; i < events.length; i++) expect(events[i]!.causationId).toBe(events[i - 1]!.eventId);

    const ledger = events.find((e) => e.type === 'ledger.posted');
    expect(ledger && ledger.type === 'ledger.posted' && isBalanced(ledger.payload.entries)).toBe(true);
  });

  it('pushes live updates over the WebSocket the screen uses', async () => {
    const ws = new WebSocket(`${gw.replace('http', 'ws')}/ws`);
    const messages: { kind: string; event?: AnyEvent }[] = [];
    ws.on('message', (data) => {
      const parsed = JSON.parse(String(data));
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) messages.push(m);
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    const created = await json<{ paymentId: string }>('/api/payments/sample', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    await waitForStatus(created.body.paymentId, ['reconciled']);
    await new Promise((r) => setTimeout(r, 500));
    ws.close();

    expect(messages[0]?.kind).toBe('snapshot');
    const live = messages
      .flatMap((m) => (m.kind === 'event' && m.event ? [m.event] : (m as { events?: AnyEvent[] }).events ?? []))
      .filter((e) => e.paymentId === created.body.paymentId)
      .map((e) => e.type);
    expect(live).toEqual(HAPPY_SEQUENCE);
  });

  it('handles 10 concurrent payments', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, async () => {
      const r = await json<{ paymentId: string }>('/api/payments/sample', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      return r.body.paymentId;
    }));
    expect(new Set(ids).size).toBe(10);
    await Promise.all(ids.map((id) => waitForStatus(id, ['reconciled'], 30000)));
  });

  it('stops a held-scenario payment at the risk stage', async () => {
    const r = await json<{ paymentId: string }>('/api/payments/sample', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'force-hold' }),
    });
    const { events } = await waitForStatus(r.body.paymentId, ['held']);
    await new Promise((res) => setTimeout(res, 500));
    const again = await json<{ events: AnyEvent[] }>(`/api/payments/${r.body.paymentId}`);
    expect(again.body.events.map((e) => e.type)).toEqual(['payment.initiated', 'payment.screened', 'payment.held']);
    expect(events.at(-1)?.producer).toBe('risk');
  });

  it('honours idempotency keys', async () => {
    const body = JSON.stringify({
      amount: { amountMinor: 50_000, currency: 'EUR' },
      targetCurrency: 'BRL',
      corridor: 'DE-BR',
      debtor: { name: 'Fictional GmbH', country: 'DE', accountId: 'ACC-DE-9' },
      creditor: { name: 'Loja Ficticia', country: 'BR', accountId: 'ACC-BR-9' },
    });
    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'e2e-key-1' }, body };
    const a = await json<{ paymentId: string }>('/api/payments', init);
    const b = await json<{ paymentId: string }>('/api/payments', init);
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.paymentId).toBe(a.body.paymentId);
    await waitForStatus(a.body.paymentId, ['reconciled']);
  });

  it('rejects an invalid payment', async () => {
    const r = await fetch(`${gw}/api/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: { amountMinor: -5, currency: 'USD' }, corridor: 'US-IN', targetCurrency: 'INR' }),
    });
    expect(r.status).toBe(400);
  });

  it('keeps every payment after a full restart (durable event log)', async () => {
    const before = await json<{ paymentId: string; status: string }[]>('/api/payments?limit=100');
    await system.stop();
    await startSystem();
    const deadline = Date.now() + 15000;
    let after = await json<{ paymentId: string; status: string }[]>('/api/payments?limit=100');
    while (after.body.length < before.body.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      after = await json('/api/payments?limit=100');
    }
    const statusById = (list: { paymentId: string; status: string }[]) =>
      Object.fromEntries(list.map((p) => [p.paymentId, p.status]));
    expect(statusById(after.body)).toEqual(statusById(before.body));

    const stats = await json<{ rejectedEvents: number }>('/api/stats');
    expect(stats.body.rejectedEvents).toBe(0);

    // and the restarted system still processes new payments
    const r = await json<{ paymentId: string }>('/api/payments/sample', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    await waitForStatus(r.body.paymentId, ['reconciled']);
  }, 120000);

  it('serves the screen from the gateway', async () => {
    const res = await fetch(`${gw}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    if (existsSync(join(process.cwd(), 'apps/web/dist/index.html'))) expect(html).toContain('<div id="root">');
  });
});
