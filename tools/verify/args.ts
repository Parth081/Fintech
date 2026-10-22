// CLI parsing for `npm run verify:m2`. Pure, unit-tested.
import { parseScenarioMix, type ScenarioMix } from '../traffic/generator';

export interface VerifyArgs {
  help: boolean;
  count: number;
  seed?: number;
  /** Payments per second (0 = as fast as concurrency allows). */
  rate: number;
  concurrency: number;
  mix: ScenarioMix;
  chaos: boolean;
  /** Mean time between chaos kills. */
  chaosIntervalMs: number;
  /** Target an already-running system (gateway URL) instead of launching one. */
  url?: string;
  apiUrl?: string;
  brokerUrl?: string;
  ledgerUrl?: string;
  /** Overall wait-for-terminal timeout; default derived from count. */
  timeoutMs?: number;
  /** First port of the launched system (broker; then api +1, gateway +2, ledger +3). */
  basePort: number;
  /** Keep the temp data dir of a launched system. */
  keep: boolean;
  verbose: boolean;
  /** PROVIDER_FAILURE_SCALE for a launched system. */
  providerFailureScale?: number;
  reportDir?: string;
}

export const VERIFY_USAGE = `Usage: npm run verify:m2 -- [options]

Proves the M2 "done when" at scale: sends N synthetic payments, waits until every one is terminal,
then checks the ledger balances, one journal per reconciled payment, no duplicate events, valid
state-machine walks, nothing stuck, and no events refused by the gateway. Writes a JSON report to
\${DATA_DIR}/reports and exits non-zero if any check fails.

By default it launches the whole system itself (ports 27070-27073, temp data dir, 0 delays, embedded
PGlite ledger) and stops it afterwards.

Options:
  --count <n>             Payments to send (default 10000)
  --seed <n>              Traffic seed (default 42; random with --url so reruns create new payments)
  --rate <n>              Payments per second, 0 = unlimited (default 300)
  --concurrency <n>       Max requests in flight (default 32)
  --mix <spec>            Scenario mix (default provider-reject=0.02,recon-break=0.01; "none" for none)
  --chaos                 Kill and restart random stage processes and the ledger during the run
  --chaos-interval <ms>   Mean time between kills (default 3000)
  --url <gateway-url>     Verify an already-running system instead of launching one
  --api-url <url>         Payment API (default env PAYMENT_API_URL or http://127.0.0.1:7071)
  --broker-url <url>      Broker HTTP (default derived from env BROKER_URL, http://127.0.0.1:7070)
  --ledger-url <url>      Ledger (default env LEDGER_URL or http://127.0.0.1:7073)
  --timeout <ms>          Max wait for all payments to be terminal (default 120 s + 60 ms per payment)
  --base-port <n>         First port of the launched system (default 27070)
  --failure-scale <x>     PROVIDER_FAILURE_SCALE for the launched system (default 1)
  --report-dir <dir>      Where to write the JSON report (default \${DATA_DIR}/reports)
  --keep                  Keep the launched system's temp data dir
  --verbose               Print service logs of the launched system
  -h, --help              Show this help
`;

function num(flag: string, v: string | undefined, { integer = true, min = 0 } = {}): number {
  if (v === undefined) throw new Error(`${flag} needs a value`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`${flag} must be a ${integer ? 'integer' : 'number'} >= ${min}, got "${v}"`);
  }
  return n;
}

const DEFAULT_MIX = 'provider-reject=0.02,recon-break=0.01';

export function parseVerifyArgs(argv: readonly string[]): VerifyArgs {
  const args: VerifyArgs = {
    help: false,
    count: 10_000,
    rate: 300,
    concurrency: 32,
    mix: parseScenarioMix(DEFAULT_MIX),
    chaos: false,
    chaosIntervalMs: 3000,
    basePort: 27070,
    keep: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const next = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    const str = (): string => {
      const v = next();
      if (!v) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--count':
        args.count = num(flag, next(), { min: 1 });
        break;
      case '--seed':
        args.seed = num(flag, next());
        break;
      case '--rate':
        args.rate = num(flag, next(), { integer: false });
        break;
      case '--concurrency':
        args.concurrency = num(flag, next(), { min: 1 });
        break;
      case '--mix': {
        const v = str();
        args.mix = v === 'none' ? {} : parseScenarioMix(v);
        break;
      }
      case '--chaos':
        args.chaos = true;
        break;
      case '--chaos-interval':
        args.chaosIntervalMs = num(flag, next(), { min: 100 });
        break;
      case '--url':
        args.url = str().replace(/\/+$/, '');
        break;
      case '--api-url':
        args.apiUrl = str().replace(/\/+$/, '');
        break;
      case '--broker-url':
        args.brokerUrl = str().replace(/\/+$/, '');
        break;
      case '--ledger-url':
        args.ledgerUrl = str().replace(/\/+$/, '');
        break;
      case '--timeout':
        args.timeoutMs = num(flag, next(), { min: 1 });
        break;
      case '--base-port':
        args.basePort = num(flag, next(), { min: 1024 });
        if (args.basePort > 65532) throw new Error('--base-port must leave room for 4 ports');
        break;
      case '--failure-scale':
        args.providerFailureScale = num(flag, next(), { integer: false });
        break;
      case '--report-dir':
        args.reportDir = str();
        break;
      case '--keep':
        args.keep = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run verify:m2 -- --help" for usage.`);
    }
  }
  if (args.chaos && args.url) throw new Error('--chaos needs a system launched by verify:m2 (it cannot kill processes behind --url)');
  return args;
}

/** ws://host:port (BROKER_URL) -> http://host:port (the broker serves /events on the same port). */
export function brokerHttpUrl(brokerUrl: string): string {
  return brokerUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
}
