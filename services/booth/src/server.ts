// Booth HTTP API (see @ct/contracts booth-api.ts). Binds to 127.0.0.1 by default; the browser reaches it through
// the gateway at /api/booth/*. This module makes NO outbound network calls: it only answers requests.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { leadsToCsv } from './csv';
import { StoreFullError, type BoothStore } from './store';
import { LIMITS, validateEvent, validateLead } from './validate';

export interface BoothOptions {
  store: BoothStore;
  /** Staff PIN for the presenter-only routes (header X-Booth-Staff). Empty = staff routes disabled. */
  staffPin: string;
  host?: string;
  /** 0 = pick a free port. */
  port?: number;
  log?: (line: string) => void;
  /** Clock (tests). */
  now?: () => number;
  /** Wrong PINs allowed per window before staff routes answer 429. Default 10 per 60 s. */
  maxPinFailures?: number;
  pinWindowMs?: number;
}

export interface BoothHandle {
  port: number;
  /** Stops the HTTP server. The store belongs to the caller. */
  close(): Promise<void>;
}

export const BODY_LIMITS = { lead: 16 * 1024, analytics: 64 * 1024 } as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  // JSON only: an HTML form on another site cannot send this content type without a CORS preflight.
  if (!type.startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json');
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `body larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new HttpError(400, 'body is required');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time PIN comparison (both sides hashed to equal length first). */
export function pinMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || expected === '') return false;
  const ok = timingSafeEqual(digest(given), digest(expected));
  return ok && given.length === expected.length;
}

export function boothRequestHandler(options: BoothOptions) {
  const { store, staffPin } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const maxPinFailures = options.maxPinFailures ?? 10;
  const pinWindowMs = options.pinWindowMs ?? 60_000;
  let failures: number[] = [];

  const requireStaff = (req: IncomingMessage) => {
    const t = now();
    failures = failures.filter((f) => t - f < pinWindowMs);
    if (failures.length >= maxPinFailures) throw new HttpError(429, 'too many wrong PINs; wait a minute');
    if (!staffPin) throw new HttpError(403, 'staff routes are disabled (no BOOTH_STAFF_PIN)');
    const given = req.headers['x-booth-staff'];
    if (!pinMatches(given, staffPin)) {
      if (given !== undefined && given !== '') failures.push(t); // only real guesses count towards the lockout
      throw new HttpError(401, 'staff PIN required (header X-Booth-Staff)');
    }
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    try {
      const url = new URL(req.url ?? '/', 'http://booth.local');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/health') {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
        return send(res, 200, { ok: true });
      }

      if (path === '/analytics') {
        if (method !== 'POST') throw new HttpError(405, 'method not allowed');
        const body = await readJson(req, BODY_LIMITS.analytics);
        const events = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { events?: unknown }).events : undefined;
        if (!Array.isArray(events)) throw new HttpError(400, 'body must be { events: AnalyticsEvent[] }');
        if (events.length > LIMITS.eventsPerBatch) throw new HttpError(413, `at most ${LIMITS.eventsPerBatch} events per batch`);
        const t = now();
        const valid = [];
        const errors: string[] = [];
        for (const [i, raw] of events.entries()) {
          const r = validateEvent(raw, t);
          if (r.ok) valid.push(r.value);
          else errors.push(...r.errors.map((e) => `events[${i}]: ${e}`));
        }
        if (events.length > 0 && valid.length === 0) throw new HttpError(400, 'no valid events', errors.slice(0, 20));
        const accepted = await store.addEvents(valid);
        return send(res, 200, { accepted, rejected: events.length - valid.length, ...(errors.length ? { errors: errors.slice(0, 20) } : {}) });
      }

      if (path === '/leads') {
        if (method === 'POST') {
          const r = validateLead(await readJson(req, BODY_LIMITS.lead));
          if (!r.ok) throw new HttpError(400, 'invalid lead', r.errors);
          const lead = await store.addLead(r.value, new Date(now()));
          log(`[booth] lead stored ${lead.id}`); // never log personal fields
          return send(res, 201, lead);
        }
        if (method === 'GET') {
          requireStaff(req);
          return send(res, 200, await store.leads());
        }
        throw new HttpError(405, 'method not allowed');
      }

      if (path === '/leads/export.csv') {
        if (method !== 'GET') throw new HttpError(405, 'method not allowed');
        requireStaff(req);
        const csv = leadsToCsv(await store.leads());
        const day = new Date(now()).toISOString().slice(0, 10);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="booth-leads-${day}.csv"`,
          ...SECURITY_HEADERS,
        });
        res.end(csv);
        return;
      }

      const del = /^\/leads\/([^/]+)$/.exec(path);
      if (del) {
        if (method !== 'DELETE') throw new HttpError(405, 'method not allowed');
        requireStaff(req);
        let id: string;
        try {
          id = decodeURIComponent(del[1] ?? '');
        } catch {
          throw new HttpError(400, 'bad lead id');
        }
        if (!(await store.deleteLead(id))) throw new HttpError(404, 'lead not found');
        log(`[booth] lead erased ${id}`);
        return send(res, 200, { deleted: true });
      }

      if (path === '/summary') {
        if (method !== 'GET') throw new HttpError(405, 'method not allowed');
        requireStaff(req);
        return send(res, 200, await store.summary());
      }

      throw new HttpError(404, 'not found');
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
        if (err instanceof StoreFullError) return send(res, 507, { error: err.message });
        log(`[booth] http error ${method} ${req.url}: ${(err as Error).message}`);
        return send(res, 500, { error: 'internal error' });
      }
      res.end();
    }
  };
}

export async function startBooth(options: BoothOptions): Promise<BoothHandle> {
  const handler = boothRequestHandler(options);
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    port,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })),
  };
}
