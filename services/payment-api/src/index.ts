// @ct/payment-api: library export + CLI (tsx services/payment-api/src/index.ts).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { startPaymentApi } from './server';

export { startPaymentApi, MAX_BODY_BYTES, type PaymentApiOptions, type PaymentApiHandle } from './server';
export { validatePaymentRequest, MAX_AMOUNT_MINOR, type PaymentRequest } from './validate';
export { samplePayment } from './sample';

async function main(): Promise<void> {
  const config = serviceConfig();
  const bus = await createBus(config, 'payment-api');
  const api = await startPaymentApi({
    bus,
    host: config.host,
    port: config.paymentApiPort,
    log: (line) => console.log(line),
  });
  console.log(`[payment-api] ready on http://${config.host}:${api.port} (bus=${config.bus})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[payment-api] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await api.close();
      await bus.close();
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
    console.error('[payment-api] fatal:', err);
    process.exit(1);
  });
}
