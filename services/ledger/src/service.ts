// Ledger service: the ledger pipeline stage (payment.settled -> ledger.posted) plus the read-only
// HTTP API defined in @ct/contracts ledger-api.ts.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EventBus } from '@ct/event-bus';
import { startStage, type StageHandle } from '@ct/stages';
import type { LedgerStore } from './store';

export interface LedgerServiceOptions {
  store: LedgerStore;
  /** When given, the ledger stage runs in this process. Omit to serve the HTTP API only. */
  bus?: EventBus;
  host?: string;
  /** 0 = pick a free port. */
  port?: number;
  stageDelayMs?: number;
  settlementDelayMs?: number;
  catchUpQuietMs?: number;
  log?: (line: string) => void;
}

export interface LedgerServiceHandle {
  port: number;
  /** Stops the stage and the HTTP server. The store and bus belong to the caller. */
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

export function ledgerRequestHandler(store: LedgerStore, log: (line: string) => void = () => {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const url = new URL(req.url ?? '/', 'http://ledger.local');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/health') return send(res, 200, { ok: true, journals: await store.journalCount(), driver: store.kind });
      if (path === '/ledger/trial-balance') return send(res, 200, await store.trialBalance());
      if (path === '/ledger/accounts') return send(res, 200, await store.accounts());
      if (path.startsWith('/ledger/accounts/')) {
        let accountId: string;
        try {
          accountId = decodeURIComponent(path.slice('/ledger/accounts/'.length));
        } catch {
          return send(res, 400, { error: 'bad account id encoding' });
        }
        const account = await store.account(accountId);
        return account ? send(res, 200, account) : send(res, 404, { error: `unknown account ${accountId}` });
      }
      if (path === '/ledger/journals') {
        const paymentId = url.searchParams.get('paymentId') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? '50');
        return send(res, 200, await store.journals({ paymentId, limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50 }));
      }
      if (path === '/ledger/invariants') return send(res, 200, await store.invariants());
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log(`[ledger] http error ${req.method} ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    }
  };
}

export async function startLedgerService(options: LedgerServiceOptions): Promise<LedgerServiceHandle> {
  const log = options.log ?? (() => {});
  const handler = ledgerRequestHandler(options.store, log);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let stage: StageHandle | undefined;
  if (options.bus) {
    try {
      stage = await startStage('ledger', {
        bus: options.bus,
        services: { ledger: options.store },
        stageDelayMs: options.stageDelayMs ?? 0,
        settlementDelayMs: options.settlementDelayMs ?? 0,
        catchUpQuietMs: options.catchUpQuietMs,
        log,
      });
    } catch (err) {
      server.close();
      throw err;
    }
  }

  let closing: Promise<void> | undefined;
  return {
    port,
    close: () =>
      (closing ??= (async () => {
        await stage?.stop();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })()),
  };
}
