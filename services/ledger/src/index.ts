// @ct/ledger: double-entry ledger. Library exports + CLI (tsx services/ledger/src/index.ts).
//   DATABASE_URL set   -> node-postgres
//   otherwise          -> embedded PGlite under ${DATA_DIR}/ledger
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig, type ServiceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { startLedgerService } from './service';
import { openLedgerStore, type LedgerStore } from './store';

export {
  openLedgerStore,
  createInMemoryLedger,
  toSafeInt,
  type LedgerStore,
  type PostJournalInput,
  type PostResult,
  type SettlementInput,
  type InvariantReport,
} from './store';
export { startLedgerService, ledgerRequestHandler, type LedgerServiceOptions, type LedgerServiceHandle } from './service';
export { settlementEntries, assertPostable, journalIdFor, LEDGER_RULE_VERSION } from './posting';
export { CHART_OF_ACCOUNTS, classifyAccount, accountIds, type AccountRule, type AccountSpec } from './chart';
export { MIGRATIONS, migrate, type Migration } from './migrations';
export { openDriver, type SqlDriver, type Queryable, type DriverOptions } from './driver';

/** Open the store selected by config: Postgres when DATABASE_URL is set, else PGlite in `${dataDir}/ledger`. */
export function openConfiguredLedger(config: ServiceConfig = serviceConfig()): Promise<LedgerStore> {
  return config.databaseUrl ? openLedgerStore({ databaseUrl: config.databaseUrl }) : openLedgerStore({ dataDir: join(config.dataDir, 'ledger') });
}

async function main(): Promise<void> {
  const config = serviceConfig();
  const store = await openConfiguredLedger(config);
  const where = store.kind === 'postgres' ? 'postgres (DATABASE_URL)' : `pglite ${join(config.dataDir, 'ledger')}`;
  let bus: Awaited<ReturnType<typeof createBus>>;
  try {
    bus = await createBus(config, 'ledger');
  } catch (err) {
    await store.close();
    throw err;
  }
  const service = await startLedgerService({
    store,
    bus,
    host: config.host,
    port: config.ledgerPort,
    stageDelayMs: config.stageDelayMs,
    settlementDelayMs: config.settlementDelayMs,
    log: (line) => console.log(line),
  });
  console.log(`[ledger] ready on http://${config.host}:${service.port} (bus=${config.bus}, store=${where}, journals=${await store.journalCount()})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ledger] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await service.close();
      await bus.close();
      await store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  exitWithSupervisor(shutdown);
}

const entry = process.argv[1];
if (entry && resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((err) => {
    console.error('[ledger] fatal:', err);
    process.exit(1);
  });
}
