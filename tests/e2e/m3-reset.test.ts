// M3: the launcher starts the orchestrator, serves the control API and resets the whole system in a
// few seconds (stop everything, delete the data dir, start again). Stopping during a reset leaves no
// process behind.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, type LaunchedSystem } from '../../tools/launcher/launch';
import { isPortFree } from '../../tools/launcher/ports';
import type { LauncherStatus, ResetResult } from '../../tools/launcher/control';

const dataDir = mkdtempSync(join(tmpdir(), 'ct-e2e-m3-'));
const PORTS = { broker: 19170, paymentApi: 19171, gateway: 19172, ledger: 19173, orchestrator: 19174 };
const CONTROL = 19179;
let system: LaunchedSystem;

async function status(paymentId: string): Promise<string | undefined> {
  const res = await fetch(`${system.urls.gateway}/api/payments/${paymentId}`);
  if (res.status !== 200) return undefined;
  return ((await res.json()) as { state: { status: string } }).state.status;
}

async function waitStatus(paymentId: string, want: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await status(paymentId)) !== want) {
    if (Date.now() > deadline) throw new Error(`${paymentId} did not reach ${want} (is ${await status(paymentId)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function samplePayment(): Promise<string> {
  const res = await fetch(`${system.urls.gateway}/api/payments/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return ((await res.json()) as { paymentId: string }).paymentId;
}

async function brokerEvents(): Promise<number> {
  const broker = system.urls.broker.replace(/^ws/, 'http');
  return ((await (await fetch(`${broker}/health`)).json()) as { events: number }).events;
}

describe('M3 launcher: orchestrator, control API, 10-second reset', () => {
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
      buildWeb: false,
    });
  }, 120_000);
  afterAll(async () => {
    await system?.stop();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);

  it('runs the orchestrator and the control API', async () => {
    expect(system.services).toContain('orchestrator');
    expect(system.urls.orchestrator).toBe('http://127.0.0.1:19174');
    expect(system.urls.control).toBe('http://127.0.0.1:19179');
    expect((await fetch(`${system.urls.orchestrator}/health`)).status).toBe(200);
    const st = (await (await fetch(`${system.urls.control}/status`)).json()) as LauncherStatus;
    expect(st.services.map((s) => s.name).sort()).toEqual([...system.services].sort());
    expect(st.services.every((s) => s.running)).toBe(true);
    expect(st.resetting).toBe(false);
  });

  it('POST /reset wipes the log and the ledger and brings everything back', async () => {
    const before = await samplePayment();
    await waitStatus(before, 'reconciled');
    expect(await brokerEvents()).toBeGreaterThan(0);

    const t0 = Date.now();
    const pending = fetch(`${system.urls.control}/reset`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 100));
    expect((await fetch(`${system.urls.control}/reset`, { method: 'POST' })).status).toBe(409);
    const res = await pending;
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetResult;
    expect(body.ok).toBe(true);
    // The 10 s target is enforced by verify:m3 on a quiet machine; here other e2e files start their own
    // systems in parallel (3x the processes), so only a loose bound.
    console.log(`reset took ${body.durationMs} ms (stop ${body.phases.stopMs}, wipe ${body.phases.wipeMs}, start ${body.phases.startMs})`);
    expect(body.durationMs).toBeLessThan(30_000);
    expect(elapsed).toBeGreaterThanOrEqual(body.durationMs);
    expect(Object.keys(body.ready).sort()).toEqual([...system.services].sort());

    // Fresh system: old payment gone, log (nearly) empty, ledger empty, every service healthy.
    expect((await fetch(`${system.urls.gateway}/health`)).status).toBe(200);
    expect(await status(before)).toBeUndefined();
    expect(await brokerEvents()).toBeLessThan(5);
    const tb = (await (await fetch(`${system.urls.ledger}/ledger/trial-balance`)).json()) as { journals: number };
    expect(tb.journals).toBe(0);
    for (const name of system.services) expect(system.isRunning(name)).toBe(true);

    // And it works afterwards.
    const after = await samplePayment();
    await waitStatus(after, 'reconciled');
  }, 90_000);

  it('the launch() handle resets too, and stop() during a reset leaves no process behind', async () => {
    const r = await system.reset();
    expect(r.resets).toBe(2);
    expect(system.status().lastReset).toMatchObject({ ok: true });

    const inFlight = system.reset();
    inFlight.catch(() => undefined);
    await new Promise((res) => setTimeout(res, 1500)); // mid-start: some services up, the ledger still booting
    await system.stop();
    await expect(inFlight).rejects.toThrow();
    for (const port of [...Object.values(PORTS), CONTROL]) expect(await isPortFree(port)).toBe(true);
    for (const name of system.services) expect(system.isRunning(name)).toBe(false);
  }, 90_000);
});
