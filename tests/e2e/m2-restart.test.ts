// M2: the launcher can kill and restart single services (chaos), a payment that arrives while a stage
// is down completes once it is back, the ledger service runs as its own process, and the broker log
// holds no duplicate eventIds afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyEvent, PaymentState } from '@ct/contracts';
import { launch, type LaunchedSystem } from '../../tools/launcher/launch';

const dataDir = mkdtempSync(join(tmpdir(), 'ct-e2e-m2-'));
let system: LaunchedSystem;

async function post(path: string, body: unknown = {}): Promise<{ paymentId: string }> {
  const res = await fetch(`${system.urls.gateway}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as { paymentId: string };
}

async function status(paymentId: string): Promise<string | undefined> {
  const res = await fetch(`${system.urls.gateway}/api/payments/${paymentId}`);
  if (res.status !== 200) return undefined;
  return ((await res.json()) as { state: PaymentState }).state.status;
}

async function waitStatus(paymentId: string, want: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await status(paymentId)) !== want) {
    if (Date.now() > deadline) throw new Error(`${paymentId} did not reach ${want} (is ${await status(paymentId)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('M2 launcher: ledger service, kill/restart', () => {
  beforeAll(async () => {
    system = await launch({
      host: '127.0.0.1',
      ports: { broker: 18170, paymentApi: 18171, gateway: 18172 },
      dataDir,
      stageDelayMs: 0,
      settlementDelayMs: 0,
      quiet: true,
      buildWeb: false,
    });
  }, 120_000);
  afterAll(async () => {
    await system?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('runs the ledger as a service on gateway + 1 and no ledger stage', async () => {
    expect(system.urls.ledger).toBe('http://127.0.0.1:18173');
    expect(system.services).toContain('ledger');
    expect((await fetch(`${system.urls.ledger}/health`)).status).toBe(200);
  });

  it('a payment sent while a stage is down completes after restart(); no duplicate events', async () => {
    const first = await post('/api/payments/sample');
    await waitStatus(first.paymentId, 'reconciled');

    await system.kill('fx');
    expect(system.isRunning('fx')).toBe(false);
    const p = await post('/api/payments/sample');
    await waitStatus(p.paymentId, 'scored');
    await new Promise((r) => setTimeout(r, 300));
    expect(await status(p.paymentId)).toBe('scored'); // stuck at fx while it is down

    await system.restart('fx');
    expect(system.isRunning('fx')).toBe(true);
    await waitStatus(p.paymentId, 'reconciled');

    // Restart a running service too (the ledger), then one more payment end to end.
    await system.restart('ledger');
    const q = await post('/api/payments/sample');
    await waitStatus(q.paymentId, 'reconciled');

    const broker = system.urls.broker.replace(/^ws/, 'http');
    const events = (await (await fetch(`${broker}/events?from=0&limit=5000`)).json()) as { event: AnyEvent }[];
    const ids = events.map((e) => e.event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const journals = (await (await fetch(`${system.urls.ledger}/ledger/journals?paymentId=${p.paymentId}`)).json()) as unknown[];
    expect(journals).toHaveLength(1);
  }, 90_000);
});
