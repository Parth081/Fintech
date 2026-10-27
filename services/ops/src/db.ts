// SQL driver + versioned migrations for the ops back office. Same pattern as the ledger's driver: embedded
// PGlite (offline default, `${DATA_DIR}/ops`) or real Postgres (DATABASE_URL). Every ops table lives in
// its own `ops` schema so the service can share the ledger's Postgres database without name clashes.
import { mkdirSync } from 'node:fs';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlDriver extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DriverOptions {
  /** postgres://... connection string. When set, node-postgres is used. */
  databaseUrl?: string;
  /** PGlite data directory. Omit (or 'memory') for an in-memory database. */
  dataDir?: string;
}

export async function openDriver(options: DriverOptions = {}): Promise<SqlDriver> {
  return options.databaseUrl ? openPostgres(options.databaseUrl) : openPGlite(options.dataDir);
}

async function openPGlite(dataDir?: string): Promise<SqlDriver> {
  const { PGlite } = await import('@electric-sql/pglite');
  const persistent = dataDir !== undefined && dataDir !== '' && dataDir !== 'memory';
  if (persistent) mkdirSync(dataDir, { recursive: true });
  const db = persistent ? await PGlite.create(dataDir) : await PGlite.create();
  let closed = false;
  return {
    kind: 'pglite',
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await db.query<T>(sql, params)).rows;
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async transaction<T>(fn: (q: Queryable) => Promise<T>) {
      return db.transaction(async (tx) =>
        fn({
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            return (await tx.query<R>(sql, params)).rows;
          },
        }),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      await db.close();
    },
  };
}

async function openPostgres(databaseUrl: string): Promise<SqlDriver> {
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import('pg').Pool }).Pool;
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', () => {});
  const probe = await pool.connect();
  probe.release();
  let closed = false;
  return {
    kind: 'postgres',
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            return (await client.query(sql, params)).rows as R[];
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Timestamps are stored as ISO-8601 UTC text (always the `...Z` form, so they sort lexicographically).
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'ops workflow: sessions, cases, alerts link, notes, changes, refunds, recon breaks, audit (append-only), developer',
    sql: `
CREATE TABLE ops.sessions (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL,
  created_at  text NOT NULL,
  expires_at  text NOT NULL,
  revoked_at  text
);

CREATE SEQUENCE ops.case_seq;
CREATE TABLE ops.cases (
  case_id     text PRIMARY KEY,
  payment_id  text NOT NULL UNIQUE,
  status      text NOT NULL CHECK (status IN ('open','in_review','pending_approval','closed')),
  priority    text NOT NULL CHECK (priority IN ('low','medium','high','critical')),
  opened_at   text NOT NULL,
  sla_due_at  text NOT NULL,
  assignee    jsonb,
  proposal    jsonb,
  decision    jsonb,
  event_id    text,
  updated_at  text NOT NULL
);
CREATE INDEX cases_status_idx ON ops.cases (status);

CREATE TABLE ops.case_alerts (
  alert_id    text PRIMARY KEY,
  case_id     text NOT NULL REFERENCES ops.cases (case_id),
  severity    text NOT NULL,
  raised_at   text NOT NULL
);
CREATE INDEX case_alerts_case_idx ON ops.case_alerts (case_id);

CREATE TABLE ops.case_notes (
  seq      bigserial PRIMARY KEY,
  case_id  text NOT NULL REFERENCES ops.cases (case_id),
  at       text NOT NULL,
  actor    jsonb NOT NULL,
  text     text NOT NULL
);
CREATE INDEX case_notes_case_idx ON ops.case_notes (case_id);

CREATE SEQUENCE ops.change_seq;
CREATE TABLE ops.change_requests (
  id              text PRIMARY KEY,
  key             text NOT NULL,
  current_value   jsonb,
  proposed_value  jsonb,
  reason          text NOT NULL,
  requested_by    jsonb NOT NULL,
  requested_at    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn')),
  reviewed_by     jsonb,
  reviewed_at     text,
  review_comment  text,
  applied_version integer,
  event_id        text
);

CREATE SEQUENCE ops.refund_seq;
CREATE TABLE ops.refund_requests (
  id              text PRIMARY KEY,
  payment_id      text NOT NULL,
  amount          jsonb NOT NULL,
  reason          text NOT NULL,
  requested_by    jsonb NOT NULL,
  requested_at    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn')),
  reviewed_by     jsonb,
  reviewed_at     text,
  review_comment  text,
  event_id        text NOT NULL UNIQUE
);
CREATE INDEX refund_requests_payment_idx ON ops.refund_requests (payment_id);

CREATE SEQUENCE ops.break_seq;
CREATE TABLE ops.recon_breaks (
  break_id     text PRIMARY KEY,
  payment_id   text NOT NULL UNIQUE,
  event_id     text NOT NULL,
  detected_at  text NOT NULL,
  status       text NOT NULL CHECK (status IN ('open','investigating','resolved')),
  assignee     jsonb,
  resolution   jsonb
);

CREATE TABLE ops.audit_log (
  seq          bigserial PRIMARY KEY,
  at           text NOT NULL,
  actor        jsonb NOT NULL,
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  payment_id   text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_id     text,
  dedupe_key   text UNIQUE
);
CREATE INDEX audit_log_target_idx ON ops.audit_log (target_type, target_id);
CREATE INDEX audit_log_payment_idx ON ops.audit_log (payment_id);
CREATE INDEX audit_log_action_idx ON ops.audit_log (action);

-- The audit trail is append-only: no UPDATE, DELETE or TRUNCATE, whoever asks.
CREATE FUNCTION ops.audit_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ops: audit_log is append-only, % rejected', TG_OP USING ERRCODE = '42501';
END
$fn$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON ops.audit_log FOR EACH ROW EXECUTE FUNCTION ops.audit_reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON ops.audit_log FOR EACH STATEMENT EXECUTE FUNCTION ops.audit_reject_mutation();

CREATE TABLE ops.api_keys (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,
  secret_hash   text NOT NULL UNIQUE,
  scopes        jsonb NOT NULL,
  created_at    text NOT NULL,
  created_by    jsonb NOT NULL,
  last_used_at  text,
  revoked_at    text
);

CREATE TABLE ops.webhook_endpoints (
  id           text PRIMARY KEY,
  url          text NOT NULL,
  events       jsonb NOT NULL,
  enabled      boolean NOT NULL,
  created_at   text NOT NULL,
  created_by   jsonb NOT NULL,
  from_offset  bigint NOT NULL
);

CREATE TABLE ops.webhook_deliveries (
  seq          bigserial PRIMARY KEY,
  id           text NOT NULL UNIQUE,
  endpoint_id  text NOT NULL REFERENCES ops.webhook_endpoints (id),
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  at           text NOT NULL,
  status       text NOT NULL CHECK (status IN ('delivered','failed','simulated')),
  response_ms  integer NOT NULL,
  UNIQUE (endpoint_id, event_id)
);
`,
  },
  {
    version: 2,
    name: 'webhook endpoints: soft delete',
    sql: `ALTER TABLE ops.webhook_endpoints ADD COLUMN deleted_at text;`,
  },
];

/** Apply pending migrations (schema `ops`). Safe to call from several processes at once (advisory lock). */
export async function migrate(driver: SqlDriver, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  await driver.exec(`CREATE SCHEMA IF NOT EXISTS ops`);
  await driver.exec(`CREATE TABLE IF NOT EXISTS ops.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const done = await driver.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(707501)');
      const rows = await q.query('SELECT 1 FROM ops.schema_migrations WHERE version = $1', [m.version]);
      if (rows.length > 0) return false;
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO ops.schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
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
