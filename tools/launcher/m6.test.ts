import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SUPERVISOR_POLICY } from '@ct/contracts';
import { parseLauncherArgs } from './args';
import {
  ModeRequestError,
  PRESERVED_DATA_ENTRIES,
  RecordingNotFoundError,
  ResetBusyError,
  startControlServer,
  wipeDataDir,
  type ControlServerHandle,
  type LauncherStatus,
  type ModeResult,
  type ResetController,
} from './control';

describe('M6 CLI args', () => {
  const defaults = parseLauncherArgs([]);
  it('supervisor on and live by default; --no-supervise, --safe and --recording', () => {
    expect(defaults).toMatchObject({ supervise: true, safe: false, recording: undefined });
    expect(parseLauncherArgs(['--no-supervise']).supervise).toBe(false);
    expect(parseLauncherArgs(['--safe'])).toMatchObject({ safe: true, recording: undefined });
    expect(parseLauncherArgs(['--recording', 'day1'])).toMatchObject({ safe: true, recording: 'day1' });
    expect(() => parseLauncherArgs(['--recording', '../x'])).toThrow('recording name');
  });
  it('recordings are never wiped by a reset', () => {
    expect(PRESERVED_DATA_ENTRIES).toContain('recordings');
  });
});

describe('POST /safe-mode on the control server', () => {
  let server: ControlServerHandle | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function fake(behaviour: (on: boolean, name: string | undefined) => Promise<{ done: Promise<ModeResult> }>) {
    const calls: [boolean, string | undefined, number][] = [];
    const status: LauncherStatus = {
      services: [],
      startedAt: '2026-10-23T00:00:00.000Z',
      resetting: false,
      resets: 0,
      lastReset: null,
      mode: 'live',
      recording: null,
      supervisor: DEFAULT_SUPERVISOR_POLICY,
    };
    const controller: ResetController = {
      status: () => status,
      reset: () => Promise.reject(new Error('unused')),
      beginMode: (on, name, delay) => {
        calls.push([on, name, delay]);
        return behaviour(on, name);
      },
    };
    return { controller, calls };
  }
  const post = (url: string, body: unknown, query = '') =>
    fetch(`${url}/safe-mode${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const ok = (mode: 'live' | 'safe', recording: string | null): Promise<{ done: Promise<ModeResult> }> =>
    Promise.resolve({ done: Promise.resolve({ ok: true, mode, recording, durationMs: 5 }) });

  it('200 with the result; passes on/name through', async () => {
    const f = fake((on, name) => ok(on ? 'safe' : 'live', on ? (name ?? 'newest') : null));
    server = await startControlServer({ port: 0, controller: f.controller });
    const res = await post(server.url, { on: true, name: 'day1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'safe', recording: 'day1', durationMs: 5 });
    expect(f.calls).toEqual([[true, 'day1', 0]]);
  });

  it('400 for a bad body, 404 for an unknown recording, 409 when busy, 400 when unsupported', async () => {
    const f = fake((_on, name) => {
      if (name === 'missing') return Promise.reject(new RecordingNotFoundError('recording "missing" not found'));
      if (name === 'busy') return Promise.reject(new ResetBusyError());
      if (name === 'kafka') return Promise.reject(new ModeRequestError('needs the local broker'));
      return ok('safe', name ?? null);
    });
    server = await startControlServer({ port: 0, controller: f.controller });
    expect((await post(server.url, 'not json')).status).toBe(400);
    expect((await post(server.url, { on: 'true' })).status).toBe(400);
    expect((await post(server.url, { on: true, name: '../etc' })).status).toBe(400);
    expect((await post(server.url, { on: true, name: 'missing' })).status).toBe(404);
    expect((await post(server.url, { on: true, name: 'busy' })).status).toBe(409);
    expect((await post(server.url, { on: true, name: 'kafka' })).status).toBe(400);
    expect((await fetch(`${server.url}/safe-mode`)).status).toBe(405);
  });

  it('?wait=0 validates first (404 is still a 404), then answers 202 and runs the switch after the grace delay', async () => {
    let finish!: (r: ModeResult) => void;
    const f = fake((_on, name) =>
      name === 'missing'
        ? Promise.reject(new RecordingNotFoundError('nope'))
        : Promise.resolve({ done: new Promise<ModeResult>((r) => (finish = r)) }),
    );
    server = await startControlServer({ port: 0, controller: f.controller, asyncGraceMs: 20 });
    expect((await post(server.url, { on: true, name: 'missing' }, '?wait=0')).status).toBe(404);
    const res = await post(server.url, { on: true }, '?wait=0');
    expect(res.status).toBe(202);
    expect(f.calls.at(-1)).toEqual([true, undefined, 20]);
    // While it runs, a second request is refused.
    expect((await post(server.url, { on: false })).status).toBe(409);
    finish({ ok: true, mode: 'safe', recording: 'x', durationMs: 1 });
  });

  it('404 when the controller has no mode support', async () => {
    server = await startControlServer({ port: 0, controller: { status: () => fake(() => ok('live', null)).controller.status(), reset: () => Promise.reject(new Error('x')) } });
    expect((await post(server.url, { on: true })).status).toBe(404);
  });
});

describe('recordings survive resets, --reset and mode switches', () => {
  it('wipeDataDir keeps booth and recordings and deletes the rest', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ct-m6-wipe-'));
    try {
      const data = path.join(root, '.data');
      for (const d of ['booth', 'recordings', 'broker', 'ledger']) mkdirSync(path.join(data, d), { recursive: true });
      writeFileSync(path.join(data, 'recordings', 'day1.jsonl'), '{}\n');
      writeFileSync(path.join(data, 'recordings', 'day1.meta.json'), '{}');
      wipeDataDir(data, root);
      expect(readdirSync(data).sort()).toEqual(['booth', 'recordings']);
      expect(readdirSync(path.join(data, 'recordings')).sort()).toEqual(['day1.jsonl', 'day1.meta.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
