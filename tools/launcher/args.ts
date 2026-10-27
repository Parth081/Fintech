// CLI argument parsing for `npm start` (tools/launcher/index.ts). Pure, so it is unit-tested.
import { serviceConfig } from '@ct/contracts';

export interface LauncherArgs {
  help: boolean;
  reset: boolean;
  /** Build the UI first if apps/web/dist/index.html is missing (default true). */
  buildWeb: boolean;
  quiet: boolean;
  host: string;
  brokerPort: number;
  paymentApiPort: number;
  gatewayPort: number;
  ledgerPort: number;
  orchestratorPort: number;
  /** M5 AI explainer port (env ASSISTANT_PORT, default 7076). */
  assistantPort: number;
  /** M5 booth service port (env BOOTH_PORT, default 7077). */
  boothPort: number;
  /** ASSISTANT_LLM: 'auto' (Claude when credentials work, else grounded) or 'off' (fully offline). npm start: auto. */
  assistantLlm: 'auto' | 'off';
  /** Launcher control API port (GET /status, POST /reset); null = --no-control. */
  controlPort: number | null;
  /** Ambient payments per second from the orchestrator. */
  ambientRate: number;
  dataDir: string;
  stageDelayMs: number;
  settlementDelayMs: number;
  startupTimeoutMs: number;
}

export const LAUNCHER_USAGE = `Usage: npm start [-- options]

Starts the whole Control Tower on this machine (broker, payment-api, 6 stages, ledger, orchestrator,
gateway + UI, AI explainer, booth) and the launcher control API (reset) on 127.0.0.1.
A reset never deletes DATA_DIR/booth (visitor leads); clear them with npm run booth:clear-leads.

Options:
  --reset                    Delete the data directory (event log) before starting
  --no-build                 Do not build the UI even if apps/web/dist is missing
  --quiet                    Only print warnings, errors and the banner
  --host <host>              Bind address (env HOST, default 127.0.0.1)
  --broker-port <n>          (env BROKER_PORT, default 7070)
  --api-port <n>             (env PAYMENT_API_PORT, default 7071)
  --gateway-port <n>         (env GATEWAY_PORT, default 7072)
  --ledger-port <n>          (env LEDGER_PORT, default 7073)
  --orchestrator-port <n>    (env ORCHESTRATOR_PORT, default 7074)
  --assistant-port <n>       AI explainer (env ASSISTANT_PORT, default 7076)
  --booth-port <n>           Booth: leads + analytics (env BOOTH_PORT, default 7077)
  --llm <auto|off>           AI explainer mode (env ASSISTANT_LLM, default auto): auto = Claude phrases answers
                             when ANTHROPIC_API_KEY (or other SDK credentials) work, else grounded answers;
                             off = grounded answers only, never contacts the network
  --control-port <n>         Launcher control API: GET /status, POST /reset (env LAUNCHER_CONTROL_PORT, default 7079)
  --no-control               Do not start the control API (the UI's Reset button then answers 503)
  --ambient <n>              Ambient payments per second while no scenario runs (env AMBIENT_RATE, default 3; 0 = off)
  --data-dir <dir>           (env DATA_DIR, default .data)
  --stage-delay <ms>         (env STAGE_DELAY_MS, default 400)
  --settlement-delay <ms>    (env SETTLEMENT_DELAY_MS, default 900)
  --timeout <ms>             Startup timeout per service (default 30000)
  -h, --help                 Show this help
`;

function toInt(flag: string, value: string | undefined): number {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  return n;
}

function toPort(flag: string, value: string | undefined): number {
  const n = toInt(flag, value);
  if (n < 1 || n > 65535) throw new Error(`${flag} must be a port between 1 and 65535, got "${value}"`);
  return n;
}

/** Parse argv (without node + script). Defaults come from the environment via serviceConfig(). */
export function parseLauncherArgs(argv: readonly string[], defaults = serviceConfig()): LauncherArgs {
  const args: LauncherArgs = {
    help: false,
    reset: false,
    buildWeb: true,
    quiet: false,
    host: defaults.host,
    brokerPort: defaults.brokerPort,
    paymentApiPort: defaults.paymentApiPort,
    gatewayPort: defaults.gatewayPort,
    ledgerPort: defaults.ledgerPort,
    orchestratorPort: defaults.orchestratorPort ?? 7074,
    assistantPort: defaults.assistantPort ?? 7076,
    boothPort: defaults.boothPort ?? 7077,
    assistantLlm: defaults.assistantLlm === 'off' ? 'off' : 'auto',
    controlPort: defaults.launcherControlPort ?? 7079,
    // npm start shows a living system by default; tests and verify tools pass their own rate.
    ambientRate: process.env.AMBIENT_RATE ? Number(process.env.AMBIENT_RATE) : 3,
    dataDir: defaults.dataDir,
    stageDelayMs: defaults.stageDelayMs,
    settlementDelayMs: defaults.settlementDelayMs,
    startupTimeoutMs: 30_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    // Support --flag=value as well as --flag value.
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const next = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--no-build':
        args.buildWeb = false;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--host': {
        const v = next();
        if (!v) throw new Error('--host needs a value');
        args.host = v;
        break;
      }
      case '--data-dir': {
        const v = next();
        if (!v) throw new Error('--data-dir needs a value');
        args.dataDir = v;
        break;
      }
      case '--broker-port':
        args.brokerPort = toPort(flag, next());
        break;
      case '--api-port':
      case '--payment-api-port':
        args.paymentApiPort = toPort(flag, next());
        break;
      case '--gateway-port':
        args.gatewayPort = toPort(flag, next());
        break;
      case '--ledger-port':
        args.ledgerPort = toPort(flag, next());
        break;
      case '--orchestrator-port':
        args.orchestratorPort = toPort(flag, next());
        break;
      case '--assistant-port':
        args.assistantPort = toPort(flag, next());
        break;
      case '--booth-port':
        args.boothPort = toPort(flag, next());
        break;
      case '--llm': {
        const v = next();
        if (v !== 'auto' && v !== 'off') throw new Error(`--llm must be "auto" or "off", got "${v ?? ''}"`);
        args.assistantLlm = v;
        break;
      }
      case '--control-port':
        args.controlPort = toPort(flag, next());
        break;
      case '--no-control':
        args.controlPort = null;
        break;
      case '--ambient': {
        const v = next();
        const n = Number(v);
        if (v === undefined || v.startsWith('--') || !Number.isFinite(n) || n < 0 || n > 50) {
          throw new Error(`--ambient must be a number of payments per second between 0 and 50, got "${v ?? ''}"`);
        }
        args.ambientRate = n;
        break;
      }
      case '--stage-delay':
        args.stageDelayMs = toInt(flag, next());
        break;
      case '--settlement-delay':
        args.settlementDelayMs = toInt(flag, next());
        break;
      case '--timeout':
        args.startupTimeoutMs = toInt(flag, next());
        break;
      default:
        throw new Error(`Unknown option "${raw}". Run "npm start -- --help" for usage.`);
    }
  }
  const named: [string, number][] = [
    ['broker', args.brokerPort],
    ['payment-api', args.paymentApiPort],
    ['gateway', args.gatewayPort],
    ['ledger', args.ledgerPort],
    ['orchestrator', args.orchestratorPort],
    ['assistant', args.assistantPort],
    ['booth', args.boothPort],
    ...(args.controlPort !== null ? ([['control', args.controlPort]] as [string, number][]) : []),
  ];
  if (new Set(named.map(([, p]) => p)).size !== named.length) {
    throw new Error(`Ports must be different (${named.map(([n, p]) => `${n} ${p}`).join(', ')})`);
  }
  return args;
}
