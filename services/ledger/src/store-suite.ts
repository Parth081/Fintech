// Driver-independent ledger behaviour, run against PGlite (always) and Postgres (when docker is available).
import { expect, it as itBase } from 'vitest';
import { isBalanced, type LedgerEntry } from '@ct/contracts';
import { CORRIDOR_CASES, settledPayment } from './fixtures';
import type { LedgerStore } from './store';

const d = (account: string, amountMinor: number, currency: string): LedgerEntry => ({ account, direction: 'debit', amount: { amountMinor, currency } });
const c = (account: string, amountMinor: number, currency: string): LedgerEntry => ({ account, direction: 'credit', amount: { amountMinor, currency } });

/** Hand-checked settlement journals for the three corridor fixtures. */
export const EXPECTED_SETTLEMENT: Record<string, LedgerEntry[]> = {
  'US-IN': [
    d('customer:ACC-US-0001:USD', 125_188, 'USD'), // 1,250.00 + 1.88 fee
    c('fx-position:USD', 125_000, 'USD'),
    c('fee-revenue:USD', 188, 'USD'),
    d('fx-position:INR', 10_375_000, 'INR'),
    c('provider:orion:payable:INR', 10_375_000, 'INR'),
  ],
  'DE-BR': [
    d('customer:ACC-DE-0001:EUR', 50_100, 'EUR'),
    c('fx-position:EUR', 50_000, 'EUR'),
    c('fee-revenue:EUR', 100, 'EUR'),
    d('fx-position:BRL', 294_000, 'BRL'),
    c('provider:vega:payable:BRL', 294_000, 'BRL'),
  ],
  'GB-PH': [
    d('customer:ACC-GB-0001:GBP', 20_100, 'GBP'),
    c('fx-position:GBP', 20_000, 'GBP'),
    c('fee-revenue:GBP', 100, 'GBP'),
    d('fx-position:PHP', 1_442_000, 'PHP'),
    c('provider:lyra:payable:PHP', 1_442_000, 'PHP'),
  ],
};

export function storeSuite(getStore: () => LedgerStore, shouldSkip: () => boolean = () => false): void {
  const it = (name: string, fn: () => Promise<void>) => itBase(name, async ({ skip }) => {
    if (shouldSkip()) skip();
    await fn();
  });
  for (const tc of CORRIDOR_CASES) {
    it(`posts a balanced settlement journal for ${tc.corridor}`, async () => {
      const store = getStore();
      const fx = settledPayment(tc);
      const res = await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
      expect(res.created).toBe(true);
      expect(res.entries).toEqual(EXPECTED_SETTLEMENT[tc.corridor]);
      expect(isBalanced(res.entries)).toBe(true);
      const [view] = await store.journals({ paymentId: fx.state.paymentId });
      expect(view).toMatchObject({ journalId: res.journalId, kind: 'settlement', causationEventId: fx.settledEventId, paymentId: fx.state.paymentId });
      expect(view!.entries.map((e) => ({ account: e.accountId, direction: e.direction, amount: e.amount }))).toEqual(res.entries);
    });
  }

  it('returns the existing journal for a repeated causation id', async () => {
    const store = getStore();
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    const input = { paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state };
    const a = await store.postSettlement(input);
    const b = await store.postSettlement(input);
    expect(b).toEqual({ ...a, created: false });
    expect(await store.journals({ paymentId: fx.state.paymentId })).toHaveLength(1);
  });

  it('50 concurrent duplicate postings create exactly one journal', async () => {
    const store = getStore();
    const fx = settledPayment(CORRIDOR_CASES[1]!);
    const before = await store.journalCount();
    const input = { paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state };
    const results = await Promise.all(Array.from({ length: 50 }, () => store.postSettlement(input)));
    expect(new Set(results.map((r) => r.journalId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await store.journalCount()).toBe(before + 1);
  });

  it('never posts a second settlement for the same payment, even under a different causation id', async () => {
    const store = getStore();
    const fx = settledPayment(CORRIDOR_CASES[2]!);
    const first = await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: `other-${i}-${fx.settledEventId}`, state: fx.state })),
    );
    for (const r of results) expect(r).toEqual({ ...first, created: false });
    expect(await store.journals({ paymentId: fx.state.paymentId })).toHaveLength(1);
  });

  it('database rejects an unbalanced journal even when code checks are bypassed (raw SQL)', async () => {
    const store = getStore();
    const before = await store.journalCount();
    await store.driver.query(`INSERT INTO accounts (account_id, type, currency) VALUES ('suspense:test:USD', 'liability', 'USD'), ('suspense:test:EUR', 'liability', 'EUR') ON CONFLICT DO NOTHING`);
    await expect(
      store.driver.transaction(async (q) => {
        await q.query(`INSERT INTO journals (journal_id, payment_id, kind, causation_event_id) VALUES ('JRN-RAW-1', 'p-raw', 'manual', 'c-raw-1')`);
        await q.query(`INSERT INTO entries VALUES ('JRN-RAW-1', 1, 'suspense:test:USD', 'debit', 100, 'USD')`);
        await q.query(`INSERT INTO entries VALUES ('JRN-RAW-1', 2, 'suspense:test:USD', 'credit', 90, 'USD')`);
      }),
    ).rejects.toThrow(/unbalanced/);
    // single autocommit statement
    await expect(
      store.driver.query(`WITH j AS (INSERT INTO journals (journal_id, payment_id, kind, causation_event_id) VALUES ('JRN-RAW-2', 'p-raw', 'manual', 'c-raw-2') RETURNING journal_id)
        INSERT INTO entries SELECT journal_id, 1, 'suspense:test:USD', 'debit', 100, 'USD' FROM j`),
    ).rejects.toThrow(/at least 2/);
    // balanced per amount but mixing currencies does not balance either
    await expect(
      store.driver.transaction(async (q) => {
        await q.query(`INSERT INTO journals (journal_id, payment_id, kind, causation_event_id) VALUES ('JRN-RAW-3', 'p-raw', 'manual', 'c-raw-3')`);
        await q.query(`INSERT INTO entries VALUES ('JRN-RAW-3', 1, 'suspense:test:USD', 'debit', 100, 'USD'), ('JRN-RAW-3', 2, 'suspense:test:EUR', 'credit', 100, 'EUR')`);
      }),
    ).rejects.toThrow(/unbalanced/);
    // entry currency must equal the account currency
    await expect(
      store.driver.transaction(async (q) => {
        await q.query(`INSERT INTO journals (journal_id, payment_id, kind, causation_event_id) VALUES ('JRN-RAW-4', 'p-raw', 'manual', 'c-raw-4')`);
        await q.query(`INSERT INTO entries VALUES ('JRN-RAW-4', 1, 'suspense:test:USD', 'debit', 100, 'EUR'), ('JRN-RAW-4', 2, 'suspense:test:EUR', 'credit', 100, 'EUR')`);
      }),
    ).rejects.toThrow(/foreign key/i);
    // non-positive amounts
    await expect(
      store.driver.transaction(async (q) => {
        await q.query(`INSERT INTO journals (journal_id, payment_id, kind, causation_event_id) VALUES ('JRN-RAW-5', 'p-raw', 'manual', 'c-raw-5')`);
        await q.query(`INSERT INTO entries VALUES ('JRN-RAW-5', 1, 'suspense:test:USD', 'debit', 0, 'USD'), ('JRN-RAW-5', 2, 'suspense:test:USD', 'credit', 0, 'USD')`);
      }),
    ).rejects.toThrow(/check constraint/i);
    expect(await store.journalCount()).toBe(before);
    expect((await store.invariants()).ok).toBe(true);
  });

  it('database rejects adding entries to an already-committed journal', async () => {
    const store = getStore();
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    const { journalId } = await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    await expect(
      store.driver.query(
        `INSERT INTO entries VALUES ($1, 90, 'fx-position:USD', 'debit', 5, 'USD'), ($1, 91, 'fee-revenue:USD', 'credit', 5, 'USD')`,
        [journalId],
      ),
    ).rejects.toThrow(/transaction that created/);
  });

  it('journals, entries and accounts are immutable (UPDATE/DELETE/TRUNCATE rejected)', async () => {
    const store = getStore();
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    for (const sql of [
      'UPDATE entries SET amount_minor = amount_minor + 1',
      'DELETE FROM entries',
      `UPDATE journals SET kind = 'x'`,
      'DELETE FROM journals',
      `UPDATE accounts SET currency = 'EUR'`,
      'DELETE FROM accounts',
      'TRUNCATE entries',
      'TRUNCATE journals CASCADE',
    ]) {
      await expect(store.driver.query(sql), sql).rejects.toThrow(/append-only/);
    }
    expect((await store.invariants()).ok).toBe(true);
  });

  it('rejects unbalanced or malformed journals in code before touching the database', async () => {
    const store = getStore();
    const base = { paymentId: 'p-code', kind: 'manual', causationEventId: 'c-code' };
    await expect(store.postJournal({ ...base, entries: [d('suspense:x:USD', 100, 'USD'), c('suspense:y:USD', 99, 'USD')] })).rejects.toThrow(/not balanced/);
    await expect(store.postJournal({ ...base, entries: [d('suspense:x:USD', 1.5, 'USD'), c('suspense:y:USD', 1.5, 'USD')] })).rejects.toThrow(/not balanced/);
    await expect(store.postJournal({ ...base, entries: [d('cash:x:USD', 100, 'USD'), c('suspense:y:USD', 100, 'USD')] })).rejects.toThrow(/chart of accounts/);
    await expect(store.postJournal({ ...base, entries: [d('suspense:x:USD', 100, 'EUR'), c('suspense:y:EUR', 100, 'EUR')] })).rejects.toThrow(/does not match/);
  });

  it('trial balance and invariants hold across currencies', async () => {
    const store = getStore();
    for (const tc of CORRIDOR_CASES) {
      const fx = settledPayment(tc);
      await store.postSettlement({ paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state });
    }
    const tb = await store.trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.journals).toBe(await store.journalCount());
    expect(tb.byCurrency.map((r) => r.currency)).toEqual(expect.arrayContaining(['USD', 'INR', 'EUR', 'BRL', 'GBP', 'PHP']));
    for (const r of tb.byCurrency) expect(r.debits).toBe(r.credits);
    const accounts = await store.accounts();
    const sum = new Map<string, number>();
    for (const a of accounts) {
      expect(a.balance).toBe(a.debits - a.credits);
      sum.set(a.currency, (sum.get(a.currency) ?? 0) + a.balance);
    }
    for (const v of sum.values()) expect(v).toBe(0);
    expect(accounts.find((a) => a.accountId === 'provider:orion:payable:INR')).toMatchObject({ type: 'liability', currency: 'INR' });
    expect(accounts.find((a) => a.accountId === 'fee-revenue:USD')).toMatchObject({ type: 'revenue' });
    const acct = await store.account('fee-revenue:GBP');
    expect(acct?.recent.length).toBeGreaterThan(0);
    expect(await store.account('customer:nobody:USD')).toBeUndefined();
    expect(await store.invariants()).toEqual({ ok: true, violations: [] });
  });
}
