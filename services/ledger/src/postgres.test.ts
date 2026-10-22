// Same behaviour suite against real Postgres in docker (postgres:17-alpine). Skipped gracefully
// when docker, the daemon or the image is unavailable. Set LEDGER_SKIP_DOCKER=1 to skip explicitly,
// or TEST_DATABASE_URL to use an existing (throwaway!) database instead of docker.
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORRIDOR_CASES, settledPayment } from './fixtures';
import { openLedgerStore, type LedgerStore } from './store';
import { storeSuite } from './store-suite';

const run = promisify(execFile);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function dockerAvailable(): Promise<boolean> {
  if (process.env.LEDGER_SKIP_DOCKER === '1') return false;
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const externalUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(externalUrl) || (await dockerAvailable());

describe.skipIf(!enabled)('ledger store (Postgres via docker)', () => {
  let store: LedgerStore | undefined;
  let container: string | undefined;
  let skipReason = '';

  beforeAll(async () => {
    let url = externalUrl;
    if (!url) {
      const port = await freePort();
      try {
        const { stdout } = await run(
          'docker',
          ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=pw', '-p', `127.0.0.1:${port}:5432`, 'postgres:17-alpine'],
          { timeout: 240_000 },
        );
        container = stdout.trim();
      } catch (err) {
        skipReason = `could not start postgres:17-alpine (${(err as Error).message.split('\n')[0]})`;
        return;
      }
      url = `postgres://postgres:pw@127.0.0.1:${port}/postgres`;
    }
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        store = await openLedgerStore({ databaseUrl: url });
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          skipReason = `postgres did not become ready: ${(err as Error).message}`;
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 300_000);

  afterAll(async () => {
    await store?.close();
    if (container) await run('docker', ['stop', '-t', '1', container], { timeout: 60_000 }).catch(() => {});
  }, 90_000);

  const getStore = (): LedgerStore => {
    if (!store) throw new Error(skipReason || 'postgres store not open');
    return store;
  };

  it('connects to Postgres and applies migrations', ({ skip }) => {
    if (!store) {
      console.warn(`[ledger postgres] skipped: ${skipReason}`);
      skip();
    }
    expect(store!.kind).toBe('postgres');
  });

  describe('suite', () => {
    storeSuite(getStore, () => !store);

    it('concurrent postings of different payments across a pool do not deadlock', async ({ skip }) => {
      if (!store) skip();
      const s = getStore();
      const before = await s.journalCount();
      const fixtures = Array.from({ length: 200 }, (_, i) => settledPayment(CORRIDOR_CASES[i % 3]!));
      await Promise.all(fixtures.flatMap((f) => [f, f]).map((f) => s.postSettlement({ paymentId: f.state.paymentId, causationEventId: f.settledEventId, state: f.state })));
      expect(await s.journalCount()).toBe(before + 200);
      expect((await s.invariants()).ok).toBe(true);
    });
  });
});
