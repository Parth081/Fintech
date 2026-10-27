// Booth storage: embedded PGlite (on this laptop only; in-memory for tests). Leads and anonymous
// analytics live in separate tables, linked only by the random kiosk session id.
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { newId, type AnalyticsEvent, type BoothSummary, type Lead, type LeadInput } from '@ct/contracts';

type Row = Record<string, unknown>;

interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (q: { query<R extends Row = Row>(sql: string, params?: unknown[]): Promise<R[]> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function openPGlite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const persistent = dataDir !== undefined && dataDir !== '' && dataDir !== 'memory';
  if (persistent) mkdirSync(dataDir, { recursive: true });
  const db = persistent ? await PGlite.create(dataDir) : await PGlite.create();
  let closed = false;
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await db.query<T>(sql, params)).rows;
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async transaction(fn) {
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS booth_leads (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  consent_at timestamptz NOT NULL,
  name text NOT NULL,
  company text NOT NULL,
  role text,
  email text NOT NULL,
  interest text NOT NULL,
  consent_text text NOT NULL,
  session_id text
);
CREATE TABLE IF NOT EXISTS booth_events (
  seq bigserial PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  at timestamptz NOT NULL,
  data jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booth_events_session ON booth_events (session_id);
`;

/** Free-text fields in analytics data that are removed when a visitor's lead is erased. */
export const ERASABLE_DATA_KEYS = ['text', 'question'] as const;

export interface BoothStore {
  addEvents(events: AnalyticsEvent[]): Promise<number>;
  addLead(input: LeadInput, now?: Date): Promise<Lead>;
  leads(): Promise<Lead[]>;
  lead(id: string): Promise<Lead | null>;
  /** Right to erasure: removes the lead and unlinks/scrubs the analytics of its kiosk session. */
  deleteLead(id: string): Promise<boolean>;
  summary(): Promise<BoothSummary>;
  counts(): Promise<{ leads: number; events: number }>;
  close(): Promise<void>;
}

export interface BoothStoreOptions {
  /** PGlite data directory; omit or 'memory' for an in-memory database (tests). */
  dataDir?: string;
  /** Hard caps so a stuck kiosk or a script cannot fill the disk. */
  maxLeads?: number;
  maxEvents?: number;
}

export class StoreFullError extends Error {}

interface LeadRow extends Row {
  id: string;
  created_at: Date | string;
  consent_at: Date | string;
  name: string;
  company: string;
  role: string | null;
  email: string;
  interest: LeadInput['interest'];
  consent_text: string;
  session_id: string | null;
}

interface EventRow extends Row {
  session_id: string;
  type: AnalyticsEvent['type'];
  at: Date | string;
  data: Record<string, unknown> | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const ms = (v: Date | string) => (v instanceof Date ? v : new Date(v)).getTime();

type Engagement = Lead['engagement'];

function engagementOf(rows: EventRow[]): Engagement {
  const scenarios: string[] = [];
  const questions: string[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const t = ms(r.at);
    if (t < min) min = t;
    if (t > max) max = t;
    const d = r.data ?? {};
    if (r.type === 'scenario.viewed' && typeof d.scenarioId === 'string' && !scenarios.includes(d.scenarioId)) scenarios.push(d.scenarioId);
    if (r.type === 'question.asked' && typeof d.text === 'string' && !questions.includes(d.text)) questions.push(d.text);
  }
  return { scenarios, questions, dwellSeconds: rows.length ? Math.max(0, Math.round((max - min) / 1000)) : 0 };
}

function toLead(r: LeadRow, engagement: Engagement): Lead {
  const lead: Lead = {
    id: r.id,
    createdAt: iso(r.created_at),
    consentAt: iso(r.consent_at),
    name: r.name,
    company: r.company,
    email: r.email,
    interest: r.interest,
    consentText: r.consent_text,
    engagement,
  };
  if (r.role) lead.role = r.role;
  if (r.session_id) lead.sessionId = r.session_id;
  return lead;
}

const hourKey = (t: number) => `${new Date(t).toISOString().slice(0, 13)}:00Z`;

export async function openBoothStore(options: BoothStoreOptions = {}): Promise<BoothStore> {
  const db = await openPGlite(options.dataDir);
  await db.exec(SCHEMA);
  const maxLeads = options.maxLeads ?? 20_000;
  const maxEvents = options.maxEvents ?? 500_000;

  const count = async (table: 'booth_leads' | 'booth_events') => Number((await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n ?? 0);

  async function engagementFor(sessionIds: string[]): Promise<Map<string, Engagement>> {
    const out = new Map<string, Engagement>();
    const ids = [...new Set(sessionIds)];
    if (!ids.length) return out;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const rows = await db.query<EventRow>(`SELECT session_id, type, at, data FROM booth_events WHERE session_id IN (${placeholders}) ORDER BY seq`, ids);
    const by = new Map<string, EventRow[]>();
    for (const r of rows) by.set(r.session_id, [...(by.get(r.session_id) ?? []), r]);
    for (const id of ids) out.set(id, engagementOf(by.get(id) ?? []));
    return out;
  }

  async function withEngagement(rows: LeadRow[]): Promise<Lead[]> {
    const eng = await engagementFor(rows.map((r) => r.session_id).filter((s): s is string => !!s));
    const empty: Engagement = { scenarios: [], questions: [], dwellSeconds: 0 };
    return rows.map((r) => toLead(r, (r.session_id && eng.get(r.session_id)) || empty));
  }

  const store: BoothStore = {
    async addEvents(events) {
      if (!events.length) return 0;
      if ((await count('booth_events')) + events.length > maxEvents) throw new StoreFullError('analytics store is full');
      await db.transaction(async (q) => {
        for (const e of events) {
          await q.query('INSERT INTO booth_events (session_id, type, at, data) VALUES ($1, $2, $3, $4::jsonb)', [
            e.sessionId, e.type, e.at, e.data ? JSON.stringify(e.data) : null,
          ]);
        }
      });
      return events.length;
    },
    async addLead(input, now = new Date()) {
      if ((await count('booth_leads')) >= maxLeads) throw new StoreFullError('lead store is full');
      const id = newId();
      const at = now.toISOString();
      await db.query(
        `INSERT INTO booth_leads (id, created_at, consent_at, name, company, role, email, interest, consent_text, session_id)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, at, input.name, input.company, input.role ?? null, input.email, input.interest, input.consentText, input.sessionId ?? null],
      );
      const lead = await store.lead(id);
      if (!lead) throw new Error('lead not stored');
      return lead;
    },
    async leads() {
      return withEngagement(await db.query<LeadRow>('SELECT * FROM booth_leads ORDER BY created_at DESC, id'));
    },
    async lead(id) {
      const rows = await db.query<LeadRow>('SELECT * FROM booth_leads WHERE id = $1', [id]);
      return rows.length ? ((await withEngagement(rows))[0] ?? null) : null;
    },
    async deleteLead(id) {
      return db.transaction(async (q) => {
        const rows = await q.query<{ session_id: string | null }>('DELETE FROM booth_leads WHERE id = $1 RETURNING session_id', [id]);
        if (!rows.length) return false;
        const sessionId = rows[0]?.session_id;
        if (sessionId) {
          // Keep the anonymous counts but break the link to the person and drop any free text.
          const anon = `erased-${randomBytes(9).toString('base64url')}`;
          await q.query(
            `UPDATE booth_events SET session_id = $2, data = CASE WHEN data IS NULL THEN NULL ELSE data - $3::text - $4::text END WHERE session_id = $1`,
            [sessionId, anon, ERASABLE_DATA_KEYS[0], ERASABLE_DATA_KEYS[1]],
          );
        }
        return true;
      });
    },
    async summary() {
      const sessions = await db.query<{ session_id: string; first: Date | string; last: Date | string }>(
        'SELECT session_id, min(at) AS first, max(at) AS last FROM booth_events GROUP BY session_id',
      );
      const leadRows = await db.query<{ created_at: Date | string }>('SELECT created_at FROM booth_leads');
      const scen = await db.query<{ k: string; n: string | number }>(
        `SELECT data->>'scenarioId' AS k, count(*) AS n FROM booth_events WHERE type = 'scenario.viewed' AND data->>'scenarioId' IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      );
      const ques = await db.query<{ k: string; n: string | number }>(
        `SELECT data->>'text' AS k, count(*) AS n FROM booth_events WHERE type = 'question.asked' AND data->>'text' IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      );
      const hours = new Map<string, { visits: number; leads: number }>();
      const bump = (t: number, field: 'visits' | 'leads') => {
        const k = hourKey(t);
        const h = hours.get(k) ?? { visits: 0, leads: 0 };
        h[field] += 1;
        hours.set(k, h);
      };
      let dwell = 0;
      for (const s of sessions) {
        dwell += Math.max(0, (ms(s.last) - ms(s.first)) / 1000);
        bump(ms(s.first), 'visits');
      }
      for (const l of leadRows) bump(ms(l.created_at), 'leads');
      return {
        visits: sessions.length,
        avgDwellSeconds: sessions.length ? Math.round(dwell / sessions.length) : 0,
        leads: leadRows.length,
        topScenarios: scen.map((r) => ({ scenarioId: r.k, views: Number(r.n) })),
        topQuestions: ques.map((r) => ({ text: r.k, count: Number(r.n) })),
        byHour: [...hours.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, v]) => ({ hour, ...v })),
      };
    },
    async counts() {
      return { leads: await count('booth_leads'), events: await count('booth_events') };
    },
    close: () => db.close(),
  };
  return store;
}
