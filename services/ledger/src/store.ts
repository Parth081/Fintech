// LedgerStore: the system's source of truth for money. Posting is idempotent on causation event id,
// every journal is posted in one transaction and the database re-checks balance at commit.
import type { AccountBalance, AccountType, JournalView, LedgerEntry, PaymentState, TrialBalance } from '@ct/contracts';
import { classifyAccount, type AccountSpec } from './chart';
import { openDriver, type DriverOptions, type Queryable, type SqlDriver } from './driver';
import { migrate } from './migrations';
import { assertPostable, journalIdFor, refundEntries, settlementEntries } from './posting';

export interface PostJournalInput {
  paymentId: string;
  kind: string;
  causationEventId: string;
  entries: LedgerEntry[];
  /** Defaults to a deterministic id derived from causationEventId. */
  journalId?: string;
}

export interface PostResult {
  journalId: string;
  entries: LedgerEntry[];
  /** false when the journal already existed (idempotent replay). */
  created: boolean;
}

export interface SettlementInput {
  paymentId: string;
  causationEventId: string;
  state: PaymentState;
}

export interface RefundInput {
  paymentId: string;
  /** eventId of the payment.refund_requested that causes the reversal. */
  causationEventId: string;
  state?: PaymentState;
}

export interface InvariantReport {
  ok: boolean;
  violations: string[];
}

export interface LedgerStore {
  readonly driver: SqlDriver;
  readonly kind: SqlDriver['kind'];
  postJournal(input: PostJournalInput): Promise<PostResult>;
  /** StageServices.ledger: post the settlement journal for a settled payment (idempotent). */
  postSettlement(input: SettlementInput): Promise<PostResult>;
  /**
   * StageServices.ledger (M4): post the refund journal, the reversal of the payment's settlement journal
   * (kind 'refund'). Idempotent per payment: a second request returns the existing refund journal.
   * Throws when the payment has no settlement journal.
   */
  postRefund(input: RefundInput): Promise<PostResult>;
  trialBalance(): Promise<TrialBalance>;
  accounts(): Promise<AccountBalance[]>;
  account(accountId: string, recentLimit?: number): Promise<(AccountBalance & { recent: JournalView[] }) | undefined>;
  journals(filter?: { paymentId?: string; limit?: number }): Promise<JournalView[]>;
  journalCount(): Promise<number>;
  invariants(): Promise<InvariantReport>;
  close(): Promise<void>;
}

/** Convert a BIGINT/NUMERIC value (text, bigint or number) to a JS number, refusing anything unsafe. */
export function toSafeInt(value: unknown, what = 'value'): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new Error(`ledger: ${what} ${String(value)} is not a safe integer`);
  if (typeof value === 'string' && String(n) !== value.replace(/^\+/, '')) throw new Error(`ledger: ${what} ${value} lost precision`);
  return n;
}

const ISO = `to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function openLedgerStore(options: DriverOptions = {}): Promise<LedgerStore> {
  const driver = await openDriver(options);
  try {
    await migrate(driver);
  } catch (err) {
    await driver.close().catch(() => {});
    throw err;
  }
  return createLedgerStore(driver);
}

/** In-memory PGlite ledger for tests (StageServices.ledger + close()). */
export function createInMemoryLedger(): Promise<LedgerStore> {
  return openLedgerStore({ dataDir: 'memory' });
}

function createLedgerStore(driver: SqlDriver): LedgerStore {
  /** Accounts known to exist (accounts are immutable, so this cache can never go stale). */
  const knownAccounts = new Map<string, AccountSpec>();

  async function ensureAccounts(q: Queryable, specs: AccountSpec[]): Promise<AccountSpec[]> {
    const missing = specs.filter((s) => {
      const known = knownAccounts.get(s.accountId);
      if (!known) return true;
      if (known.currency !== s.currency) throw new Error(`ledger: account ${s.accountId} is in ${known.currency}, not ${s.currency}`);
      return false;
    });
    if (missing.length === 0) return [];
    const sorted = [...new Map(missing.map((s) => [s.accountId, s])).values()].sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    await q.query(
      `INSERT INTO accounts (account_id, type, currency)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ORDER BY 1
       ON CONFLICT DO NOTHING`,
      [sorted.map((s) => s.accountId), sorted.map((s) => s.type), sorted.map((s) => s.currency)],
    );
    const rows = await q.query<{ account_id: string; type: AccountType; currency: string }>(
      'SELECT account_id, type, currency FROM accounts WHERE account_id = ANY($1::text[])',
      [sorted.map((s) => s.accountId)],
    );
    const found = new Map(rows.map((r) => [r.account_id, r]));
    for (const s of sorted) {
      const r = found.get(s.accountId);
      if (!r) throw new Error(`ledger: account ${s.accountId} could not be created`);
      if (r.currency !== s.currency) throw new Error(`ledger: account ${s.accountId} is in ${r.currency}, not ${s.currency}`);
      if (r.type !== s.type) throw new Error(`ledger: account ${s.accountId} has type ${r.type}, chart says ${s.type}`);
    }
    return sorted;
  }

  async function loadJournals(q: Queryable, where: string, params: unknown[], limit?: number): Promise<JournalView[]> {
    const rows = await q.query<{ journal_id: string; payment_id: string; kind: string; causation_event_id: string; posted: string }>(
      `SELECT journal_id, payment_id, kind, causation_event_id, ${ISO} AS posted
         FROM journals ${where}
        ORDER BY posted_at DESC, journal_id DESC ${limit ? `LIMIT ${Math.max(1, Math.floor(limit))}` : ''}`,
      params,
    );
    if (rows.length === 0) return [];
    const entries = await q.query<{ journal_id: string; account_id: string; direction: 'debit' | 'credit'; amount: string; currency: string }>(
      `SELECT journal_id, account_id, direction, amount_minor::text AS amount, currency
         FROM entries WHERE journal_id = ANY($1::text[]) ORDER BY journal_id, seq`,
      [rows.map((r) => r.journal_id)],
    );
    const byJournal = new Map<string, JournalView['entries']>();
    for (const e of entries) {
      const list = byJournal.get(e.journal_id) ?? [];
      list.push({ accountId: e.account_id, direction: e.direction, amount: { amountMinor: toSafeInt(e.amount, 'amount'), currency: e.currency } });
      byJournal.set(e.journal_id, list);
    }
    return rows
      .map((r) => ({
        journalId: r.journal_id,
        paymentId: r.payment_id,
        kind: r.kind,
        postedAt: r.posted,
        causationEventId: r.causation_event_id,
        entries: byJournal.get(r.journal_id) ?? [],
      }))
      .reverse(); // oldest first
  }

  const toLedgerEntries = (j: JournalView): LedgerEntry[] =>
    j.entries.map((e) => ({ account: e.accountId, direction: e.direction, amount: e.amount }));

  async function postJournal(input: PostJournalInput): Promise<PostResult> {
    const { paymentId, kind, causationEventId, entries } = input;
    if (!paymentId || !kind || !causationEventId) throw new Error('ledger: paymentId, kind and causationEventId are required');
    assertPostable(entries);
    const specs = entries.map((e) => classifyAccount(e.account));
    const journalId = input.journalId ?? journalIdFor(causationEventId);

    const { result, newAccounts } = await driver.transaction(async (q) => {
      const newAccounts = await ensureAccounts(q, specs);
      const inserted = await q.query(
        `WITH j AS (
           INSERT INTO journals (journal_id, payment_id, kind, causation_event_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING journal_id
         )
         INSERT INTO entries (journal_id, seq, account_id, direction, amount_minor, currency)
         SELECT j.journal_id, e.seq, e.account_id, e.direction, e.amount_minor, e.currency
           FROM j CROSS JOIN unnest($5::int[], $6::text[], $7::text[], $8::bigint[], $9::text[])
                AS e(seq, account_id, direction, amount_minor, currency)
         RETURNING seq`,
        [
          journalId,
          paymentId,
          kind,
          causationEventId,
          entries.map((_, i) => i + 1),
          entries.map((e) => e.account),
          entries.map((e) => e.direction),
          entries.map((e) => String(e.amount.amountMinor)),
          entries.map((e) => e.amount.currency),
        ],
      );
      if (inserted.length === entries.length) return { result: { journalId, entries, created: true }, newAccounts };
      if (inserted.length !== 0) throw new Error(`ledger: partial insert of journal ${journalId}`); // unreachable; rolls back
      // Already posted: by this causation event, or (settlement) for this payment by another event.
      let existing = await loadJournals(q, 'WHERE causation_event_id = $1', [causationEventId]);
      if (existing.length === 0 && (kind === 'settlement' || kind === 'refund')) {
        existing = await loadJournals(q, 'WHERE payment_id = $1 AND kind = $2', [paymentId, kind]);
      }
      if (existing.length === 0) existing = await loadJournals(q, 'WHERE journal_id = $1', [journalId]);
      const found = existing[0];
      if (!found) throw new Error(`ledger: journal for ${causationEventId} conflicted but could not be found`);
      if (found.paymentId !== paymentId) {
        throw new Error(`ledger: causation ${causationEventId} already posted journal ${found.journalId} for payment ${found.paymentId}, not ${paymentId}`);
      }
      return { result: { journalId: found.journalId, entries: toLedgerEntries(found), created: false }, newAccounts };
    });
    for (const s of newAccounts) knownAccounts.set(s.accountId, s); // only after COMMIT
    return result;
  }

  async function accountRows(where = '', params: unknown[] = []): Promise<AccountBalance[]> {
    const rows = await driver.query<{ account_id: string; type: AccountType; currency: string; debits: string; credits: string; n: number }>(
      `SELECT a.account_id, a.type, a.currency,
              coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0)::text AS debits,
              coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'credit'), 0)::text AS credits,
              count(e.seq)::int AS n
         FROM accounts a LEFT JOIN entries e ON e.account_id = a.account_id
         ${where}
        GROUP BY a.account_id, a.type, a.currency
        ORDER BY a.account_id`,
      params,
    );
    return rows.map((r) => {
      const debits = toSafeInt(r.debits, 'debits');
      const credits = toSafeInt(r.credits, 'credits');
      return { accountId: r.account_id, type: r.type, currency: r.currency, debits, credits, balance: debits - credits, entryCount: Number(r.n) };
    });
  }

  async function journalCount(): Promise<number> {
    const rows = await driver.query<{ n: number }>('SELECT count(*)::int AS n FROM journals');
    return Number(rows[0]?.n ?? 0);
  }

  async function trialBalance(): Promise<TrialBalance> {
    const [counts, byCcy] = await Promise.all([
      driver.query<{ journals: number; entries: number }>(
        'SELECT (SELECT count(*)::int FROM journals) AS journals, (SELECT count(*)::int FROM entries) AS entries',
      ),
      driver.query<{ currency: string; debits: string; credits: string }>(
        `SELECT currency,
                coalesce(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0)::text AS debits,
                coalesce(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0)::text AS credits
           FROM entries GROUP BY currency ORDER BY currency`,
      ),
    ]);
    const rows = byCcy.map((r) => {
      const debits = toSafeInt(r.debits, 'debits');
      const credits = toSafeInt(r.credits, 'credits');
      return { currency: r.currency, debits, credits, balanced: debits === credits };
    });
    return {
      asOf: new Date().toISOString(),
      journals: Number(counts[0]?.journals ?? 0),
      entries: Number(counts[0]?.entries ?? 0),
      byCurrency: rows,
      balanced: rows.every((r) => r.balanced),
    };
  }

  async function invariants(): Promise<InvariantReport> {
    const violations: string[] = [];
    // 1. Full recomputation in JS from raw rows (independent of SQL aggregation), with BigInt.
    const journals = await driver.query<{ journal_id: string; payment_id: string; kind: string; causation_event_id: string }>(
      'SELECT journal_id, payment_id, kind, causation_event_id FROM journals',
    );
    const raw = await driver.query<{ journal_id: string; account_id: string; direction: string; amount: string; currency: string }>(
      'SELECT journal_id, account_id, direction, amount_minor::text AS amount, currency FROM entries',
    );
    const accounts = await driver.query<{ account_id: string; type: string; currency: string }>('SELECT account_id, type, currency FROM accounts');
    const accountById = new Map(accounts.map((a) => [a.account_id, a]));
    const journalIds = new Set<string>();
    const causations = new Map<string, string>();
    const settlementByPayment = new Map<string, string>();
    const refundByPayment = new Map<string, string>();
    for (const j of journals) {
      journalIds.add(j.journal_id);
      const prev = causations.get(j.causation_event_id);
      if (prev) violations.push(`causation ${j.causation_event_id} shared by journals ${prev} and ${j.journal_id}`);
      else causations.set(j.causation_event_id, j.journal_id);
      if (j.kind === 'settlement') {
        const other = settlementByPayment.get(j.payment_id);
        if (other) violations.push(`payment ${j.payment_id} has two settlement journals: ${other}, ${j.journal_id}`);
        else settlementByPayment.set(j.payment_id, j.journal_id);
      }
      if (j.kind === 'refund') {
        const other = refundByPayment.get(j.payment_id);
        if (other) violations.push(`payment ${j.payment_id} has two refund journals: ${other}, ${j.journal_id}`);
        else refundByPayment.set(j.payment_id, j.journal_id);
      }
    }
    for (const [paymentId, refundId] of refundByPayment) {
      if (!settlementByPayment.has(paymentId)) violations.push(`refund journal ${refundId} for payment ${paymentId} has no settlement journal`);
    }
    const netByJournal = new Map<string, Map<string, bigint>>();
    const countByJournal = new Map<string, number>();
    const byAccount = new Map<string, { d: bigint; c: bigint }>();
    const byCurrency = new Map<string, bigint>();
    for (const e of raw) {
      const amt = BigInt(e.amount);
      if (amt <= 0n) violations.push(`journal ${e.journal_id}: non-positive amount ${e.amount} on ${e.account_id}`);
      if (e.direction !== 'debit' && e.direction !== 'credit') violations.push(`journal ${e.journal_id}: bad direction ${e.direction}`);
      if (!journalIds.has(e.journal_id)) violations.push(`entry references missing journal ${e.journal_id}`);
      const acct = accountById.get(e.account_id);
      if (!acct) violations.push(`journal ${e.journal_id}: entry references missing account ${e.account_id}`);
      else if (acct.currency !== e.currency) violations.push(`journal ${e.journal_id}: ${e.currency} entry on ${acct.currency} account ${e.account_id}`);
      const signed = e.direction === 'debit' ? amt : -amt;
      const nets = netByJournal.get(e.journal_id) ?? new Map<string, bigint>();
      nets.set(e.currency, (nets.get(e.currency) ?? 0n) + signed);
      netByJournal.set(e.journal_id, nets);
      countByJournal.set(e.journal_id, (countByJournal.get(e.journal_id) ?? 0) + 1);
      const a = byAccount.get(e.account_id) ?? { d: 0n, c: 0n };
      if (e.direction === 'debit') a.d += amt;
      else a.c += amt;
      byAccount.set(e.account_id, a);
      byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0n) + signed);
    }
    for (const id of journalIds) {
      const n = countByJournal.get(id) ?? 0;
      if (n < 2) violations.push(`journal ${id} has ${n} entries`);
      for (const [ccy, net] of netByJournal.get(id) ?? []) {
        if (net !== 0n) violations.push(`journal ${id} unbalanced in ${ccy}: debits - credits = ${net}`);
      }
    }
    // M4: a refund journal must exactly reverse its settlement journal (per account and currency).
    if (refundByPayment.size) {
      const netByAccount = new Map<string, Map<string, bigint>>(); // journal -> account|ccy -> signed sum
      for (const e of raw) {
        const m = netByAccount.get(e.journal_id) ?? new Map<string, bigint>();
        const k = `${e.account_id}|${e.currency}`;
        m.set(k, (m.get(k) ?? 0n) + (e.direction === 'debit' ? BigInt(e.amount) : -BigInt(e.amount)));
        netByAccount.set(e.journal_id, m);
      }
      for (const [paymentId, refundId] of refundByPayment) {
        const settlementId = settlementByPayment.get(paymentId);
        if (!settlementId) continue;
        const st = netByAccount.get(settlementId) ?? new Map<string, bigint>();
        const rf = netByAccount.get(refundId) ?? new Map<string, bigint>();
        for (const k of new Set([...st.keys(), ...rf.keys()])) {
          if ((st.get(k) ?? 0n) + (rf.get(k) ?? 0n) !== 0n) {
            violations.push(`refund journal ${refundId} does not reverse settlement ${settlementId} on ${k.replace('|', ' ')}`);
          }
        }
      }
    }
    for (const [ccy, net] of byCurrency) if (net !== 0n) violations.push(`trial balance unbalanced in ${ccy}: debits - credits = ${net}`);
    for (const a of accounts) {
      try {
        const spec = classifyAccount(a.account_id);
        if (spec.type !== a.type || spec.currency !== a.currency) violations.push(`account ${a.account_id} is ${a.type}/${a.currency}, chart says ${spec.type}/${spec.currency}`);
      } catch (err) {
        violations.push((err as Error).message);
      }
    }
    // 2. Cross-check the SQL aggregation the API serves against the JS recomputation.
    for (const r of await accountRows()) {
      const a = byAccount.get(r.accountId) ?? { d: 0n, c: 0n };
      if (BigInt(r.debits) !== a.d || BigInt(r.credits) !== a.c) violations.push(`account ${r.accountId}: served balance differs from recomputation`);
    }
    return { ok: violations.length === 0, violations: violations.slice(0, 200) };
  }

  return {
    driver,
    kind: driver.kind,
    postJournal,
    async postSettlement({ paymentId, causationEventId, state }) {
      if (state.paymentId !== paymentId) throw new Error(`ledger: state is for ${state.paymentId}, not ${paymentId}`);
      return postJournal({ paymentId, kind: 'settlement', causationEventId, entries: settlementEntries(state) });
    },
    async postRefund({ paymentId, causationEventId, state }) {
      if (state && state.paymentId !== paymentId) throw new Error(`ledger: state is for ${state.paymentId}, not ${paymentId}`);
      const [settlement] = await loadJournals(driver, `WHERE payment_id = $1 AND kind = 'settlement'`, [paymentId]);
      if (!settlement) throw new Error(`ledger: payment ${paymentId} has no settlement journal to refund`);
      return postJournal({ paymentId, kind: 'refund', causationEventId, entries: refundEntries(toLedgerEntries(settlement)) });
    },
    trialBalance,
    accounts: () => accountRows(),
    async account(accountId, recentLimit = 20) {
      const [row] = await accountRows('WHERE a.account_id = $1', [accountId]);
      if (!row) return undefined;
      const recent = await loadJournals(
        driver,
        'WHERE journal_id IN (SELECT journal_id FROM entries WHERE account_id = $1)',
        [accountId],
        recentLimit,
      );
      return { ...row, recent };
    },
    journals(filter = {}) {
      if (filter.paymentId !== undefined) return loadJournals(driver, 'WHERE payment_id = $1', [filter.paymentId]);
      return loadJournals(driver, '', [], filter.limit ?? 50);
    },
    journalCount,
    invariants,
    close: () => driver.close(),
  };
}
