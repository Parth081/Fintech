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
  dataDir: string;
  stageDelayMs: number;
  settlementDelayMs: number;
  startupTimeoutMs: number;
}

export const LAUNCHER_USAGE = `Usage: npm start [-- options]

Starts the whole Control Tower on this machine (broker, payment-api, 6 stages, ledger, gateway + UI).

Options:
  --reset                    Delete the data directory (event log) before starting
  --no-build                 Do not build the UI even if apps/web/dist is missing
  --quiet                    Only print warnings, errors and the banner
  --host <host>              Bind address (env HOST, default 127.0.0.1)
  --broker-port <n>          (env BROKER_PORT, default 7070)
  --api-port <n>             (env PAYMENT_API_PORT, default 7071)
  --gateway-port <n>         (env GATEWAY_PORT, default 7072)
  --ledger-port <n>          (env LEDGER_PORT, default 7073)
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
  const ports = [args.brokerPort, args.paymentApiPort, args.gatewayPort, args.ledgerPort];
  if (new Set(ports).size !== ports.length) {
    throw new Error(`Ports must be different (broker ${ports[0]}, payment-api ${ports[1]}, gateway ${ports[2]}, ledger ${ports[3]})`);
  }
  return args;
}
