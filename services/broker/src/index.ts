// CLI entry: `npx tsx services/broker/src/index.ts`
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { startBroker } from './broker';

const config = serviceConfig();
const broker = await startBroker({ host: config.host, port: config.brokerPort, dataDir: config.dataDir });
console.log(`[broker] listening on ws://${config.host}:${broker.port} (http://${config.host}:${broker.port}/health), data in ${config.dataDir}/broker`);

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[broker] ${signal} received, shutting down`);
  broker.close().then(
    () => process.exit(0),
    (err) => {
      console.error('[broker] error during shutdown', err);
      process.exit(1);
    },
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
exitWithSupervisor(shutdown);
