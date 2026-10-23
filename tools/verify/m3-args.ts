// CLI parsing for `npm run verify:m3` (Gate 2). Pure, unit-tested.
import { DEFAULT_BREAKER_BOUND_MS } from './m3-analyze';

export interface VerifyM3Args {
  help: boolean;
  runs: number;
  scenario: string;
  /** Scenario seed sent to the orchestrator (default: its own SIM_SEED). */
  seed?: string;
  /** Ambient payments per second of the launched system (the scenario raises it while it runs). */
  ambientRate: number;
  stageDelayMs: number;
  settlementDelayMs: number;
  breakerBoundMs: number;
  maxResetMs: number;
  /** Extra wait after scenario.ended for the provider to settle normal traffic again. */
  recoveryTimeoutMs: number;
  /** Max wait for every payment to be terminal once ambient traffic is stopped. */
  drainTimeoutMs: number;
  /** Target an already-running system instead of launching one. */
  url?: string;
  brokerUrl?: string;
  ledgerUrl?: string;
  orchestratorUrl?: string;
  /** Launcher control API; without it (url mode) runs are not reset and check (h) is skipped. */
  controlUrl?: string;
  /** First port of the launched system: broker, api +1, gateway +2, ledger +3, orchestrator +4, control +9. */
  basePort: number;
  keep: boolean;
  verbose: boolean;
  reportDir?: string;
}

export const VERIFY_M3_USAGE = `Usage: npm run verify:m3 -- [options]

Gate 2 (M3 "first scenario live"): runs the provider-outage scenario N times in a row, offline, and
after every run checks that the breaker opened and was respected, the provider recovered, every
payment is terminal, the log is clean, the ledger balances, and that the reset took < 10 s.

By default it launches the whole system itself on 127.0.0.1 (ports 27170-27174, control 27179, temp
data dir, PGlite ledger, ambient traffic on) and stops it afterwards. Writes a JSON report under the
data dir (reports/) and exits non-zero if any check fails.

Options:
  --runs <n>                 Consecutive scenario runs (default 10)
  --scenario <id>            Scenario to run (default provider-outage)
  --seed <s>                 Scenario seed (default: the orchestrator's SIM_SEED)
  --ambient <n>              Ambient payments/s of the launched system (default 3)
  --stage-delay <ms>         Stage delay of the launched system (default 400, as npm start)
  --settlement-delay <ms>    Settlement delay of the launched system (default 900, as npm start)
  --breaker-bound <ms>       (b) breaker must be seen open within this long after the outage starts (default ${DEFAULT_BREAKER_BOUND_MS})
  --max-reset <ms>           (h) maximum reset duration (default 10000)
  --recovery-timeout <ms>    Extra wait after the scenario for normal traffic back to the provider (default 30000)
  --drain-timeout <ms>       Max wait for in-flight payments once ambient traffic is stopped (default 120000)
  --url <gateway-url>        Verify an already-running system (also: --broker-url, --ledger-url,
                             --orchestrator-url, --control-url; without --control-url runs are not reset)
  --base-port <n>            First port of the launched system (default 27170)
  --report-dir <dir>         Where to write the JSON report (default <data dir>/reports)
  --keep                     Keep the launched system's temp data dir
  --verbose                  Print service logs of the launched system
  -h, --help                 Show this help
`;

function num(flag: string, v: string | undefined, { integer = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${flag} must be a${integer ? 'n integer' : ' number'} between ${min} and ${max}, got "${v}"`);
  }
  return n;
}

export function parseVerifyM3Args(argv: readonly string[]): VerifyM3Args {
  const args: VerifyM3Args = {
    help: false,
    runs: 10,
    scenario: 'provider-outage',
    ambientRate: 3,
    stageDelayMs: 400,
    settlementDelayMs: 900,
    breakerBoundMs: DEFAULT_BREAKER_BOUND_MS,
    maxResetMs: 10_000,
    recoveryTimeoutMs: 30_000,
    drainTimeoutMs: 120_000,
    basePort: 27170,
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
      if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    const url = (): string => str().replace(/\/+$/, '');
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--runs':
        args.runs = num(flag, next(), { min: 1, max: 1000 });
        break;
      case '--scenario':
        args.scenario = str();
        break;
      case '--seed':
        args.seed = str();
        break;
      case '--ambient':
        args.ambientRate = num(flag, next(), { integer: false, max: 50 });
        break;
      case '--stage-delay':
        args.stageDelayMs = num(flag, next());
        break;
      case '--settlement-delay':
        args.settlementDelayMs = num(flag, next());
        break;
      case '--breaker-bound':
        args.breakerBoundMs = num(flag, next(), { min: 1 });
        break;
      case '--max-reset':
        args.maxResetMs = num(flag, next(), { min: 1 });
        break;
      case '--recovery-timeout':
        args.recoveryTimeoutMs = num(flag, next());
        break;
      case '--drain-timeout':
        args.drainTimeoutMs = num(flag, next(), { min: 1 });
        break;
      case '--url':
        args.url = url();
        break;
      case '--broker-url':
        args.brokerUrl = url();
        break;
      case '--ledger-url':
        args.ledgerUrl = url();
        break;
      case '--orchestrator-url':
        args.orchestratorUrl = url();
        break;
      case '--control-url':
        args.controlUrl = url();
        break;
      case '--base-port':
        args.basePort = num(flag, next(), { min: 1024, max: 65535 - 9 });
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
        throw new Error(`Unknown option "${raw}". Run "npm run verify:m3 -- --help" for usage.`);
    }
  }
  if (!args.url && (args.brokerUrl || args.ledgerUrl || args.orchestratorUrl || args.controlUrl)) {
    throw new Error('--broker-url/--ledger-url/--orchestrator-url/--control-url need --url (they target a running system)');
  }
  return args;
}
