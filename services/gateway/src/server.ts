// Gateway: read-side projection over the event bus, HTTP API, WebSocket push and static UI.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AnyEvent, EventType, PaymentStatus } from '@ct/contracts';
import type { EventBus } from '@ct/event-bus';
import { ALL_STATUSES, Projection, type PaymentFilter } from './projection';
import { camt053For, defaultIso, defaultMarket, fxRates, providerViews, type IsoPort, type MarketPort } from './views';
import type {
  EventBrief,
  Health,
  PaymentSummary,
  ProviderView,
  ServerMessage,
  SnapshotMessage,
  StatsMessage,
  UpdateMessage,
} from './api-types';

export interface GatewayOptions {
  bus: EventBus;
  host?: string;
  port?: number;
  paymentApiUrl: string;
  /** Ledger service base URL (GET /api/ledger/* is proxied to {ledgerUrl}/ledger/*). Default http://127.0.0.1:7073. */
  ledgerUrl?: string;
  /** Directory with the built web UI. Default: apps/web/dist (or env WEB_DIST). */
  webDist?: string;
  /** WS batching window. Default 50 ms. */
  flushIntervalMs?: number;
  /** WS heartbeat interval. Default 15 s. */
  heartbeatMs?: number;
  /** Periodic stats push (throughput decays while idle). Default 2 s; 0 disables. */
  statsIntervalMs?: number;
  /** Max payment summaries per WS frame; the rest follow in the next frame. Default 500. */
  maxPaymentsPerFrame?: number;
  /** Max event briefs per WS frame (oldest dropped first). Default 1000. */
  maxEventsPerFrame?: number;
  /** Seed for the simulated market (SIM_SEED). */
  simSeed?: string;
  /** Injected for tests; default @ct/market and @ct/iso20022. */
  market?: MarketPort;
  iso?: IsoPort;
  /** Clock (tests). */
  now?: () => number;
  /** Log replay progress to the console. Default true unless running under vitest. */
  log?: boolean;
}

export interface GatewayHandle {
  port: number;
  projection: Projection;
  /** Resolves when the startup replay reached the log head seen at start. */
  replayed: Promise<{ events: number; ms: number }>;
  close(): Promise<void>;
}

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
export const DEFAULT_WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const NOT_BUILT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Control Tower</title></head>
<body style="font:18px system-ui,sans-serif;background:#0b1020;color:#e6ebf5;padding:2rem">
<h1>Global Fintech Control Tower</h1><p>UI not built: run npm run build:web</p>
<p>The API is live: <a style="color:#7cc4ff" href="/api/stats">/api/stats</a></p></body></html>`;

const MAX_BODY = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseIntParam(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const isVitest = () => typeof process !== 'undefined' && process.env.VITEST !== undefined;

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const { bus, paymentApiUrl } = options;
  const host = options.host ?? '127.0.0.1';
  const webDist = resolve(options.webDist ?? process.env.WEB_DIST ?? DEFAULT_WEB_DIST);
  const ledgerUrl = (options.ledgerUrl ?? 'http://127.0.0.1:7073').replace(/\/$/, '');
  const flushIntervalMs = options.flushIntervalMs ?? 50;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const statsIntervalMs = options.statsIntervalMs ?? 2000;
  const maxPaymentsPerFrame = options.maxPaymentsPerFrame ?? 500;
  const maxEventsPerFrame = options.maxEventsPerFrame ?? 1000;
  const marketPort = options.market ?? defaultMarket;
  const isoPort = options.iso ?? defaultIso;
  const simSeed = options.simSeed ?? 'control-tower';
  const now = options.now ?? Date.now;
  const log = options.log ?? !isVitest();
  const projection = new Projection({ now });

  // ---- WebSocket fan-out: coalesced per payment, capped per frame ----------------------
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();
  /** Latest summary per changed payment, in order of first change since the last flush. */
  const pendingPayments = new Map<string, PaymentSummary>();
  let pendingEvents: EventBrief[] = [];
  let pendingDropped = 0;
  let pendingCount = 0;
  let pendingCounts: Partial<Record<EventType, number>> = {};
  let flushTimer: NodeJS.Timeout | null = null;

  const broadcast = (frame: string, exclude?: WebSocket) => {
    for (const client of wss.clients) {
      if (client === exclude) continue;
      if (client.readyState !== WebSocket.OPEN) continue;
      // Drop clients that cannot keep up instead of buffering without bound.
      if (client.bufferedAmount > 8 * 1024 * 1024) {
        client.terminate();
        continue;
      }
      client.send(frame);
    }
  };

  const listeners = (exclude?: WebSocket) => {
    let n = 0;
    for (const c of wss.clients) if (c !== exclude && c.readyState === WebSocket.OPEN) n++;
    return n;
  };

  const clearPending = () => {
    pendingPayments.clear();
    pendingEvents = [];
    pendingDropped = 0;
    pendingCount = 0;
    pendingCounts = {};
  };

  const flush = (exclude?: WebSocket) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pendingPayments.size === 0 && pendingCount === 0) return;
    if (listeners(exclude) === 0) {
      clearPending();
      return;
    }
    const payments: PaymentSummary[] = [];
    for (const [id, s] of pendingPayments) {
      if (payments.length >= maxPaymentsPerFrame) break;
      payments.push(s);
      pendingPayments.delete(id);
    }
    let events = pendingEvents;
    let dropped = pendingDropped;
    if (events.length > maxEventsPerFrame) {
      dropped += events.length - maxEventsPerFrame;
      events = events.slice(events.length - maxEventsPerFrame);
    }
    const msg: UpdateMessage = {
      kind: 'update',
      payments,
      events,
      eventCount: pendingCount,
      droppedEvents: dropped,
      counts: pendingCounts,
      stats: projection.stats(),
    };
    pendingEvents = [];
    pendingDropped = 0;
    pendingCount = 0;
    pendingCounts = {};
    broadcast(JSON.stringify(msg), exclude);
    // More changed payments than fit in one frame: send them next window.
    if (pendingPayments.size > 0) scheduleFlush();
  };

  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(() => flush(), flushIntervalMs);
  };

  const enqueue = (event: AnyEvent, summary: PaymentSummary) => {
    pendingPayments.set(event.paymentId, summary);
    pendingEvents.push({ eventId: event.eventId, type: event.type, paymentId: event.paymentId, occurredAt: event.occurredAt });
    if (pendingEvents.length > maxEventsPerFrame * 2) {
      const cut = pendingEvents.length - maxEventsPerFrame;
      pendingEvents = pendingEvents.slice(cut);
      pendingDropped += cut;
    }
    pendingCount += 1;
    pendingCounts[event.type] = (pendingCounts[event.type] ?? 0) + 1;
    scheduleFlush();
  };

  const SNAPSHOT_ROWS = 100;
  const snapshot = (): SnapshotMessage => ({ kind: 'snapshot', payments: projection.summaries(SNAPSHOT_ROWS), stats: projection.stats() });

  wss.on('connection', (socket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('error', () => socket.terminate());
    // Clients only listen; ignore anything they send.
    // Deliver queued changes to existing clients first: the snapshot already contains them.
    flush(socket);
    const msg: ServerMessage = snapshot();
    socket.send(JSON.stringify(msg));
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  const statsTimer =
    statsIntervalMs > 0
      ? setInterval(() => {
          if (listeners() === 0) return;
          const msg: StatsMessage = { kind: 'stats', stats: projection.stats() };
          broadcast(JSON.stringify(msg));
        }, statsIntervalMs)
      : null;
  statsTimer?.unref();

  // ---- Bus subscription + replay timing -----------------------------------------------
  const replayStart = performance.now();
  const headAtStart = await bus.head().catch(() => 0);
  let replayDone: { events: number; ms: number } | null = null;
  let resolveReplay!: (v: { events: number; ms: number }) => void;
  const replayed = new Promise<{ events: number; ms: number }>((r) => (resolveReplay = r));
  const finishReplay = () => {
    if (replayDone) return;
    replayDone = { events: headAtStart, ms: Math.round(performance.now() - replayStart) };
    if (log && headAtStart > 0) {
      console.log(`[gateway] replayed ${headAtStart} events (${projection.paymentCount} payments) in ${replayDone.ms} ms`);
    }
    resolveReplay(replayDone);
  };
  if (headAtStart === 0) finishReplay();

  const subscription = await bus.subscribe({ group: 'gateway', from: 'earliest', ephemeral: true }, (event, meta) => {
    // Never throw: a throwing handler would be retried forever.
    try {
      const result = projection.apply(event);
      if (result.kind === 'applied') enqueue(result.event, result.summary);
      else if (result.kind === 'rejected' && log) {
        console.warn(`[gateway] rejected event ${String(event?.eventId)} (${String(event?.type)}): ${result.error}`);
      }
    } catch (err) {
      console.error('[gateway] projection failed', err);
    }
    if (!replayDone && meta.offset + 1 >= headAtStart) finishReplay();
  });

  // ---- HTTP ---------------------------------------------------------------------------
  const proxy = async (req: IncomingMessage, res: ServerResponse, target: string) => {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: (err as Error).message });
      return;
    }
    const headers: Record<string, string> = {
      'content-type': req.headers['content-type'] ?? 'application/json',
    };
    const key = req.headers['idempotency-key'];
    if (typeof key === 'string' && key) headers['idempotency-key'] = key;
    try {
      const upstream = await fetch(`${paymentApiUrl.replace(/\/$/, '')}${target}`, {
        method: 'POST',
        headers,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(text);
    } catch (err) {
      sendJson(res, 502, { error: 'payment API unavailable', detail: (err as Error).message });
    }
  };

  /** GET /api/ledger/<rest> -> {ledgerUrl}/ledger/<rest>; /api/ledger/health -> {ledgerUrl}/health. */
  const proxyLedger = async (res: ServerResponse, path: string, search: string) => {
    const rest = path.slice('/api/ledger'.length);
    const target = rest === '/health' ? '/health' : `/ledger${rest}`;
    try {
      const upstream = await fetch(`${ledgerUrl}${target}${search}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(text);
    } catch (err) {
      sendJson(res, 502, { error: 'ledger unavailable', detail: (err as Error).message });
    }
  };

  let providersCache: { at: number; body: ProviderView[] } | null = null;
  const providers = (): ProviderView[] => {
    const t = now();
    if (providersCache && t - providersCache.at < 1000) return providersCache.body;
    providersCache = { at: t, body: providerViews(projection, marketPort) };
    return providersCache.body;
  };

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { error: 'bad path' });
      return;
    }
    if (decoded.includes('\0')) {
      sendJson(res, 400, { error: 'bad path' });
      return;
    }
    const root = webDist.endsWith(sep) ? webDist : webDist + sep;
    const candidate = resolve(webDist, '.' + sep + decoded.replace(/^[/\\]+/, ''));
    if (candidate !== webDist && !candidate.startsWith(root)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const indexFile = join(webDist, 'index.html');
    const fileFor = async (p: string) => {
      try {
        const s = await stat(p);
        if (s.isFile()) return p;
        if (s.isDirectory()) {
          const idx = join(p, 'index.html');
          const si = await stat(idx).catch(() => null);
          if (si?.isFile()) return idx;
        }
      } catch {
        /* not found */
      }
      return null;
    };
    let file = await fileFor(candidate);
    if (!file) {
      // SPA fallback (only for route-like paths; missing assets are real 404s)
      if (extname(decoded) === '' || decoded.endsWith('.html')) file = await fileFor(indexFile);
      if (!file) {
        if (!(await fileFor(indexFile))) {
          res.writeHead(decoded === '/' || decoded === '' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : NOT_BUILT_HTML);
        } else {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found');
        }
        return;
      }
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL, method: string) => {
    const path = url.pathname;
    if (method === 'GET') {
      if (path === '/api/payments') {
        const q = url.searchParams;
        const limit = parseIntParam(q.get('limit'), 50, 1, 1000);
        const offset = parseIntParam(q.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const filter: PaymentFilter = {};
        const status = q.get('status');
        if (status) filter.status = status.split(',').filter((s): s is PaymentStatus => (ALL_STATUSES as readonly string[]).includes(s));
        if (status && filter.status?.length === 0) filter.status = ['__none__' as PaymentStatus];
        const corridor = q.get('corridor');
        if (corridor) filter.corridor = corridor;
        const provider = q.get('provider');
        if (provider) filter.provider = provider;
        const page = projection.page(filter, offset, limit);
        res.setHeader('x-total-count', String(page.total));
        res.setHeader('access-control-expose-headers', 'x-total-count');
        return sendJson(res, 200, page.items);
      }
      if (path === '/api/stats') return sendJson(res, 200, projection.stats());
      if (path === '/api/rejected') return sendJson(res, 200, projection.rejected());
      if (path === '/api/throughput') return sendJson(res, 200, projection.throughput.read());
      if (path === '/api/fx/rates') return sendJson(res, 200, fxRates(projection, marketPort, simSeed, now()));
      if (path === '/api/providers') return sendJson(res, 200, providers());
      if (path === '/api/statements') return sendJson(res, 200, projection.statementRefs());
      if (path === '/api/ledger' || path.startsWith('/api/ledger/')) return proxyLedger(res, path, url.search);

      const st = /^\/api\/statements\/([^/]+)\/([^/]+)$/.exec(path);
      if (st) {
        const providerId = decodeSegment(st[1]!);
        const date = decodeSegment(st[2]!);
        if (providerId === null || date === null) return sendJson(res, 400, { error: 'bad path' });
        const groups = projection.statementGroups(providerId, date);
        const currency = url.searchParams.get('currency');
        const group = currency ? groups.find((g) => g.currency === currency) : groups[0];
        if (!group) return sendJson(res, 404, { error: 'statement not found', providerId, date, currency });
        let xml: string;
        try {
          xml = camt053For(group, isoPort);
        } catch (err) {
          return sendJson(res, 503, { error: 'camt.053 builder unavailable', detail: (err as Error).message });
        }
        res.writeHead(200, {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': 'no-store',
          'x-statement-id': group.statementId,
          'x-statement-currencies': groups.map((g) => g.currency).join(','),
        });
        res.end(xml);
        return;
      }

      const msgs = /^\/api\/payments\/([^/]+)\/messages$/.exec(path);
      if (msgs) {
        const id = decodeSegment(msgs[1]!);
        if (id === null) return sendJson(res, 400, { error: 'bad payment id' });
        const list = projection.messages(id);
        return list ? sendJson(res, 200, list) : sendJson(res, 404, { error: 'payment not found', paymentId: id });
      }
      const m = /^\/api\/payments\/([^/]+)$/.exec(path);
      if (m) {
        const id = decodeSegment(m[1]!);
        if (id === null) return sendJson(res, 400, { error: 'bad payment id' });
        const detail = projection.detail(id);
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'payment not found', paymentId: id });
      }
    }
    if (method === 'POST' && path === '/api/payments') return proxy(req, res, '/payments');
    if (method === 'POST' && path === '/api/payments/sample') return proxy(req, res, '/payments/sample');
    return sendJson(res, method === 'GET' || method === 'POST' ? 404 : 405, { error: 'not found' });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/health' && method === 'GET') {
      const body: Health = {
        ok: true,
        payments: projection.paymentCount,
        events: projection.totalEvents,
        replayed: replayDone !== null,
        replayMs: replayDone?.ms ?? null,
      };
      return sendJson(res, 200, body);
    }
    if (path.startsWith('/api/') || path === '/api') return handleApi(req, res, url, method);
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, path);
    return sendJson(res, 405, { error: 'method not allowed' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('[gateway] request failed', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://gateway.local').pathname;
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);

  let closed = false;
  return {
    port,
    projection,
    replayed,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (statsTimer) clearInterval(statsTimer);
      if (flushTimer) clearTimeout(flushTimer);
      await subscription.unsubscribe().catch(() => undefined);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
