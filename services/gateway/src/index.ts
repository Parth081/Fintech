// CLI entry: `npx tsx services/gateway/src/index.ts`. Also re-exports startGateway for embedding.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { DEFAULT_WEB_DIST, startGateway } from './server';

export { startGateway, DEFAULT_WEB_DIST } from './server';
export type { GatewayOptions, GatewayHandle } from './server';
export { Projection, summarize } from './projection';
export { ControlProjection, TrafficMeter } from './control';
export type { MarketPort, IsoPort, Camt053Input } from './views';
export type * from './api-types';

async function main(): Promise<void> {
  const config = serviceConfig();
  const bus = await createBus(config, 'gateway');
  const webDist = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : DEFAULT_WEB_DIST;
  const gateway = await startGateway({
    bus,
    host: config.host,
    port: config.gatewayPort,
    paymentApiUrl: config.paymentApiUrl,
    ledgerUrl: config.ledgerUrl,
    simSeed: config.simSeed,
    webDist,
    orchestratorUrl: config.orchestratorUrl,
    launcherControlUrl: config.launcherControlUrl,
    assistantUrl: config.assistantUrl,
    boothUrl: config.boothUrl,
  });
  console.log(
    `[gateway] listening on http://${config.host}:${gateway.port} (ws://${config.host}:${gateway.port}/ws), bus=${config.bus}, payment API ${config.paymentApiUrl}, ledger ${config.ledgerUrl}, orchestrator ${config.orchestratorUrl}, reset ${config.launcherControlUrl || 'unavailable'}, assistant ${config.assistantUrl}, booth ${config.boothUrl}, UI from ${webDist}`,
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[gateway] ${signal} received, shutting down`);
    gateway
      .close()
      .then(() => bus.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error('[gateway] error during shutdown', err);
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  exitWithSupervisor(shutdown);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error('[gateway] failed to start', err);
    process.exit(1);
  });
}
