import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResetBusyError,
  startControlServer,
  wipeDataDir,
  type ControlServerHandle,
  type LauncherStatus,
  type ResetController,
  type ResetResult,
} from './control';

/**
 * A fake system: services are flags, reset() "stops" them, wipes a real temp data dir with the real
 * wipeDataDir (same safety checks as the launcher), "starts" them again after a delay.
 */
function fakeSystem(opts: { dataDir: string; rootDir: string; startMs?: number; failStart?: boolean }) {
  const names = ['broker', 'payment-api', 'ledger', 'orchestrator', 'gateway'];
  const running = new Map(names.map((n) => [n, true]));
  let resetting = false;
  let resets = 0;
  let lastReset: LauncherStatus['lastReset'] = null;
  const log: string[] = [];
  const controller: ResetController = {
    status: () => ({
      services: names.map((name) => ({ name, running: running.get(name)! })),
      startedAt: '2026-10-23T00:00:00.000Z',
      resetting,
      resets,
      lastReset,
    }),
    reset: async (): Promise<ResetResult> => {
      if (resetting) throw new ResetBusyError();
      resetting = true;
      const t0 = Date.now();
      try {
        for (const n of names) running.set(n, false);
        log.push('stopped');
        wipeDataDir(opts.dataDir, opts.rootDir);
        log.push('wiped');
        await new Promise((r) => setTimeout(r, opts.startMs ?? 50));
        if (opts.failStart) throw new Error('[ledger] exited during startup');
        for (const n of names) running.set(n, true);
        log.push('started');
        resets += 1;
        const r: ResetResult = { ok: true, durationMs: Date.now() - t0, phases: { stopMs: 1, wipeMs: 1, startMs: opts.startMs ?? 50 }, ready: {}, resets };
        lastReset = { ...r, at: new Date().toISOString() };
        return r;
      } finally {
        resetting = false;
      }
    },
  };
  return { controller, running, log };
}

const tmp: string[] = [];
let server: ControlServerHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox(): { rootDir: string; dataDir: string } {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ct-control-'));
  tmp.push(rootDir);
  const dataDir = path.join(rootDir, '.data');
  mkdirSync(path.join(dataDir, 'ledger'), { recursive: true });
  writeFileSync(path.join(dataDir, 'events.jsonl'), '{"x":1}\n');
  writeFileSync(path.join(dataDir, 'ledger', 'pg'), 'x');
  return { rootDir, dataDir };
}

const post = (url: string) => fetch(url, { method: 'POST' });

describe('launcher control server', () => {
  it('GET /status lists the services', async () => {
    const box = sandbox();
    const fake = fakeSystem(box);
    server = await startControlServer({ port: 0, controller: fake.controller });
    const res = await fetch(`${server.url}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LauncherStatus;
    expect(body.services.map((s) => s.name)).toContain('gateway');
    expect(body.services.every((s) => s.running)).toBe(true);
    expect(body).toMatchObject({ resetting: false, resets: 0, lastReset: null });
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/reset`)).status).toBe(405);
  });

  it('POST /reset stops, wipes the data dir, starts again and reports the duration', async () => {
    const box = sandbox();
    const fake = fakeSystem(box);
    server = await startControlServer({ port: 0, controller: fake.controller });
    const res = await post(`${server.url}/reset`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(true);
    expect(body.durationMs).toBeGreaterThanOrEqual(40);
    expect(body.resets).toBe(1);
    expect(fake.log).toEqual(['stopped', 'wiped', 'started']);
    expect(existsSync(box.dataDir)).toBe(false);
    expect(existsSync(box.rootDir)).toBe(true);
    const st = (await (await fetch(`${server.url}/status`)).json()) as LauncherStatus;
    expect(st.resets).toBe(1);
    expect(st.lastReset).toMatchObject({ ok: true });
  });

  it('rejects a concurrent reset with 409', async () => {
    const box = sandbox();
    const fake = fakeSystem({ ...box, startMs: 300 });
    server = await startControlServer({ port: 0, controller: fake.controller });
    const first = post(`${server.url}/reset`);
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(`${server.url}/reset`);
    expect(second.status).toBe(409);
    const st = (await (await fetch(`${server.url}/status`)).json()) as LauncherStatus;
    expect(st.resetting).toBe(true);
    expect((await first).status).toBe(200);
    // Free again afterwards.
    expect((await post(`${server.url}/reset`)).status).toBe(200);
  });

  it('?wait=0 answers 202 at once, runs the reset in the background, and still refuses a second one', async () => {
    const box = sandbox();
    const fake = fakeSystem({ ...box, startMs: 200 });
    server = await startControlServer({ port: 0, controller: fake.controller, asyncGraceMs: 20 });
    const res = await post(`${server.url}/reset?wait=0`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    expect((await post(`${server.url}/reset`)).status).toBe(409);
    const deadline = Date.now() + 3000;
    while (!fake.log.includes('started') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(fake.log).toEqual(['stopped', 'wiped', 'started']);
  });

  it('reports a failed reset as 500', async () => {
    const box = sandbox();
    const fake = fakeSystem({ ...box, failStart: true });
    server = await startControlServer({ port: 0, controller: fake.controller });
    const res = await post(`${server.url}/reset`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/ledger/);
  });

  it('refuses to wipe the repo root or a parent of it (the reset fails, nothing is deleted)', async () => {
    const box = sandbox();
    const fake = fakeSystem({ dataDir: box.rootDir, rootDir: box.rootDir });
    server = await startControlServer({ port: 0, controller: fake.controller });
    const res = await post(`${server.url}/reset`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/Refusing/);
    expect(existsSync(path.join(box.dataDir, 'events.jsonl'))).toBe(true);
    expect(() => wipeDataDir(path.dirname(box.rootDir), box.rootDir)).toThrow(/Refusing/);
    expect(() => wipeDataDir(path.parse(box.rootDir).root, box.rootDir)).toThrow(/Refusing/);
    // A data dir that does not exist (yet) is fine.
    expect(() => wipeDataDir(path.join(box.rootDir, 'never-created'), box.rootDir)).not.toThrow();
  });

  it('M5: a reset keeps DATA_DIR/booth (visitor leads) and deletes everything else', async () => {
    const box = sandbox();
    mkdirSync(path.join(box.dataDir, 'booth'), { recursive: true });
    writeFileSync(path.join(box.dataDir, 'booth', 'leads'), 'lead');
    const fake = fakeSystem(box);
    server = await startControlServer({ port: 0, controller: fake.controller });
    expect((await post(`${server.url}/reset`)).status).toBe(200);
    expect(readdirSync(box.dataDir)).toEqual(['booth']);
    expect(readFileSync(path.join(box.dataDir, 'booth', 'leads'), 'utf8')).toBe('lead');
    // An explicit empty keep list deletes the whole directory (used by nothing but tests).
    wipeDataDir(box.dataDir, box.rootDir, []);
    expect(existsSync(box.dataDir)).toBe(false);
  });
});
