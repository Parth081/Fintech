import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBalanced, type AccountBalance, type JournalView, type TrialBalance } from '@ct/contracts';
import { happyPath } from '@ct/contracts/testing';
import { InMemoryBus } from '@ct/event-bus';
import { CORRIDOR_CASES, settledPayment } from './fixtures';
import { startLedgerService, type LedgerServiceHandle } from './service';
import { createInMemoryLedger, type LedgerStore } from './store';

let store: LedgerStore;
let bus: InMemoryBus;
let service: LedgerServiceHandle;
let base = '';

beforeEach(async () => {
  store = await createInMemoryLedger();
  bus = new InMemoryBus();
  service = await startLedgerService({ store, bus, port: 0, catchUpQuietMs: 10 });
  base = `http://127.0.0.1:${service.port}`;
});

afterEach(async () => {
  await service.close();
  await bus.close();
  await store.close();
});

async function get<T>(path: string, status = 200): Promise<T> {
  const res = await fetch(`${base}${path}`);
  expect(res.status, path).toBe(status);
  return (await res.json()) as T;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ledger service', () => {
  it('serves every route of the ledger API', async () => {
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    const posted = await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });

    expect(await get('/health')).toMatchObject({ ok: true, journals: 1 });
    const tb = await get<TrialBalance>('/ledger/trial-balance');
    expect(tb).toMatchObject({ journals: 1, entries: 5, balanced: true });
    expect(tb.byCurrency).toEqual([
      { currency: 'INR', debits: 10_375_000, credits: 10_375_000, balanced: true },
      { currency: 'USD', debits: 125_188, credits: 125_188, balanced: true },
    ]);
    const accounts = await get<AccountBalance[]>('/ledger/accounts');
    expect(accounts).toContainEqual({ accountId: 'customer:ACC-US-0001:USD', type: 'asset', currency: 'USD', debits: 125_188, credits: 0, balance: 125_188, entryCount: 1 });
    const acct = await get<AccountBalance & { recent: JournalView[] }>(`/ledger/accounts/${encodeURIComponent('provider:orion:payable:INR')}`);
    expect(acct).toMatchObject({ type: 'liability', credits: 10_375_000, balance: -10_375_000 });
    expect(acct.recent.map((j) => j.journalId)).toEqual([posted.journalId]);
    await get(`/ledger/accounts/${encodeURIComponent('customer:nobody:USD')}`, 404);
    const journals = await get<JournalView[]>(`/ledger/journals?paymentId=${encodeURIComponent(fx.state.paymentId)}`);
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ journalId: posted.journalId, kind: 'settlement', causationEventId: fx.settledEventId });
    expect(await get<JournalView[]>('/ledger/journals?paymentId=nope')).toEqual([]);
    expect(await get<JournalView[]>('/ledger/journals')).toHaveLength(1);
    expect(await get('/ledger/invariants')).toEqual({ ok: true, violations: [] });
    await get('/nope', 404);
    expect((await fetch(`${base}/ledger/accounts`, { method: 'POST' })).status).toBe(405);
  });

  it('runs the ledger stage: payment.settled on the bus -> journal + ledger.posted, once', async () => {
    const events = happyPath().slice(0, 7); // initiated .. settled
    for (const e of events) await bus.publish(e);
    const posted = await waitFor(() => bus.events.find((e) => e.type === 'ledger.posted'));
    if (posted.type !== 'ledger.posted') throw new Error('unexpected');
    expect(posted.causationId).toBe(events[6]!.eventId);
    expect(posted.trace).toMatchObject({ stage: 'ledger', decision: 'posted', ruleVersion: 'ledger-v1' });
    expect(isBalanced(posted.payload.entries)).toBe(true);
    // happyPath: USD 1,250.00 + 1.50 fee -> INR 104,062.50 via orion
    expect(posted.payload.entries).toEqual([
      { account: 'customer:ACC-US-0001:USD', direction: 'debit', amount: { amountMinor: 125_150, currency: 'USD' } },
      { account: 'fx-position:USD', direction: 'credit', amount: { amountMinor: 125_000, currency: 'USD' } },
      { account: 'fee-revenue:USD', direction: 'credit', amount: { amountMinor: 150, currency: 'USD' } },
      { account: 'fx-position:INR', direction: 'debit', amount: { amountMinor: 10_406_250, currency: 'INR' } },
      { account: 'provider:orion:payable:INR', direction: 'credit', amount: { amountMinor: 10_406_250, currency: 'INR' } },
    ]);
    const [journal] = await store.journals({ paymentId: events[0]!.paymentId });
    expect(journal?.journalId).toBe(posted.payload.journalId);

    // A restarted ledger stage (redelivery from the start of the log) does nothing new.
    await service.close();
    service = await startLedgerService({ store, bus, port: 0, catchUpQuietMs: 10 });
    await new Promise((r) => setTimeout(r, 100));
    expect(bus.events.filter((e) => e.type === 'ledger.posted')).toHaveLength(1);
    expect(await store.journalCount()).toBe(1);
  });
});
