// Gateway: read-side projection over the event bus, HTTP API, WebSocket push and static UI.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AnyEvent } from '@ct/contracts';
import type { EventBus } from '@ct/event-bus';
import { Projection } from './projection';
import type { EventMessage, Health, ServerMessage, SnapshotMessage } from './api-types';

export interface GatewayOptions {
  bus: EventBus;
  host?: string;
  port?: number;
  paymentApiUrl: string;
  /** Directory with the built web UI. Default: apps/web/dist (or env WEB_DIST). */
  webDist?: string;
  /** WS batching window. Default 50 ms. */
  flushIntervalMs?: number;
  /** WS heartbeat interval. Default 15 s. */
  heartbeatMs?: number;
}

export interface GatewayHandle {
  port: number;
  projection: Projection;
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

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const { bus, paymentApiUrl } = options;
  const host = options.host ?? '127.0.0.1';
  const webDist = resolve(options.webDist ?? process.env.WEB_DIST ?? DEFAULT_WEB_DIST);
  const flushIntervalMs = options.flushIntervalMs ?? 50;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const projection = new Projection();

  // ---- WebSocket fan-out with batching -------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();
  let pending: AnyEvent[] = [];
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

  const flush = (exclude?: WebSocket) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (wss.clients.size === 0 || (exclude && wss.clients.size === 1)) return;
    const stats = projection.stats();
    const messages: EventMessage[] = [];
    // Summaries reflect the latest state; the event itself says what just happened.
    for (const event of batch) {
      const payment = projection.summary(event.paymentId);
      if (payment) messages.push({ kind: 'event', event, payment, stats });
    }
    if (messages.length === 1) broadcast(JSON.stringify(messages[0]), exclude);
    else if (messages.length > 1) broadcast(JSON.stringify(messages), exclude);
  };

  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(() => flush(), flushIntervalMs);
  };

  const snapshot = (): SnapshotMessage => ({ kind: 'snapshot', payments: projection.summaries(50), stats: projection.stats() });

  wss.on('connection', (socket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('error', () => socket.terminate());
    // Clients only listen; ignore anything they send.
    // Deliver queued events to existing clients first: the snapshot already contains them.
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

  // ---- Bus subscription ---------------------------------------------------------------
  const subscription = await bus.subscribe({ group: 'gateway', from: 'earliest', ephemeral: true }, (event) => {
    // Never throw: a throwing handler would be retried forever.
    const result = projection.apply(event);
    if (result.kind === 'applied') {
      pending.push(event);
      scheduleFlush();
    } else if (result.kind === 'rejected') {
      console.warn(`[gateway] rejected event ${String(event?.eventId)} (${String(event?.type)}): ${result.error}`);
    }
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/health' && method === 'GET') {
      const body: Health = { ok: true, payments: projection.paymentCount, events: projection.totalEvents };
      return sendJson(res, 200, body);
    }
    if (path.startsWith('/api/') || path === '/api') {
      if (method === 'GET' && path === '/api/payments') {
        const raw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 50;
        return sendJson(res, 200, projection.summaries(limit));
      }
      if (method === 'GET' && path === '/api/stats') return sendJson(res, 200, projection.stats());
      if (method === 'GET' && path === '/api/rejected') return sendJson(res, 200, projection.rejected());
      if (method === 'POST' && path === '/api/payments') return proxy(req, res, '/payments');
      if (method === 'POST' && path === '/api/payments/sample') return proxy(req, res, '/payments/sample');
      const m = /^\/api\/payments\/([^/]+)$/.exec(path);
      if (method === 'GET' && m) {
        let id: string;
        try {
          id = decodeURIComponent(m[1]!);
        } catch {
          return sendJson(res, 400, { error: 'bad payment id' });
        }
        const detail = projection.detail(id);
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'payment not found', paymentId: id });
      }
      return sendJson(res, method === 'GET' || method === 'POST' ? 404 : 405, { error: 'not found' });
    }
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
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      await subscription.unsubscribe().catch(() => undefined);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
