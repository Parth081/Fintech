// `npm start` - launches the whole Control Tower locally. Logic lives in launch.ts.
import { LAUNCHER_USAGE, parseLauncherArgs } from './args';
import { banner, launch, prefixLine, type LaunchedSystem } from './launch';

async function main(): Promise<void> {
  let args;
  try {
    args = parseLauncherArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(LAUNCHER_USAGE);
    return;
  }

  let system: LaunchedSystem | undefined;
  let shuttingDown = false;
  let interruptedDuringStartup = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(prefixLine('launcher', `${signal} received - stopping all services...`));
    if (system) {
      await system.stop();
      console.log(prefixLine('launcher', 'All services stopped.'));
      process.exit(0);
    } else {
      // launch() is still starting; it will be stopped as soon as it returns or fails.
      interruptedDuringStartup = true;
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  try {
    system = await launch({
      host: args.host,
      ports: {
        broker: args.brokerPort,
        paymentApi: args.paymentApiPort,
        gateway: args.gatewayPort,
        ledger: args.ledgerPort,
        orchestrator: args.orchestratorPort,
        assistant: args.assistantPort,
        booth: args.boothPort,
      },
      assistantLlm: args.assistantLlm,
      controlPort: args.controlPort ?? undefined,
      ambientRate: args.ambientRate,
      dataDir: args.dataDir,
      reset: args.reset,
      stageDelayMs: args.stageDelayMs,
      settlementDelayMs: args.settlementDelayMs,
      quiet: args.quiet,
      buildWeb: args.buildWeb,
      startupTimeoutMs: args.startupTimeoutMs,
      onUnexpectedExit: () => process.exit(1),
    });
  } catch (e) {
    if (interruptedDuringStartup) process.exit(0);
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }

  if (interruptedDuringStartup) {
    await system.stop();
    process.exit(0);
  }
  const extra = [
    `  Ambient traffic ${args.ambientRate}/s` + (system.urls.control ? ` · reset: POST ${system.urls.control}/reset` : ''),
    `  Booth: big screen ${system.urls.gateway}/#/stage · kiosk ${system.urls.gateway}/#/kiosk`,
    `  AI explainer: ${args.assistantLlm === 'off' ? 'grounded answers only (--llm off, offline)' : 'Claude when credentials work, else grounded (--llm off for fully offline)'}`,
    `  Started in ${(system.startup.totalMs / 1000).toFixed(1)} s`,
  ];
  console.log(`\n${banner(system.urls.gateway, extra)}\n`);
}

void main();
