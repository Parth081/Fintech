import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { InMemoryBus } from '@ct/event-bus';
import { newId, type AnyEvent, type PaymentState } from '@ct/contracts';
import { startGateway, type GatewayOptions } from './server';
import { MAX_EVENTS_PER_PAYMENT, Projection } from './projection';
import { m2Log, m2Payment } from './testing/m2-events';
import type { Camt053Input, IsoPort, MarketPort } from './views';
import type {
  FxCorridorRates,
  Health,
  IsoMessage,
  PaymentDetail,
  PaymentSummary,
  ProviderView,
  ServerMessage,
  StatementRef,
  Stats,
  Throughput,
  UpdateMessage,
} from './api-types';
import { ThroughputMeter } from './throughput';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const T0 = Date.parse('2026-10-22T09:00:00.000Z');

function fakeMarket(over: Partial<MarketPort> = {}): MarketPort & { healthCalls: string[] } {
  const healthCalls: string[] = [];
  return {
    healthCalls,
    rateAt: (corridorId, atMs) => ({ corridorId, mid: corridorId === 'US-IN' ? '83.2500' : '5.9100', atMs }),
    rateSeries: (_c, from, to, step) => {
      const out: { atMs: number; mid: string }[] = [];
      for (let t = from; t <= to; t += step) out.push({ atMs: t, mid: (80 + ((t / step) % 7)).toFixed(4) });
      return out;
    },
    providerHealth: (states: Iterable<PaymentState>, providerId: string) => {
      healthCalls.push(providerId);
      let attempts = 0;
      for (const s of states) if (s.facts['payment.sent']?.providerId === providerId) attempts++;
      return { providerId, attempts, settled: attempts, failed: 0, successRate: 0.95, avgLatencyMs: 1234 };
    },
    providerProfile: (id) =>
      id === 'orion'
        ? { id, name: 'Provider Orion', rail: 'Rail-A (instant)', bic: 'XORIUS33XXX', fees: { 'US-IN': { fixedMinor: 150, bps: 20 } }, baseSuccessRate: 0.97, latencyMs: { p50: 900, p95: 2500 } }
        : undefined,
    catalog: [],
    ...over,
  };
}

async function setup(opts: Partial<GatewayOptions> & { events?: AnyEvent[] } = {}) {
  const bus = new InMemoryBus();
  for (const e of opts.events ?? []) await bus.publish(e);
  const { events: _e, ...rest } = opts;
  void _e;
  const gw = await startGateway({
    bus,
    host: '127.0.0.1',
    port: 0,
    paymentApiUrl: 'http://127.0.0.1:1',
    ledgerUrl: 'http://127.0.0.1:1',
    webDist: join(tmpdir(), `ct-no-dist-${newId()}`),
    flushIntervalMs: 10,
    statsIntervalMs: 0,
    market: fakeMarket(),
    ...rest,
  });
  cleanups.push(async () => {
    await gw.close();
    await bus.close();
  });
  await gw.replayed;
  await bus.drain();
  return { bus, gw, base: `http://127.0.0.1:${gw.port}` };
}

async function getJson<T>(url: string): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  return { server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

describe('projection with M2 statuses', () => {
  const p = new Projection({ now: () => T0 });
  const outcomes = ['settled', 'retry', 'failed', 'break', 'held'] as const;
  outcomes.forEach((o, i) => m2Payment(`p-${o}`, { outcome: o, corridorIndex: i === 3 ? 0 : i, startMs: T0 + i * 10_000 }).forEach((e) => p.apply(e)));

  it('counts retrying/failed/retries/recon breaks incrementally', () => {
    const s = p.stats();
    expect(s).toMatchObject({ total: 5, reconciled: 3, held: 1, failed: 1, retrying: 0, reconBreaks: 1, reconMatched: 2, inFlight: 0 });
    // retry: 1 reject; failed on corridor index 2 (GB-PH, 3 providers): 3 rejects
    expect(s.retriesTotal).toBe(4);
    expect(s.byStatus.failed).toBe(1);
    expect(s.events).toBe(p.totalEvents);
    const sum = Object.values(s.byStatus).reduce((a, b) => a + b, 0);
    expect(sum).toBe(5);
  });

  it('summarises attempts, retries, failure reason and recon outcome', () => {
    expect(p.summary('p-retry')).toMatchObject({ status: 'reconciled', attempt: 2, retries: 1, recon: 'matched', providerId: 'vega' });
    expect(p.summary('p-break')).toMatchObject({ recon: 'break' });
    expect(p.summary('p-failed')).toMatchObject({ status: 'failed', retries: 3, stepIndex: -1, reason: 'All eligible providers rejected the instruction' });
  });

  it('reports retrying while waiting for a re-route', () => {
    const q = new Projection();
    const evs = m2Payment('r', { outcome: 'retry' });
    const idx = evs.findIndex((e) => e.type === 'payment.send_failed');
    evs.slice(0, idx + 1).forEach((e) => q.apply(e));
    expect(q.stats()).toMatchObject({ retrying: 1, inFlight: 1, retriesTotal: 1 });
    expect(q.summary('r')).toMatchObject({ status: 'retrying', reason: 'AC04 Closed account number' });
    q.apply(evs[idx + 1]!);
    expect(q.stats().retrying).toBe(0);
  });

  it('extracts ISO messages in log order', () => {
    const msgs = p.messages('p-retry')!;
    expect(msgs.map((m) => [m.eventType, m.messageType, m.status ?? null, m.attempt])).toEqual([
      ['payment.sent', 'pacs.008', null, 1],
      ['payment.send_failed', 'pacs.002', 'RJCT', 1],
      ['payment.sent', 'pacs.008', null, 2],
      ['payment.settled', 'pacs.002', 'ACSC', 2],
    ]);
    expect(msgs[1]!.reasonCode).toBe('AC04');
    expect(msgs[0]!.xml).toContain('<FIToFICstmrCdtTrf>');
    expect(p.messages('nope')).toBeUndefined();
  });

  it('keeps per-payment memory bounded on a runaway retry loop', () => {
    const q = new Projection();
    const base = m2Payment('loop', { outcome: 'retry' });
    const upToRetry = base.slice(0, base.findIndex((e) => e.type === 'payment.send_failed') + 1);
    upToRetry.forEach((e) => q.apply(e));
    const [routed, sent, failed] = base.filter((e) => ['payment.routed', 'payment.sent', 'payment.send_failed'].includes(e.type));
    for (let i = 0; i < 40; i++) {
      for (const e of [routed!, sent!, failed!]) expect(q.apply({ ...e, eventId: `${e.eventId}-x${i}` } as AnyEvent).kind).toBe('applied');
    }
    const d = q.detail('loop')!;
    expect(d.events).toHaveLength(MAX_EVENTS_PER_PAYMENT);
    expect(d.events[0]!.type).toBe('payment.initiated');
    expect(d.droppedEvents).toBe(upToRetry.length + 120 - MAX_EVENTS_PER_PAYMENT);
  });
});

describe('throughput meter', () => {
  it('counts events, payments and completions within the last minute by event time', () => {
    let now = T0;
    const m = new ThroughputMeter(() => now);
    m.record(T0 - 120_000, { initiated: true }); // too old
    for (let i = 0; i < 30; i++) m.record(T0 - i * 1000, { initiated: i % 3 === 0, completed: i % 5 === 0 });
    const r = m.read();
    expect(r.eventsLastMinute).toBe(30);
    expect(r.paymentsPerMin).toBe(10);
    expect(r.completedPerMin).toBe(6);
    expect(r.eventsPerSec).toBe(0.5);
    expect(r.series).toHaveLength(60);
    expect(r.series.at(-1)).toBe(1);
    now = T0 + 45_000;
    expect(m.read().eventsLastMinute).toBe(15 - 1); // seconds T0-14..T0 still inside (T0-15s fell out)
    now = T0 + 200_000;
    expect(m.read().eventsLastMinute).toBe(0);
  });
});

describe('payments pagination and filters', () => {
  it('filters by status, corridor and provider with totals', async () => {
    const { base } = await setup({ events: m2Log(120, { startMs: T0 }) });
    const all = await getJson<PaymentSummary[]>(`${base}/api/payments?limit=10`);
    expect(all.body).toHaveLength(10);
    expect(all.headers.get('x-total-count')).toBe('120');
    expect(all.body[0]!.paymentId).toBe('pay-000119');
    const page2 = await getJson<PaymentSummary[]>(`${base}/api/payments?limit=10&offset=10`);
    expect(page2.body[0]!.paymentId).toBe('pay-000109');

    const failed = await getJson<PaymentSummary[]>(`${base}/api/payments?status=failed&limit=100`);
    expect(failed.body.every((p) => p.status === 'failed')).toBe(true);
    expect(Number(failed.headers.get('x-total-count'))).toBe(failed.body.length);
    expect(failed.body.length).toBeGreaterThan(0);

    const multi = await getJson<PaymentSummary[]>(`${base}/api/payments?status=failed,held&limit=1000`);
    expect(multi.body.every((p) => p.status === 'failed' || p.status === 'held')).toBe(true);
    expect(multi.body.length).toBeGreaterThan(failed.body.length);

    const corridor = await getJson<PaymentSummary[]>(`${base}/api/payments?corridor=DE-BR&limit=1000`);
    expect(corridor.body).toHaveLength(40);
    expect(corridor.body.every((p) => p.corridor === 'DE-BR')).toBe(true);

    const prov = await getJson<PaymentSummary[]>(`${base}/api/payments?provider=vega&corridor=US-IN&limit=1000&offset=1`);
    expect(prov.body.every((p) => p.providerId === 'vega' && p.corridor === 'US-IN')).toBe(true);
    expect(Number(prov.headers.get('x-total-count'))).toBe(prov.body.length + 1);

    const none = await getJson<PaymentSummary[]>(`${base}/api/payments?status=bogus`);
    expect(none.body).toEqual([]);
  });
});

describe('M2 endpoints', () => {
  it('serves ISO messages for a payment', async () => {
    const { base } = await setup({ events: m2Payment('pm', { outcome: 'retry' }) });
    const r = await getJson<IsoMessage[]>(`${base}/api/payments/pm/messages`);
    expect(r.status).toBe(200);
    expect(r.body.map((m) => m.messageType)).toEqual(['pacs.008', 'pacs.002', 'pacs.008', 'pacs.002']);
    expect((await fetch(`${base}/api/payments/missing/messages`)).status).toBe(404);
    const d = await getJson<PaymentDetail>(`${base}/api/payments/pm`);
    expect(d.body.events.length).toBe(m2Payment('pm', { outcome: 'retry' }).length);
  });

  it('serves FX rates with series and quote stats; degrades when the market is down', async () => {
    const now = T0 + 3_600_000;
    const { base } = await setup({ events: m2Log(9, { startMs: T0 }), now: () => now });
    const r = await getJson<FxCorridorRates[]>(`${base}/api/fx/rates`);
    expect(r.body.map((c) => c.corridorId)).toEqual(['US-IN', 'DE-BR', 'GB-PH']);
    const us = r.body[0]!;
    expect(us.mid).toBe('83.2500');
    expect(us.series.length).toBe(61); // 15 min at 15 s, inclusive
    expect(us.series.at(-1)!.atMs).toBeLessThanOrEqual(now);
    expect(us.quotes.count).toBeGreaterThan(0);
    expect(us.quotes.avgSpreadBps).toBe(35);
    expect(us.quotes.lastMid).toBe('83.2500');

    const broken = await setup({
      events: m2Log(3, { startMs: T0 }),
      market: fakeMarket({ rateAt: () => { throw new Error('rateAt not implemented yet'); } }),
    });
    const b = await getJson<FxCorridorRates[]>(`${broken.base}/api/fx/rates`);
    expect(b.status).toBe(200);
    expect(b.body[0]).toMatchObject({ mid: null, series: [], marketError: 'rateAt not implemented yet' });
    expect(b.body[0]!.quotes.count).toBe(1);
  });

  it('serves providers with health, volume share, fees, retries and failures', async () => {
    const market = fakeMarket();
    const { base } = await setup({ events: m2Log(60, { startMs: T0 }), market });
    const r = await getJson<ProviderView[]>(`${base}/api/providers`);
    const ids = r.body.map((p) => p.providerId);
    expect(ids).toEqual(expect.arrayContaining(['orion', 'lyra', 'vega']));
    const share = r.body.reduce((a, p) => a + p.shareOfVolume, 0);
    expect(share).toBeCloseTo(1, 6);
    const orion = r.body.find((p) => p.providerId === 'orion')!;
    expect(orion).toMatchObject({ name: 'Provider Orion', bic: 'XORIUS33XXX', catalogue: { baseSuccessRate: 0.97 } });
    expect(orion.health).toMatchObject({ successRate: 0.95, avgLatencyMs: 1234 });
    expect(orion.retriesCaused).toBeGreaterThan(0);
    expect(orion.recentFailures[0]).toMatchObject({ reasonCode: 'AC04', attempt: 1 });
    expect(orion.failureReasons.AC04).toBe(orion.retriesCaused);
    expect(orion.avgFeeBps).toBeGreaterThan(0);
    expect(orion.avgFee[0]).toMatchObject({ amountMinor: 100 });
    expect(orion.observed.avgLatencyMs).toBe(120);
    expect(orion.observed.successRate).toBeGreaterThan(0);
    expect(orion.latestStatement).toBeDefined();

    const down = await setup({ events: m2Log(3, { startMs: T0 }), market: fakeMarket({ providerHealth: () => { throw new Error('not implemented'); } }) });
    const d = await getJson<ProviderView[]>(`${down.base}/api/providers`);
    expect(d.status).toBe(200);
    expect(d.body[0]).toMatchObject({ health: null, healthError: 'not implemented' });
  });

  it('lists statements and renders camt.053 via the injected builder', async () => {
    const calls: Camt053Input[] = [];
    const iso: IsoPort = { buildCamt053: (i) => (calls.push(i), `<Document><BkToCstmrStmt><Stmt><Id>${i.statementId}</Id></Stmt></BkToCstmrStmt></Document>`) };
    const { base } = await setup({ events: m2Log(30, { startMs: T0 }), iso });
    const list = await getJson<StatementRef[]>(`${base}/api/statements`);
    expect(list.body.length).toBeGreaterThan(0);
    const total = list.body.reduce((a, s) => a + s.entries, 0);
    const settled = (await getJson<Stats>(`${base}/api/stats`)).body.reconciled;
    expect(total).toBe(settled);
    const ref = list.body.find((s) => s.providerId === 'orion' && s.currency === 'INR')!;
    const res = await fetch(`${base}/api/statements/orion/${ref.date}?currency=INR`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/xml/);
    expect(await res.text()).toContain(ref.statementId);
    expect(calls.at(-1)).toMatchObject({ providerId: 'orion', currency: 'INR', date: ref.date, accountId: 'provider:orion:nostro:INR' });
    expect(calls.at(-1)!.entries).toHaveLength(ref.entries);
    expect(calls.at(-1)!.entries.every((e) => e.amount.currency === 'INR')).toBe(true);
    // default currency = largest group
    expect((await fetch(`${base}/api/statements/orion/${ref.date}`)).status).toBe(200);
    expect((await fetch(`${base}/api/statements/orion/1999-01-01`)).status).toBe(404);
    expect((await fetch(`${base}/api/statements/orion/${ref.date}?currency=JPY`)).status).toBe(404);

    const broken = await setup({ events: m2Log(3, { startMs: T0 }), iso: { buildCamt053: () => { throw new Error('not implemented'); } } });
    const date = (await getJson<StatementRef[]>(`${broken.base}/api/statements`)).body[0]!.date;
    const b = await fetch(`${broken.base}/api/statements/orion/${date}`);
    expect(b.status).toBe(503);
  });

  it('serves throughput over the last minute', async () => {
    const now = Date.parse('2026-10-22T10:00:00.000Z');
    const events = m2Log(20, { startMs: now - 30_000, spacingMs: 1000 });
    const { base } = await setup({ events, now: () => now });
    const r = await getJson<Throughput>(`${base}/api/throughput`);
    expect(r.body.paymentsPerMin).toBe(20);
    expect(r.body.eventsLastMinute).toBe(events.filter((e) => Date.parse(e.occurredAt) <= now).length);
    expect(r.body.completedPerMin).toBeGreaterThan(0);
    const stats = await getJson<Stats>(`${base}/api/stats`);
    expect(stats.body.throughput.paymentsPerMin).toBe(20);
  });

  it('reports replay completion in health', async () => {
    const events = m2Log(50, { startMs: T0 });
    const { base, gw } = await setup({ events });
    expect(await gw.replayed).toMatchObject({ events: events.length });
    const h = await getJson<Health>(`${base}/health`);
    expect(h.body).toMatchObject({ ok: true, payments: 50, events: events.length, replayed: true });
    expect(typeof h.body.replayMs).toBe('number');
  });
});

describe('ledger proxy', () => {
  it('maps /api/ledger/* to the ledger service, passing status, query and body through', async () => {
    const seen: string[] = [];
    const { url } = await listen((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/ledger/trial-balance') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ balanced: true, journals: 3, entries: 12, byCurrency: [], asOf: 'x' }));
      } else if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"journals":3}');
      } else if (req.url?.startsWith('/ledger/journals')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"no such account"}');
      }
    });
    const { base } = await setup({ ledgerUrl: url });
    expect((await getJson<{ balanced: boolean }>(`${base}/api/ledger/trial-balance`)).body.balanced).toBe(true);
    expect((await getJson<{ ok: boolean }>(`${base}/api/ledger/health`)).body.ok).toBe(true);
    expect((await getJson<unknown[]>(`${base}/api/ledger/journals?paymentId=p%201`)).body).toEqual([]);
    const miss = await fetch(`${base}/api/ledger/accounts/${encodeURIComponent('customer:ACC-1')}`);
    expect(miss.status).toBe(404);
    expect(seen).toEqual([
      'GET /ledger/trial-balance',
      'GET /health',
      'GET /ledger/journals?paymentId=p%201',
      'GET /ledger/accounts/customer%3AACC-1',
    ]);
  });

  it('returns 502 JSON when the ledger is down', async () => {
    const { url, server } = await listen(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    const { base } = await setup({ ledgerUrl: url });
    const res = await fetch(`${base}/api/ledger/trial-balance`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'ledger unavailable' });
  });
});

describe('websocket coalescing', () => {
  async function connect(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    const messages: ServerMessage[] = [];
    const sizes: number[] = [];
    ws.on('message', (data) => {
      const text = String(data);
      sizes.push(text.length);
      const parsed = JSON.parse(text) as ServerMessage | ServerMessage[];
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return { messages, sizes };
  }

  it('coalesces bursts per payment and caps frame size, delivering every payment', async () => {
    const { bus, gw } = await setup({ maxPaymentsPerFrame: 40, maxEventsPerFrame: 100, flushIntervalMs: 20 });
    const { messages, sizes } = await connect(gw.port);
    const burst = m2Log(300, { startMs: Date.now(), spacingMs: 1 });
    await Promise.all(burst.map((e) => bus.publish(e)));
    await bus.drain();
    const updates = () => messages.filter((m): m is UpdateMessage => m.kind === 'update');
    const deadline = Date.now() + 5000;
    while (updates().reduce((a, m) => a + m.eventCount, 0) < burst.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300)); // leftover payment frames
    const ups = updates();
    expect(ups.reduce((a, m) => a + m.eventCount, 0)).toBe(burst.length);
    expect(ups.reduce((a, m) => a + m.events.length + m.droppedEvents, 0)).toBe(burst.length);
    expect(ups.every((m) => m.payments.length <= 40 && m.events.length <= 100)).toBe(true);
    // far fewer summaries than events: coalesced per payment
    const seen = new Map<string, PaymentSummary>();
    for (const m of ups) for (const p of m.payments) seen.set(p.paymentId, p);
    expect(seen.size).toBe(300);
    expect(ups.reduce((a, m) => a + m.payments.length, 0)).toBeLessThan(burst.length / 2);
    // final state of every payment matches the projection
    for (const [id, p] of seen) expect(p.status).toBe(gw.projection.summary(id)!.status);
    const counted = ups.reduce((a, m) => a + (m.counts['payment.initiated'] ?? 0), 0);
    expect(counted).toBe(300);
    expect(Math.max(...sizes)).toBeLessThan(200_000);
  });

  it('pushes periodic stats', async () => {
    const { gw } = await setup({ statsIntervalMs: 30 });
    const { messages } = await connect(gw.port);
    const deadline = Date.now() + 2000;
    while (!messages.some((m) => m.kind === 'stats') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(messages[0]!.kind).toBe('snapshot');
    expect(messages.some((m) => m.kind === 'stats')).toBe(true);
  });
});
