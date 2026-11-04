// M6: the launcher's self-healing supervisor. A service that crashes after startup is restarted (same ports,
// same env) with exponential backoff; stages and the ledger resume from the durable log, clients reconnect
// to a restarted broker. Intentional kills and resets are not crashes. Too many crashes stop everything and
// name the failing service. Ports 38100-38119.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyEvent, PaymentState } from '@ct/contracts';
import { launch, type LaunchedSystem } from '../../tools/launcher/launch';
import { isPortFree } from '../../tools/launcher/ports';
import type { LauncherStatus } from '../../tools/launcher/control';

const dataDir = mkdtempSync(join(tmpdir(), 'ct-e2e-m6sup-'));
const dataDir2 = mkdtempSync(join(tmpdir(), 'ct-e2e-m6sup2-'));
const PORTS = { broker: 38100, paymentApi: 38101, gateway: 38102, ledger: 38103, orchestrator: 38104, ops: 38105, assistant: 38106, booth: 38107 };
const CONTROL = 38109;
const PORTS2 = { broker: 38110, paymentApi: 38111, gateway: 38112, ledger: 38113, orchestrator: 38114, ops: 38115, assistant: 38116, booth: 38117 };
const CONTROL2 = 38119;
const common = { host: '127.0.0.1', stageDelayMs: 0, settlementDelayMs: 0, ambientRate: 0, quiet: true, startupTimeoutMs: 90_000, buildWeb: false, orchestrator: false, ops: false, assistant: false, booth: false } as const;
let system: LaunchedSystem;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, what: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const post = async (): Promise<string> => {
  const res = await fetch(`${system.urls.gateway}/api/payments/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return ((await res.json()) as { paymentId: string }).paymentId;
};
async function status(id: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${system.urls.gateway}/api/payments/${id}`);
    return res.status === 200 ? ((await res.json()) as { state: PaymentState }).state.status : undefined;
  } catch {
    return undefined;
  }
}
const waitStatus = (id: string, want: string) => until(async () => (await status(id)) === want, `${id} -> ${want}`);
const restartsOf = (name: string) => system.health().find((h) => h.name === name)!.restarts;

describe('M6 launcher supervisor', () => {
  beforeAll(async () => {
    system = await launch({
      ...common,
      ports: PORTS,
      controlPort: CONTROL,
      dataDir,
      supervisor: { enabled: true, backoffMs: 100, maxBackoffMs: 400, maxRestarts: 5, windowMs: 120_000 },
    });
  }, 120_000);
  afterAll(async () => {
    await system?.stop();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(dataDir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);

  it('a crashed stage is restarted; the payment that waited for it completes; no duplicate events', async () => {
    const first = await post();
    await waitStatus(first, 'reconciled');

    await system.crash('fx');
    const p = await post();
    await until(() => system.isRunning('fx') && restartsOf('fx') === 1, 'fx restarted');
    await waitStatus(p, 'reconciled');

    const h = system.health().find((x) => x.name === 'fx')!;
    expect(h.restarts).toBe(1);
    expect(h.lastRestartAt).not.toBeNull();
    expect(h.lastExit).not.toBeNull();
    expect(system.health().filter((x) => x.name !== 'fx').every((x) => x.restarts === 0 && x.running)).toBe(true);

    const broker = system.urls.broker.replace(/^ws/, 'http');
    const events = (await (await fetch(`${broker}/events?from=0&limit=5000`)).json()) as { event: AnyEvent }[];
    const ids = events.map((e) => e.event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const journals = (await (await fetch(`${system.urls.ledger}/ledger/journals?paymentId=${p}`)).json()) as unknown[];
    expect(journals).toHaveLength(1);
  }, 90_000);

  it('GET /status of the control API exposes mode, supervisor and per-service restarts', async () => {
    const st = (await (await fetch(`${system.urls.control}/status`)).json()) as LauncherStatus;
    expect(st.mode).toBe('live');
    expect(st.recording).toBeNull();
    expect(st.supervisor.enabled).toBe(true);
    expect(st.services.find((s) => s.name === 'fx')).toMatchObject({ running: true, restarts: 1 });
  });

  it('a crashed ledger resumes from the log (one journal per payment)', async () => {
    await system.crash('ledger');
    await until(() => system.isRunning('ledger') && restartsOf('ledger') === 1, 'ledger restarted');
    await until(async () => (await fetch(`${system.urls.ledger}/health`).catch(() => ({ status: 0 }))).status === 200, 'ledger healthy');
    const p = await post();
    await waitStatus(p, 'reconciled');
    const journals = (await (await fetch(`${system.urls.ledger}/ledger/journals?paymentId=${p}`)).json()) as unknown[];
    expect(journals).toHaveLength(1);
  }, 90_000);

  it('a crashed broker comes back; every client reconnects and payments complete again', async () => {
    await system.crash('broker');
    await until(() => system.isRunning('broker') && restartsOf('broker') === 1, 'broker restarted');
    await until(async () => (await fetch(`${system.urls.broker.replace(/^ws/, 'http')}/health`).catch(() => ({ status: 0 }))).status === 200, 'broker healthy');
    const p = await post();
    await waitStatus(p, 'reconciled');
    for (const n of system.services) expect(system.isRunning(n)).toBe(true);
  }, 90_000);

  it('a crashed gateway is restarted (new instance) and serves again', async () => {
    const before = (await (await fetch(`${system.urls.gateway}/health`)).json()) as { instanceId: string };
    await system.crash('gateway');
    await until(() => system.isRunning('gateway') && restartsOf('gateway') === 1, 'gateway restarted');
    await until(async () => (await fetch(`${system.urls.gateway}/health`).catch(() => ({ status: 0 }))).status === 200, 'gateway healthy');
    const after = (await (await fetch(`${system.urls.gateway}/health`)).json()) as { instanceId: string };
    expect(after.instanceId).not.toBe(before.instanceId);
    const p = await post();
    await waitStatus(p, 'reconciled');
  }, 90_000);

  it('intentional kill/restart and a reset are not crashes: nothing is restarted behind your back or counted', async () => {
    const counts = () => Object.fromEntries(system.health().map((h) => [h.name, h.restarts]));
    const before = counts();
    await system.kill('screening');
    await sleep(1500); // longer than the backoff: a crash would have been restarted by now
    expect(system.isRunning('screening')).toBe(false);
    await system.restart('screening');
    expect(system.isRunning('screening')).toBe(true);
    await system.reset();
    for (const n of system.services) expect(system.isRunning(n)).toBe(true);
    expect(counts()).toEqual(before);
    const p = await post();
    await waitStatus(p, 'reconciled');
  }, 90_000);

  it('repeated crashes exceed the policy: everything stops and the failing service is named; no orphans', async () => {
    let failure: Error | undefined;
    const sys2 = await launch({
      ...common,
      ports: PORTS2,
      controlPort: CONTROL2,
      dataDir: dataDir2,
      supervisor: { enabled: true, backoffMs: 50, maxBackoffMs: 100, maxRestarts: 2, windowMs: 120_000 },
      onUnexpectedExit: (e) => {
        failure = e;
      },
    });
    try {
      const deadline = Date.now() + 60_000;
      while (!failure && Date.now() < deadline) {
        if (sys2.isRunning('risk')) await sys2.crash('risk');
        await sleep(200);
      }
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/\[risk\]/);
      expect(failure!.message).toMatch(/keeps failing/);
      expect(sys2.health().find((h) => h.name === 'risk')!.restarts).toBe(2);
      for (const n of sys2.services) expect(sys2.isRunning(n)).toBe(false);
      for (const port of [...Object.values(PORTS2), CONTROL2]) expect(await isPortFree(port)).toBe(true);
    } finally {
      await sys2.stop();
    }
  }, 120_000);

  it('without the supervisor (the default of launch()) a crash stops everything, as before', async () => {
    let failure: Error | undefined;
    const sys3 = await launch({ ...common, ports: PORTS2, controlPort: CONTROL2, dataDir: dataDir2, onUnexpectedExit: (e) => { failure = e; } });
    try {
      expect(sys3.supervisorPolicy().enabled).toBe(false);
      await sys3.crash('risk');
      await until(() => failure !== undefined, 'launcher to give up');
      expect(failure!.message).toContain('Service [risk] exited unexpectedly');
      for (const n of sys3.services) expect(sys3.isRunning(n)).toBe(false);
    } finally {
      await sys3.stop();
    }
  }, 120_000);
});
