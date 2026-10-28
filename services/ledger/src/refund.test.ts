// M4 refunds: reversal journal (kind 'refund'), idempotent per payment, only after a settlement journal.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { isBalanced } from '@ct/contracts';
import { CORRIDOR_CASES, settledPayment } from './fixtures';
import { refundEntries } from './posting';
import { createInMemoryLedger, type LedgerStore } from './store';

// One PGlite store for the valid flows (PGlite start-up is CPU heavy); the corrupting test opens its own.
let shared: LedgerStore | undefined;
let store: LedgerStore | undefined;
const open = async () => (store = shared ??= await createInMemoryLedger());
afterEach(async () => {
  if (store && store !== shared) await store.close();
  store = undefined;
});
afterAll(async () => {
  await shared?.close();
});

describe('refund journals', () => {
  it.each(CORRIDOR_CASES.map((c) => [c.corridor, c] as const))('%s: posts the exact reversal of the settlement journal', async (_label, c) => {
    store = await open();
    const fx = settledPayment(c);
    const settlement = await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    const refund = await store.postRefund({ paymentId: fx.state.paymentId, causationEventId: `refund-req-${fx.state.paymentId}` });
    expect(refund.created).toBe(true);
    expect(isBalanced(refund.entries)).toBe(true);
    expect(refund.entries).toEqual(refundEntries(settlement.entries));
    expect(refund.entries.map((e) => e.direction)).toEqual(settlement.entries.map((e) => (e.direction === 'debit' ? 'credit' : 'debit')));
    // net effect on every account is zero (fee refunded too)
    for (const a of await store.accounts()) expect(a.balance).toBe(0);
    expect((await store.trialBalance()).balanced).toBe(true);
    expect((await store.invariants())).toEqual({ ok: true, violations: [] });
    const kinds = (await store.journals({ paymentId: fx.state.paymentId })).map((j) => j.kind);
    expect(kinds).toEqual(['settlement', 'refund']);
  });

  it('is idempotent per payment (same causation or a second request)', async () => {
    store = await open();
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    const first = await store.postRefund({ paymentId: fx.state.paymentId, causationEventId: 'r-1' });
    expect(await store.postRefund({ paymentId: fx.state.paymentId, causationEventId: 'r-1' })).toEqual({ ...first, created: false });
    expect(await store.postRefund({ paymentId: fx.state.paymentId, causationEventId: 'r-2' })).toEqual({ ...first, created: false });
    expect(await store.journals({ paymentId: fx.state.paymentId })).toHaveLength(2);
    expect((await store.invariants()).ok).toBe(true);
  });

  it('refuses a refund without a settlement journal, in code and in the database', async () => {
    store = await open();
    await expect(store.postRefund({ paymentId: 'never-settled', causationEventId: 'r-x' })).rejects.toThrow(/no settlement journal/);
    const fx = settledPayment(CORRIDOR_CASES[1]!);
    const entries = refundEntries([
      { account: 'customer:ACC-DE-0001:EUR', direction: 'debit', amount: { amountMinor: 100, currency: 'EUR' } },
      { account: 'fx-position:EUR', direction: 'credit', amount: { amountMinor: 100, currency: 'EUR' } },
    ]);
    await expect(store.postJournal({ paymentId: fx.state.paymentId, kind: 'refund', causationEventId: 'raw', entries })).rejects.toThrow(/no settlement journal/);
    expect(await store.journals({ paymentId: fx.state.paymentId })).toEqual([]);
  });

  it('invariants flag a refund that does not mirror its settlement', async () => {
    store = await createInMemoryLedger();
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    await store.postJournal({
      paymentId: fx.state.paymentId, kind: 'refund', causationEventId: 'partial',
      entries: [
        { account: 'fx-position:USD', direction: 'debit', amount: { amountMinor: 1_000, currency: 'USD' } },
        { account: 'customer:ACC-US-0001:USD', direction: 'credit', amount: { amountMinor: 1_000, currency: 'USD' } },
      ],
    });
    const report = await store.invariants();
    expect(report.ok).toBe(false);
    expect(report.violations.join('\n')).toMatch(/does not reverse settlement/);
  });
});
