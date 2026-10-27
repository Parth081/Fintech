// @ct/ops: the Operations service (back office API). Library exports + CLI (tsx services/ops/src/index.ts).
//   DATABASE_URL set   -> node-postgres, tables in schema "ops" (can share the ledger's database)
//   otherwise          -> embedded PGlite under ${DATA_DIR}/ops
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig, type ServiceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { startOps } from './service';
import { OpsStore } from './store';

export { startOps, matchesEvent, OPS_RULE_VERSION, type OpsOptions, type OpsHandle } from './service';
export { OpsStore, slaDue, type CaseRow, type RefundRequest, type BreakRow, type AuditFilter } from './store';
export { OpsProjection, approxUsd } from './projection';
export { DEMO_USERS, findUser, permissionsOf, hasPermission, actorOf, SLA_MINUTES, needsFourEyes } from './users';
export { validateConfigValue, isConfigKey, CONFIG_KEYS } from './config-validation';
export { toCsv, csvCell } from './csv';
export { MIGRATIONS, migrate, openDriver, type SqlDriver } from './db';

/** Postgres when DATABASE_URL is set, else PGlite in `${dataDir}/ops`. */
export function openConfiguredOpsStore(config: ServiceConfig = serviceConfig()): Promise<OpsStore> {
  return config.databaseUrl ? OpsStore.open({ databaseUrl: config.databaseUrl }) : OpsStore.open({ dataDir: join(config.dataDir, 'ops') });
}

async function main(): Promise<void> {
  const config = serviceConfig();
  const store = await openConfiguredOpsStore(config);
  const where = store.kind === 'postgres' ? 'postgres schema ops (DATABASE_URL)' : `pglite ${join(config.dataDir, 'ops')}`;
  let bus: Awaited<ReturnType<typeof createBus>>;
  try {
    bus = await createBus(config, 'ops');
  } catch (err) {
    await store.close();
    throw err;
  }
  const ops = await startOps({ bus, store, host: config.host, port: config.opsPort, log: (line) => console.log(line) });
  console.log(`[ops] ready on http://${config.host}:${ops.port} (bus=${config.bus}, store=${where}, payments=${ops.projection.payments.size}, alerts=${ops.projection.alerts.size})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ops] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await ops.close();
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
    console.error('[ops] fatal:', err);
    process.exit(1);
  });
}
