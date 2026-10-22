// Versioned schema migrations. Same SQL on PGlite and Postgres. Each migration runs in its own
// transaction together with its schema_migrations row; never edit an applied migration, add a new one.
import type { SqlDriver } from './driver';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const ACCOUNT_TYPES = `('asset','liability','revenue','expense','equity')`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'double-entry core: accounts, journals, entries, balance + immutability triggers',
    sql: `
CREATE TABLE accounts (
  account_id  text PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ${ACCOUNT_TYPES}),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, currency)
);

CREATE TABLE journals (
  journal_id          text PRIMARY KEY,
  payment_id          text NOT NULL,
  kind                text NOT NULL,
  causation_event_id  text NOT NULL UNIQUE,
  posted_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journals_payment_idx ON journals (payment_id);
-- A payment is settled into the ledger at most once, whatever event caused it.
CREATE UNIQUE INDEX journals_one_settlement_per_payment ON journals (payment_id) WHERE kind = 'settlement';

CREATE TABLE entries (
  journal_id    text NOT NULL REFERENCES journals (journal_id),
  seq           integer NOT NULL CHECK (seq >= 1),
  account_id    text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      text NOT NULL,
  PRIMARY KEY (journal_id, seq),
  -- the entry currency must equal the account currency
  FOREIGN KEY (account_id, currency) REFERENCES accounts (account_id, currency)
);
CREATE INDEX entries_account_idx ON entries (account_id);

-- Balance rule, checked at COMMIT (deferred) for every journal touched by the transaction:
-- at least two entries, debits = credits per currency, and entries may only be added in the
-- transaction that created the journal.
CREATE FUNCTION ledger_check_journal() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  jid text := NEW.journal_id;
  n integer;
  bad record;
BEGIN
  IF TG_TABLE_NAME = 'entries' AND NOT EXISTS (
    SELECT 1 FROM journals WHERE journal_id = jid AND xmin = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'ledger: entries can only be added in the transaction that created journal %', jid
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO n FROM entries WHERE journal_id = jid;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger: journal % has % entries, at least 2 required', jid, n USING ERRCODE = '23514';
  END IF;
  SELECT currency,
         sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) AS net
    INTO bad
    FROM entries WHERE journal_id = jid
    GROUP BY currency
    HAVING sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger: journal % is unbalanced in %: debits - credits = %', jid, bad.currency, bad.net
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_journal();
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_journal();

-- Append-only: posted money is never edited or removed (corrections are new journals).
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ledger: % is append-only, % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$fn$;

CREATE TRIGGER accounts_immutable BEFORE UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER journals_immutable BEFORE UPDATE OR DELETE ON journals FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER entries_immutable  BEFORE UPDATE OR DELETE ON entries  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON accounts FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER entries_no_truncate  BEFORE TRUNCATE ON entries  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
`,
  },
];

/** Apply pending migrations. Safe to call from several processes at once (advisory lock). */
export async function migrate(driver: SqlDriver, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const done = await driver.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(707301)');
      const rows = await q.query('SELECT 1 FROM schema_migrations WHERE version = $1', [m.version]);
      if (rows.length > 0) return false;
      // Run the script statement by statement through the same transaction.
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      return true;
    });
    if (done) applied.push(m.version);
  }
  return applied;
}

/** Split a script on top-level semicolons, keeping $fn$ ... $fn$ bodies intact. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        if (inDollar === null) inDollar = tag;
        else if (inDollar === tag) inDollar = null;
        buf += tag;
        i += tag.length - 1;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-' && inDollar === null) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      buf += '\n';
      continue;
    }
    if (ch === ';' && inDollar === null) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
