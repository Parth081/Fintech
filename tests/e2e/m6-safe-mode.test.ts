// M6: safe mode. POST /safe-mode swaps the live pipeline for a recorded backup run (broker + gateway + booth,
// the recording looped into a fresh log) and back. Leads survive, the mode is visible in /status and in the
// gateway's /health, nothing live runs in safe mode, nothing is left behind. Ports 38120-38139.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { happyPath } from '@ct/contracts/testing';
import type { BusEvent, PaymentState } from '@ct/contracts';
import { launch, type LaunchedSystem } from '../../tools/launcher/launch';
import { isPortFree } from '../../tools/launcher/ports';
import type { LauncherStatus, ModeResult } from '../../tools/launcher/control';
import { buildMeta } from '../../tools/booth/record';

const dataDir = mkdtempSync(join(tmpdir(), 'ct-e2e-m6safe-'));
const PORTS = { broker: 38120, paymentApi: 38121, gateway: 38122, ledger: 38123, orchestrator: 38124, ops: 38125, assistant: 38126, booth: 38127 };
const CONTROL = 38129;
let system: LaunchedSystem;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, what: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const control = (path: string, init?: RequestInit) => fetch(`${system.urls.control}${path}`, init);
const safe = (body: unknown, query = '') => control(`/safe-mode${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getStatus = async () => (await (await control('/status')).json()) as LauncherStatus;
const health = async () => (await (await fetch(`${system.urls.gateway}/health`)).json()) as { mode?: string; recording?: string | null; payments: number; events: number };
const leads = async () => (await (await fetch(`${system.urls.booth}/leads`, { headers: { 'x-booth-staff': '2468' } })).json()) as { email: string }[];

/** A tiny synthetic recording: two payments, 300 ms between events. */
function writeFixture(name: string): void {
  const t0 = Date.parse('2026-10-20T10:00:00.000Z');
  const events: BusEvent[] = [];
  for (let p = 0; p < 2; p++) {
    happyPath().forEach((e, i) => events.push({ ...e, occurredAt: new Date(t0 + (p * 10 + i) * 300).toISOString() } as BusEvent));
  }
  const dir = join(dataDir, 'recordings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(buildMeta(name, events, null, new Date().toISOString())));
}

describe('M6 launcher: safe mode (recorded backup run)', () => {
  beforeAll(async () => {
    system = await launch({
      host: '127.0.0.1',
      ports: PORTS,
      controlPort: CONTROL,
      dataDir,
      stageDelayMs: 0,
      settlementDelayMs: 0,
      ambientRate: 0,
      quiet: true,
      startupTimeoutMs: 90_000,
      buildWeb: false,
      orchestrator: false,
      ops: false,
      assistant: false,
      supervisor: { enabled: true, backoffMs: 100, maxBackoffMs: 400 },
    });
  }, 120_000);
  afterAll(async () => {
    await system?.stop();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);

  it('rejects bad requests and answers 404 (stopping nothing) when there is no such recording', async () => {
    expect((await safe({ on: 'yes' })).status).toBe(400);
    expect((await control('/safe-mode', { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await control('/safe-mode')).status).toBe(405);
    expect((await safe({ on: true })).status).toBe(404); // no recordings at all
    writeFixture('fixture');
    const res = await safe({ on: true, name: 'does-not-exist' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('does-not-exist');
    const st = await getStatus();
    expect(st.mode).toBe('live');
    expect(st.services.every((s) => s.running)).toBe(true);
    await expect(system.setMode({ on: true, name: 'nope' })).rejects.toThrow('not found');
  }, 60_000);

  it('on: the recording plays on the same ports, only broker + gateway + booth run, leads are kept', async () => {
    const lead = await fetch(`${system.urls.booth}/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test Visitor', company: 'Example', email: 'visitor@example.com', interest: 'other', consent: true, consentText: 'I agree to be contacted about this demo.' }),
    });
    expect(lead.status).toBeLessThan(300);

    const t0 = Date.now();
    const pending = safe({ on: true });
    await sleep(100);
    expect((await safe({ on: false })).status).toBe(409); // a mode change is running
    expect((await control('/reset', { method: 'POST' })).status).toBe(409);
    const res = await pending;
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModeResult;
    console.log(`safe mode on took ${body.durationMs} ms`);
    expect(body).toMatchObject({ ok: true, mode: 'safe', recording: 'fixture' });
    expect(elapsed).toBeLessThan(20_000); // the 10 s target is enforced by verify:m6 on a quiet machine

    const st = await getStatus();
    expect(st).toMatchObject({ mode: 'safe', recording: 'fixture', resetting: false });
    expect(st.services.map((s) => s.name).sort()).toEqual(['booth', 'broker', 'gateway']);
    expect(st.services.every((s) => s.running)).toBe(true);
    expect(system.mode()).toBe('safe');

    const h = await health();
    expect(h.mode).toBe('safe');
    expect(h.recording).toBe('fixture');
    await until(async () => (await health()).payments >= 1, 'recorded payments on the gateway');

    // Nothing live exists: the live ports are free again, sending a payment fails.
    for (const port of [PORTS.paymentApi, PORTS.ledger]) expect(await isPortFree(port)).toBe(true);
    const send = await fetch(`${system.urls.gateway}/api/payments/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(send.status).toBeGreaterThanOrEqual(400);

    expect((await leads()).map((l) => l.email)).toContain('visitor@example.com');
    expect(existsSync(join(dataDir, 'recordings', 'fixture.jsonl'))).toBe(true);
  }, 90_000);

  it('on again is a no-op; a crashed gateway is restarted and stays in safe mode; a reset keeps the safe run', async () => {
    const again = await safe({ on: true });
    expect(again.status).toBe(200);
    expect(((await again.json()) as ModeResult).durationMs).toBe(0);

    await system.crash('gateway');
    await until(() => system.isRunning('gateway') && system.health().find((h) => h.name === 'gateway')!.restarts === 1, 'gateway restarted');
    await until(async () => (await fetch(`${system.urls.gateway}/health`).catch(() => ({ status: 0 }))).status === 200, 'gateway healthy');
    expect((await health()).mode).toBe('safe');
    await until(async () => (await health()).payments >= 1, 'recorded payments again after the gateway restart');

    const r = await control('/reset', { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await getStatus()).mode).toBe('safe');
    expect((await health()).recording).toBe('fixture');
    await until(async () => (await health()).payments >= 1, 'recording replayed after reset');
    expect((await leads()).map((l) => l.email)).toContain('visitor@example.com');
  }, 120_000);

  it('off: back to a fresh live system; payments complete, leads and the recording survive', async () => {
    const res = await safe({ on: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModeResult;
    console.log(`safe mode off took ${body.durationMs} ms`);
    expect(body).toMatchObject({ ok: true, mode: 'live', recording: null });
    const st = await getStatus();
    expect(st).toMatchObject({ mode: 'live', recording: null });
    expect(st.services.map((s) => s.name).sort()).toEqual(
      ['booth', 'broker', 'gateway', 'ledger', 'payment-api', 'reconciliation', 'risk', 'routing', 'screening', 'settlement', 'fx'].sort(),
    );
    expect(st.services.every((s) => s.running)).toBe(true);
    const h = await health();
    expect(h.mode).toBe('live');
    expect(h.payments).toBe(0); // fresh

    const sample = await fetch(`${system.urls.gateway}/api/payments/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const id = ((await sample.json()) as { paymentId: string }).paymentId;
    await until(async () => {
      const r = await fetch(`${system.urls.gateway}/api/payments/${id}`);
      return r.status === 200 && ((await r.json()) as { state: PaymentState }).state.status === 'reconciled';
    }, 'live payment reconciled');
    expect((await leads()).map((l) => l.email)).toContain('visitor@example.com');
    expect(existsSync(join(dataDir, 'recordings', 'fixture.jsonl'))).toBe(true);
    expect((await safe({ on: false })).status).toBe(200); // already live: no-op
  }, 120_000);

  it('stopping while in safe mode leaves no process behind', async () => {
    expect((await safe({ on: true, name: 'fixture' })).status).toBe(200);
    await system.stop();
    for (const port of [...Object.values(PORTS), CONTROL]) expect(await isPortFree(port)).toBe(true);
    for (const n of system.services) expect(system.isRunning(n)).toBe(false);
  }, 90_000);
});
