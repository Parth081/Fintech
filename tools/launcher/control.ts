// Launcher control API (M3): a tiny HTTP server on 127.0.0.1:launcherControlPort (default 7079) that the
// gateway proxies POST /api/control/reset to, and that verify:m3 calls directly. It is part of the
// launcher process, so it keeps running while every service is stopped and started again.
//
//   GET  /status          -> LauncherStatus
//   POST /reset           -> ResetResult (200) once the gateway is healthy again
//   POST /reset?wait=0    -> 202 { ok: true, accepted: true } at once; the reset runs in the background
//                            (for callers that are themselves restarted by the reset, e.g. the gateway)
//   409 while a reset is already running; 500 { ok: false, error } if the reset failed.
import { rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface ServiceStatus {
  name: string;
  running: boolean;
}

export interface ResetResult {
  ok: true;
  durationMs: number;
  /** Where the time went: stopping every service, deleting the data dir, starting everything again. */
  phases: { stopMs: number; wipeMs: number; startMs: number };
  /** ms from the start phase until each service was ready. */
  ready: Record<string, number>;
  /** Number of resets since the launcher started (this one included). */
  resets: number;
}

export interface LauncherStatus {
  services: ServiceStatus[];
  startedAt: string;
  resetting: boolean;
  resets: number;
  lastReset: (ResetResult & { at: string }) | { ok: false; error: string; at: string } | null;
}

/** What the control server drives: launch() provides the real one, tests a fake. */
export interface ResetController {
  status(): LauncherStatus;
  reset(): Promise<ResetResult>;
}

export class ResetBusyError extends Error {
  constructor(message = 'a reset is already running') {
    super(message);
    this.name = 'ResetBusyError';
  }
}

/** Refuse to recursively delete the repo root, a parent of it, or a filesystem root. */
export function assertSafeToDelete(dir: string, rootDir: string): void {
  const target = path.resolve(dir);
  const root = path.resolve(rootDir);
  const rel = path.relative(target, root);
  const targetIsAncestorOrSelf = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (targetIsAncestorOrSelf || path.parse(target).root === target) {
    throw new Error(`Refusing to delete "${target}" for --reset: it is the repo root or one of its parents.`);
  }
}

/**
 * Delete the data directory (event log, ledger). Windows may keep a file handle for a moment after a
 * process was killed, so retry briefly instead of failing the reset.
 */
export function wipeDataDir(dataDir: string, rootDir: string): void {
  assertSafeToDelete(dataDir, rootDir);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

export interface ControlServerOptions {
  host?: string;
  /** 0 = any free port (tests). */
  port: number;
  controller: ResetController;
  log?: (line: string) => void;
  /** Delay before a ?wait=0 reset starts, so the 202 reaches a proxying caller first (default 150 ms). */
  asyncGraceMs?: number;
}

export interface ControlServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? (() => {});
  let inFlight: Promise<unknown> | null = null;

  const runReset = (): Promise<ResetResult> => {
    const p = Promise.resolve().then(() => opts.controller.reset());
    inFlight = p;
    void p.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (inFlight === p) inFlight = null;
    });
    return p;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
      res.end(text);
    };
    // Drain any request body (we ignore it).
    req.resume();
    if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/health')) {
      json(200, url.pathname === '/health' ? { ok: true } : opts.controller.status());
      return;
    }
    if (url.pathname === '/reset') {
      if (req.method !== 'POST') {
        json(405, { ok: false, error: 'use POST /reset' });
        return;
      }
      if (inFlight || opts.controller.status().resetting) {
        json(409, { ok: false, error: 'a reset is already running' });
        return;
      }
      const wait = url.searchParams.get('wait') !== '0' && url.searchParams.get('wait') !== 'false';
      if (!wait) {
        // Claim the slot now so a second request gets 409, start after the 202 has gone out.
        let release!: () => void;
        inFlight = new Promise<void>((r) => (release = r));
        json(202, { ok: true, accepted: true });
        setTimeout(() => {
          inFlight = null;
          release();
          runReset().then(
            (r) => log(`reset done in ${r.durationMs} ms`),
            (e: unknown) => log(`reset failed: ${(e as Error).message.split('\n')[0]}`),
          );
        }, opts.asyncGraceMs ?? 150);
        return;
      }
      runReset().then(
        (r) => json(200, r),
        (e: unknown) => {
          if (e instanceof ResetBusyError) json(409, { ok: false, error: e.message });
          else json(500, { ok: false, error: (e as Error).message });
        },
      );
      return;
    }
    json(404, { ok: false, error: 'not found (GET /status, POST /reset)' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: opts.port, host }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
