// Launcher control API (M3): a tiny HTTP server on 127.0.0.1:launcherControlPort (default 7079) that the
// gateway proxies POST /api/control/reset to, and that verify:m3 calls directly. It is part of the
// launcher process, so it keeps running while every service is stopped and started again.
//
//   GET  /status          -> LauncherStatus
//   POST /reset           -> ResetResult (200) once the gateway is healthy again
//   POST /reset?wait=0    -> 202 { ok: true, accepted: true } at once; the reset runs in the background
//                            (for callers that are themselves restarted by the reset, e.g. the gateway)
//   409 while a reset is already running; 500 { ok: false, error } if the reset failed.
// M6:
//   GET  /status          -> also { mode, recording, supervisor, services: ServiceHealthView[] }
//   POST /safe-mode {on, name?} -> { ok, mode, recording, durationMs } (200) once the new system is ready;
//                            ?wait=0 -> 202 once the request is validated (the switch starts a moment later; for
//                            callers the switch restarts, e.g. the gateway). 400 bad body, 404 unknown recording
//                            (nothing is stopped), 409 while a reset / mode change runs, 500 on failure.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ServiceHealthView, SupervisorPolicy, SystemMode } from '@ct/contracts';

/** One row of GET /status (M6: restart counters and the last exit are part of it). */
export type ServiceStatus = ServiceHealthView;

export interface ModeResult {
  ok: true;
  mode: SystemMode;
  recording: string | null;
  durationMs: number;
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
  /** M6: 'live', or 'safe' while the recorded backup run plays. */
  mode: SystemMode;
  /** Name of the recording playing in safe mode, else null. */
  recording: string | null;
  /** The supervisor policy in force (enabled=false: a crash stops everything). */
  supervisor: SupervisorPolicy;
  startedAt: string;
  resetting: boolean;
  resets: number;
  lastReset: (ResetResult & { at: string }) | { ok: false; error: string; at: string } | null;
}

/** What the control server drives: launch() provides the real one, tests a fake. */
export interface ResetController {
  status(): LauncherStatus;
  reset(): Promise<ResetResult>;
  /**
   * M6 safe mode. Validates the request and claims the busy slot (rejects with ResetBusyError /
   * RecordingNotFoundError / ModeRequestError before anything is stopped), runs the switch after
   * `delayMs`; `done` settles when the new system is ready. Absent = /safe-mode answers 404.
   */
  beginMode?(on: boolean, name: string | undefined, delayMs: number): Promise<{ done: Promise<ModeResult> }>;
}

/** POST /safe-mode named a recording that does not exist (or there is none at all): 404. */
export class RecordingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingNotFoundError';
  }
}

/** POST /safe-mode cannot be honoured in this configuration (e.g. BUS=kafka): 400. */
export class ModeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeRequestError';
  }
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
 * Entries of the data directory a reset never deletes. `booth` holds visitor leads and anonymous booth
 * analytics (services/booth): a demo reset must not lose the leads collected during the day. Delete them
 * on purpose with `npm run booth:clear-leads` (tools/launcher/clear-leads.ts).
 * M6: `recordings` holds the recorded backup runs (safe mode); a reset must never delete the safety net.
 */
export const PRESERVED_DATA_ENTRIES: readonly string[] = ['booth', 'recordings'];

/**
 * Delete the data directory (event log, ledger), except the entries in `keep` (default
 * PRESERVED_DATA_ENTRIES). Windows may keep a file handle for a moment after a process was killed, so
 * retry briefly instead of failing the reset.
 */
export function wipeDataDir(dataDir: string, rootDir: string, keep: readonly string[] = PRESERVED_DATA_ENTRIES): void {
  assertSafeToDelete(dataDir, rootDir);
  if (!existsSync(dataDir)) return;
  const kept = new Set(keep.map((k) => k.toLowerCase()));
  if (!readdirSync(dataDir).some((e) => kept.has(e.toLowerCase()))) {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    return;
  }
  for (const entry of readdirSync(dataDir)) {
    if (kept.has(entry.toLowerCase())) continue;
    rmSync(path.join(dataDir, entry), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

/** Recording names: file-name safe, same rule as the gateway's POST /api/control/safe-mode. */
export const RECORDING_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

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
    // Collect the (tiny) request body; only /safe-mode reads it.
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    req.on('data', (c: Buffer) => {
      bodyBytes += c.length;
      if (bodyBytes <= 64 * 1024) chunks.push(c);
    });
    const bodyDone = new Promise<string>((resolve) => {
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    if (url.pathname === '/safe-mode') {
      if (req.method !== 'POST') {
        json(405, { ok: false, error: 'use POST /safe-mode {"on": true|false, "name"?: string}' });
        return;
      }
      void (async () => {
        const raw = await bodyDone;
        let parsed: { on?: unknown; name?: unknown };
        try {
          parsed = raw.trim() ? (JSON.parse(raw) as typeof parsed) : {};
        } catch {
          json(400, { ok: false, error: 'body must be JSON {"on": boolean, "name"?: string}' });
          return;
        }
        if (typeof parsed.on !== 'boolean' || (parsed.name !== undefined && (typeof parsed.name !== 'string' || !RECORDING_NAME_RE.test(parsed.name)))) {
          json(400, { ok: false, error: 'body must be JSON {"on": boolean, "name"?: string}' });
          return;
        }
        if (!opts.controller.beginMode) {
          json(404, { ok: false, error: 'safe mode is not available' });
          return;
        }
        if (inFlight || opts.controller.status().resetting) {
          json(409, { ok: false, error: 'a reset or mode change is already running' });
          return;
        }
        const wait = url.searchParams.get('wait') !== '0' && url.searchParams.get('wait') !== 'false';
        try {
          const run = await opts.controller.beginMode(parsed.on, parsed.name as string | undefined, wait ? 0 : (opts.asyncGraceMs ?? 150));
          const p = run.done;
          inFlight = p;
          void p.then(
            () => undefined,
            () => undefined,
          ).finally(() => {
            if (inFlight === p) inFlight = null;
          });
          if (!wait) {
            json(202, { ok: true, accepted: true });
            p.then(
              (r) => log(`safe mode ${r.mode}${r.recording ? ` (${r.recording})` : ''} ready in ${r.durationMs} ms`),
              (e: unknown) => log(`mode change failed: ${(e as Error).message.split('\n')[0]}`),
            );
            return;
          }
          p.then(
            (r) => json(200, r),
            (e: unknown) => json(500, { ok: false, error: (e as Error).message }),
          );
        } catch (e) {
          if (e instanceof ResetBusyError) json(409, { ok: false, error: e.message });
          else if (e instanceof RecordingNotFoundError) json(404, { ok: false, error: e.message });
          else if (e instanceof ModeRequestError) json(400, { ok: false, error: e.message });
          else json(500, { ok: false, error: (e as Error).message });
        }
      })();
      return;
    }
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
    json(404, { ok: false, error: 'not found (GET /status, POST /reset, POST /safe-mode)' });
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
