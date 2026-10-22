import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isBalanced } from '@ct/contracts';
import { STAGE_STEPS } from '@ct/stages';
import { classifyAccount } from './chart';
import { CORRIDOR_CASES, settledPayment } from './fixtures';
import { splitSql, MIGRATIONS } from './migrations';
import { journalIdFor, settlementEntries } from './posting';
import { createInMemoryLedger, openLedgerStore, toSafeInt, type LedgerStore } from './store';
import { storeSuite } from './store-suite';

describe('ledger store (PGlite in-memory)', () => {
  let store: LedgerStore;
  beforeAll(async () => {
    store = await createInMemoryLedger();
  });
  afterAll(async () => {
    await store?.close();
  });
  storeSuite(() => store);
});

describe('posting rules', () => {
  it('omits the fee line when the fee is zero and stays balanced', () => {
    const fx = settledPayment({ ...CORRIDOR_CASES[0]!, fee: { amountMinor: 0, currency: 'USD' } });
    const entries = settlementEntries(fx.state);
    expect(entries.map((e) => e.account)).toEqual(['customer:ACC-US-0001:USD', 'fx-position:USD', 'fx-position:INR', 'provider:orion:payable:INR']);
    expect(isBalanced(entries)).toBe(true);
  });

  it('refuses a fee in a currency other than the source', () => {
    const fx = settledPayment({ ...CORRIDOR_CASES[0]!, fee: { amountMinor: 10, currency: 'INR' } });
    expect(() => settlementEntries(fx.state)).toThrow(/fee currency/);
  });

  it('refuses non-integer amounts', () => {
    const fx = settledPayment({ ...CORRIDOR_CASES[0]!, source: { amountMinor: 100.5, currency: 'USD' } });
    expect(() => settlementEntries(fx.state)).toThrow(/safe integer/);
  });

  it('journal ids are deterministic per causation event', () => {
    expect(journalIdFor('e-1')).toBe(journalIdFor('e-1'));
    expect(journalIdFor('e-1')).not.toBe(journalIdFor('e-2'));
    expect(journalIdFor('e-1')).toMatch(/^JRN-[0-9A-F]{20}$/);
  });

  it('chart of accounts derives type and currency from the id', () => {
    expect(classifyAccount('customer:ACC-US-0001:USD')).toEqual({ accountId: 'customer:ACC-US-0001:USD', type: 'asset', currency: 'USD' });
    expect(classifyAccount('customer:weird:id:EUR').currency).toBe('EUR');
    expect(classifyAccount('fx-position:INR').type).toBe('asset');
    expect(classifyAccount('provider:orion:payable:INR').type).toBe('liability');
    expect(classifyAccount('fee-revenue:USD').type).toBe('revenue');
    expect(classifyAccount('suspense:break:USD').type).toBe('liability');
    expect(() => classifyAccount('provider:orion:payable')).toThrow();
    expect(() => classifyAccount('customer:USD')).toThrow();
    expect(() => classifyAccount('bank:x:USD')).toThrow(/chart of accounts/);
  });

  it('toSafeInt refuses values beyond 2^53', () => {
    expect(toSafeInt('9007199254740991')).toBe(9007199254740991);
    expect(() => toSafeInt('9007199254740993')).toThrow();
    expect(toSafeInt(12n)).toBe(12);
  });

  it('splitSql keeps function bodies intact', () => {
    const stmts = splitSql(MIGRATIONS[0]!.sql);
    expect(stmts.some((s) => s.startsWith('CREATE FUNCTION ledger_check_journal') && s.includes('RETURN NULL;'))).toBe(true);
  });
});

describe('ledger step', () => {
  let store: LedgerStore;
  beforeEach(async () => {
    store = await createInMemoryLedger();
  });
  afterEach(async () => {
    await store.close();
  });

  const step = STAGE_STEPS.ledger[0]!;
  const ctx = (services: object) => ({ now: new Date().toISOString(), services, view: { states: new Map() } });

  it('posts through the store and is idempotent on redelivery', async () => {
    const fx = settledPayment(CORRIDOR_CASES[2]!);
    const trigger = fx.events[fx.events.length - 1]!;
    const a = await step.produce(trigger, fx.state, ctx({ ledger: store }));
    const b = await step.produce(trigger, fx.state, ctx({ ledger: store }));
    expect(a).toMatchObject({ type: 'ledger.posted', decision: 'posted', reasonCodes: ['JOURNAL_BALANCED', 'IDEMPOTENT_ON_CAUSATION'], ruleVersion: 'ledger-v1' });
    expect(b).toEqual(a);
    expect(await store.journalCount()).toBe(1);
    if (a?.type !== 'ledger.posted') throw new Error('unexpected');
    expect(isBalanced(a.payload.entries)).toBe(true);
  });

  it('throws a clear error when no ledger is injected', async () => {
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    await expect(Promise.resolve(step.produce(fx.events[fx.events.length - 1]!, fx.state, ctx({})))).rejects.toThrow(/services\.ledger/);
  });
});

describe('persistence (PGlite directory)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-ledger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps journals across reopen and does not re-run migrations', async () => {
    const fx = settledPayment(CORRIDOR_CASES[0]!);
    const input = { paymentId: fx.state.paymentId, causationEventId: fx.settledEventId, state: fx.state };
    let store = await openLedgerStore({ dataDir: dir });
    const first = await store.postSettlement(input);
    await store.close();

    store = await openLedgerStore({ dataDir: dir });
    try {
      expect(await store.journalCount()).toBe(1);
      expect(await store.postSettlement(input)).toEqual({ ...first, created: false });
      expect(await store.journalCount()).toBe(1);
      expect(await store.driver.query('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }]);
      expect((await store.invariants()).ok).toBe(true);
      await expect(store.driver.query('DELETE FROM entries')).rejects.toThrow(/append-only/);
    } finally {
      await store.close();
    }
  });
});
