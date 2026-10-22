import { afterEach, describe, expect, it } from 'vitest';
import { CORRIDORS, type AnyEvent } from '@ct/contracts';
import { InMemoryBus } from '@ct/event-bus';
import { startPaymentApi, type PaymentApiHandle } from './server';

const validBody = () => ({
  amount: { amountMinor: 125_000, currency: 'USD' },
  targetCurrency: 'INR',
  corridor: 'US-IN',
  debtor: { name: 'Northwind Marketplace', country: 'US', accountId: 'ACC-US-0001' },
  creditor: { name: 'Asha Textiles', country: 'IN', accountId: 'ACC-IN-0001' },
});

let api: PaymentApiHandle | undefined;
let bus: InMemoryBus;

async function start(existing?: InMemoryBus) {
  bus = existing ?? new InMemoryBus();
  api = await startPaymentApi({ bus, host: '127.0.0.1', port: 0, catchUpQuietMs: 10 });
  return `http://127.0.0.1:${api.port}`;
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const initiated = () => bus.events.filter((e) => e.type === 'payment.initiated') as Extract<AnyEvent, { type: 'payment.initiated' }>[];

afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe('payment api', () => {
  it('serves /health', async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('accepts a payment and publishes payment.initiated with a trace', async () => {
    const base = await start();
    const r = await post(base, '/payments', validBody());
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ paymentId: expect.any(String), status: 'initiated' });
    const [e] = initiated();
    expect(initiated()).toHaveLength(1);
    expect(e).toMatchObject({
      paymentId: r.body.paymentId,
      correlationId: r.body.paymentId,
      causationId: null,
      producer: 'payment-api',
      schemaVersion: 1,
      payload: { ...validBody(), idempotencyKey: expect.any(String) },
      trace: { stage: 'payment-api', decision: 'accepted', reasonCodes: ['VALIDATED'], ruleVersion: 'stub-v1' },
    });
  });

  it('honours Idempotency-Key header and body idempotencyKey', async () => {
    const base = await start();
    const a = await post(base, '/payments', validBody(), { 'Idempotency-Key': 'k-1' });
    const b = await post(base, '/payments', validBody(), { 'Idempotency-Key': 'k-1' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.paymentId).toBe(a.body.paymentId);

    const c = await post(base, '/payments', { ...validBody(), idempotencyKey: 'k-2' });
    const d = await post(base, '/payments', { ...validBody(), idempotencyKey: 'k-2' });
    expect([c.status, d.status]).toEqual([202, 200]);
    expect(d.body.paymentId).toBe(c.body.paymentId);
    expect(initiated().map((e) => e.payload.idempotencyKey)).toEqual(['k-1', 'k-2']);
  });

  it('handles concurrent duplicate requests with one event', async () => {
    const base = await start();
    const results = await Promise.all(Array.from({ length: 10 }, () => post(base, '/payments', validBody(), { 'Idempotency-Key': 'same' })));
    expect(new Set(results.map((r) => r.body.paymentId)).size).toBe(1);
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(initiated()).toHaveLength(1);
  });

  it('rebuilds the idempotency index from the bus on restart', async () => {
    const base = await start();
    const a = await post(base, '/payments', validBody(), { 'Idempotency-Key': 'restart-key' });
    await api!.close();
    const base2 = await start(bus);
    const b = await post(base2, '/payments', validBody(), { 'Idempotency-Key': 'restart-key' });
    expect(b.status).toBe(200);
    expect(b.body.paymentId).toBe(a.body.paymentId);
    expect(initiated()).toHaveLength(1);
  });

  it('generates distinct payments without a key', async () => {
    const base = await start();
    const a = await post(base, '/payments', validBody());
    const b = await post(base, '/payments', validBody());
    expect(a.body.paymentId).not.toBe(b.body.paymentId);
    expect(initiated()).toHaveLength(2);
  });

  it.each([
    ['unknown corridor', { corridor: 'XX-YY' }],
    ['negative amount', { amount: { amountMinor: -5, currency: 'USD' } }],
    ['zero amount', { amount: { amountMinor: 0, currency: 'USD' } }],
    ['fractional amount', { amount: { amountMinor: 10.5, currency: 'USD' } }],
    ['amount over 1M', { amount: { amountMinor: 1_000_000_01, currency: 'USD' } }],
    ['amount as string', { amount: { amountMinor: '100', currency: 'USD' } }],
    ['currency not matching corridor', { amount: { amountMinor: 100, currency: 'EUR' } }],
    ['target currency not matching corridor', { targetCurrency: 'BRL' }],
    ['missing debtor', { debtor: undefined }],
    ['bad creditor country', { creditor: { name: 'X', country: 'india', accountId: 'A1' } }],
    ['empty creditor name', { creditor: { name: ' ', country: 'IN', accountId: 'A1' } }],
    ['bad scenario', { scenario: 'DROP TABLE' }],
  ])('rejects %s with 400', async (_label, override) => {
    const base = await start();
    const r = await post(base, '/payments', { ...validBody(), ...override });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_failed');
    expect(Array.isArray(r.body.details) && r.body.details.length).toBeTruthy();
    expect(bus.events).toHaveLength(0);
  });

  it('rejects malformed JSON, non-object bodies and oversized bodies', async () => {
    const base = await start();
    expect((await post(base, '/payments', '{not json')).status).toBe(400);
    expect((await post(base, '/payments', '[1,2]')).status).toBe(400);
    expect((await post(base, '/payments', '')).status).toBe(400);
    const big = await post(base, '/payments', { ...validBody(), pad: 'x'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
    expect(bus.events).toHaveLength(0);
  });

  it('returns JSON 404 and 405', async () => {
    const base = await start();
    const r404 = await fetch(`${base}/nope`);
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not_found' });
    const r405 = await fetch(`${base}/payments`);
    expect(r405.status).toBe(405);
  });

  it('allows CORS only from localhost origins', async () => {
    const base = await start();
    const ok = await fetch(`${base}/payments`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const ok2 = await fetch(`${base}/health`, { headers: { origin: 'http://127.0.0.1:7072' } });
    expect(ok2.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:7072');
    const no = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('creates valid sample payments rotating through corridors', async () => {
    const base = await start();
    const ids = [];
    for (let i = 0; i < CORRIDORS.length; i++) {
      const r = await post(base, '/payments/sample', i === 0 ? '' : {});
      expect(r.status).toBe(202);
      ids.push(r.body.paymentId);
    }
    expect(new Set(ids).size).toBe(CORRIDORS.length);
    expect(new Set(initiated().map((e) => e.payload.corridor))).toEqual(new Set(CORRIDORS.map((c) => c.id)));
    for (const e of initiated()) {
      expect(e.payload.amount.amountMinor).toBeGreaterThan(0);
      expect(Number.isSafeInteger(e.payload.amount.amountMinor)).toBe(true);
    }
    const held = await post(base, '/payments/sample', { scenario: 'force-hold' });
    expect(held.status).toBe(202);
    expect(initiated().at(-1)?.payload.scenario).toBe('force-hold');
    expect((await post(base, '/payments/sample', { scenario: 'Bad Scenario!' })).status).toBe(400);
  });
});
