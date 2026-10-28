// @ct/stages: pipeline stage stubs. Library exports + CLI.
//   tsx services/stages/src/index.ts --stage <name>   (one process per stage; what the launcher runs)
//   tsx services/stages/src/index.ts --all            (all stages in one process)
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { startStage, type StageHandle } from './runner';
import { isStageName, STAGE_NAMES } from './steps';

export { startStage, startAllStages, buildEvent, type StageOptions, type StageHandle } from './runner';
export * from './steps';
export * from './fx-math';
export * from './risk';

async function main(argv: string[]): Promise<void> {
  const all = argv.includes('--all');
  const idx = argv.indexOf('--stage');
  const stage = idx >= 0 ? argv[idx + 1] : undefined;
  // The ledger stage needs a database, so it runs inside the ledger service (services/ledger), not here.
  const runnable = STAGE_NAMES.filter((n) => n !== 'ledger');
  if (stage === 'ledger') {
    console.error('the ledger stage runs inside the ledger service: tsx services/ledger/src/index.ts');
    process.exit(2);
  }
  if (!all && (!stage || !isStageName(stage))) {
    console.error(`usage: stages --stage <${runnable.join('|')}> | --all (all except ledger)`);
    process.exit(2);
  }
  const config = serviceConfig();
  const label = all ? 'all-stages' : (stage as string);
  const bus = await createBus(config, `stage-${label}`);
  const options = {
    bus,
    stageDelayMs: config.stageDelayMs,
    settlementDelayMs: config.settlementDelayMs,
    services: { sim: { seed: config.simSeed, providerFailureScale: config.providerFailureScale } },
    log: (line: string) => console.log(line),
  };
  const handles: StageHandle[] = all
    ? await Promise.all(runnable.map((n) => startStage(n, options)))
    : [await startStage(stage as never, options)];
  const handle: StageHandle = { stop: async () => { await Promise.all(handles.map((h) => h.stop())); } };
  console.log(`[${label}] ready (bus=${config.bus}, stageDelayMs=${config.stageDelayMs}, settlementDelayMs=${config.settlementDelayMs})`);

  // Keep the process alive even if the bus holds no open handles (e.g. BUS=memory).
  const keepAlive = setInterval(() => {}, 60_000);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    console.log(`[${label}] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await handle.stop();
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
  main(process.argv.slice(2)).catch((err) => {
    console.error('[stages] fatal:', err);
    process.exit(1);
  });
}
