// @ct/booth: booth mode back end (lead capture with explicit consent + anonymous kiosk analytics).
// Library exports + CLI (tsx services/booth/src/index.ts). Data lives in embedded PGlite under
// ${DATA_DIR}/booth on this laptop only. The service never makes outbound network requests.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { openBoothStore } from './store';
import { startBooth } from './server';

export { startBooth, boothRequestHandler, pinMatches, BODY_LIMITS, type BoothOptions, type BoothHandle } from './server';
export { openBoothStore, StoreFullError, ERASABLE_DATA_KEYS, type BoothStore, type BoothStoreOptions } from './store';
export { validateLead, validateEvent, cleanText, isEmail, LIMITS, LEAD_INTERESTS, ANALYTICS_TYPES, SESSION_ID } from './validate';
export { leadsToCsv, csvCell, CSV_COLUMNS } from './csv';

async function main(): Promise<void> {
  const config = serviceConfig();
  const dataDir = join(config.dataDir, 'booth');
  const store = await openBoothStore({ dataDir });
  let booth: Awaited<ReturnType<typeof startBooth>>;
  try {
    booth = await startBooth({ store, host: config.host, port: config.boothPort, staffPin: config.boothStaffPin, log: (l) => console.log(l) });
  } catch (err) {
    await store.close();
    throw err;
  }
  const counts = await store.counts();
  console.log(`[booth] ready on http://${config.host}:${booth.port} (store=pglite ${dataDir}, leads=${counts.leads}, events=${counts.events})`);
  if (config.boothStaffPin === '2468') console.log('[booth] note: using the demo staff PIN; set BOOTH_STAFF_PIN for a real event');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[booth] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await booth.close();
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
    console.error('[booth] fatal:', err);
    process.exit(1);
  });
}
