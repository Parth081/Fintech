// SQL driver abstraction: the same SQL runs on embedded PGlite (offline default) and on real
// Postgres via node-postgres. Only the minimum surface the ledger needs.
import { mkdirSync } from 'node:fs';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlDriver extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  /** Multi-statement script without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** BEGIN ... COMMIT around fn; ROLLBACK if fn or COMMIT (deferred constraints) throws. */
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
  if (options.databaseUrl) return openPostgres(options.databaseUrl);
  return openPGlite(options.dataDir);
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
      const res = await db.query<T>(sql, params);
      return res.rows;
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async transaction<T>(fn: (q: Queryable) => Promise<T>) {
      return db.transaction(async (tx) =>
        fn({
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            const res = await tx.query<R>(sql, params);
            return res.rows;
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
  pool.on('error', () => {}); // idle client errors (e.g. server restart) must not crash the process
  // Fail fast with a clear error if the server is unreachable.
  const probe = await pool.connect();
  probe.release();
  let closed = false;
  return {
    kind: 'postgres',
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
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
            const res = await client.query(sql, params);
            return res.rows as R[];
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
