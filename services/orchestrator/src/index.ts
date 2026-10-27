// @ct/orchestrator: library export + CLI (tsx services/orchestrator/src/index.ts).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { startOrchestrator } from './orchestrator';

export { startOrchestrator, PACE_PRESETS, type OrchestratorOptions, type OrchestratorHandle } from './orchestrator';
export { SCENARIOS, PROVIDER_OUTAGE, PROVIDER_DEGRADED, SCENARIO_AMBIENT_RATE, scenarioInfo, validateScript, craftedKey, craftedRequest, runTag, type ScenarioScript, type ScenarioStep, type ScenarioAction, type CraftedPayment } from './scenarios';
export { FRAUD_RING, FX_SPIKE, SANCTIONS_HIT, FX_SPIKE_SHOCK, SANCTIONS_PARTIES } from './scenarios-m4';
export { ambientPayment, ambientKeyPrefix, ambientIndexOf, MAX_AMBIENT_RATE } from './ambient';
export { systemClock, FakeClock, type Clock } from './clock';

async function main(): Promise<void> {
  const config = serviceConfig();
  const bus = await createBus(config, 'orchestrator');
  const orchestrator = await startOrchestrator({
    bus,
    host: config.host,
    port: config.orchestratorPort,
    paymentApiUrl: config.paymentApiUrl,
    seed: config.simSeed,
    ambientRate: config.ambientRate,
    log: (line) => console.log(line),
  });
  console.log(
    `[orchestrator] ready on http://${config.host}:${orchestrator.port} (bus=${config.bus}, ambient=${config.ambientRate}/s, payment-api=${config.paymentApiUrl})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[orchestrator] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await orchestrator.close(); // ends any active scenario cleanly (no outage left behind)
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
    console.error('[orchestrator] fatal:', err);
    process.exit(1);
  });
}
