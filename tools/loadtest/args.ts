// CLI parsing for `npm run loadtest`. Pure, unit-tested.
import { parseScenarioMix, type ScenarioMix } from '../traffic/generator';
import { rampRates } from './report';

export interface LoadArgs {
  help: boolean;
  /** Fixed offered rate, or null for a stepped ramp. */
  rate: number | null;
  /** Seconds per step (a fixed rate is one step). */
  duration: number;
  rampStart: number;
  rampFactor: number;
  rampSteps: number;
  /** Keep ramping after a step saturates (default: stop after the first saturated step). */
  noStop: boolean;
  concurrency: number;
  seed: number | undefined;
  mix: ScenarioMix;
  report: string | undefined;
  drainTimeoutMs: number;
  url?: string;
  apiUrl?: string;
  brokerUrl?: string;
  ledgerUrl?: string;
  basePort: number;
  verbose: boolean;
}

export const LOAD_USAGE = `Usage: npm run loadtest -- [options]

Launches the whole system (temp data dir, stageDelayMs=0, settlementDelayMs=0, embedded ledger) - or attaches
to a running one with --url - and drives synthetic payments at stepped rising rates. Measures completed
payments/s, p50/p95/p99 initiation-to-reconciled latency, backlog growth and errors per step, finds the
saturation point, then checks the ledger balances and there are no duplicates. Writes JSON + markdown.
Synthetic, simulated providers, one machine: not a production benchmark.

Options:
  --rate <n|ramp>        Fixed offered payments/s for --duration seconds, or "ramp" (default ramp)
  --duration <s>         Seconds per step (default 10)
  --ramp-start <n>       First ramp rate (default 25)
  --ramp-factor <x>      Multiplier per step (default 2)
  --ramp-steps <n>       Number of steps (default 6)
  --no-stop              Do not stop the ramp after the first saturated step
  --concurrency <n>      Max requests in flight (default 128)
  --mix <spec>           Scenario mix (default provider-reject=0.02,recon-break=0.01; "none" for none)
  --seed <n>             Traffic seed (default 7001, or random with --url)
  --report <file>        Write <file> (.json) and the same name with .md (default <DATA_DIR>/reports/loadtest-<time>.json)
  --drain-timeout <s>    Max wait after the last step for payments to finish (default 120)
  --url <gateway-url>    Attach to a running system (with --api-url, --broker-url, --ledger-url)
  --base-port <n>        First port of the launched system (default 27270)
  --verbose              Print service logs
  -h, --help             Show this help
`;

function num(flag: string, v: string | undefined, min: number, integer = true): number {
  if (v === undefined) throw new Error(`${flag} needs a value`);
  const x = Number(v);
  if (!Number.isFinite(x) || x < min || (integer && !Number.isInteger(x))) throw new Error(`${flag} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got "${v}"`);
  return x;
}

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  const a: LoadArgs = {
    help: false, rate: null, duration: 10, rampStart: 25, rampFactor: 2, rampSteps: 6, noStop: false, concurrency: 128,
    seed: undefined, mix: { 'provider-reject': 0.02, 'recon-break': 0.01 }, report: undefined, drainTimeoutMs: 120_000, basePort: 27270, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const next = (): string | undefined => (eq > 0 ? raw.slice(eq + 1) : argv[++i]);
    switch (flag) {
      case '-h': case '--help': a.help = true; break;
      case '--rate': {
        const v = next();
        a.rate = v === 'ramp' ? null : num(flag, v, 0.1, false);
        break;
      }
      case '--duration': a.duration = num(flag, next(), 1, false); break;
      case '--ramp-start': a.rampStart = num(flag, next(), 1); break;
      case '--ramp-factor': a.rampFactor = num(flag, next(), 1.01, false); break;
      case '--ramp-steps': a.rampSteps = num(flag, next(), 1); break;
      case '--no-stop': a.noStop = true; break;
      case '--concurrency': a.concurrency = num(flag, next(), 1); break;
      case '--seed': a.seed = num(flag, next(), 0); break;
      case '--mix': {
        const v = next();
        if (!v) throw new Error('--mix needs a value');
        a.mix = v === 'none' ? {} : parseScenarioMix(v);
        break;
      }
      case '--report': a.report = next(); if (!a.report) throw new Error('--report needs a file'); break;
      case '--drain-timeout': a.drainTimeoutMs = num(flag, next(), 1, false) * 1000; break;
      case '--url': a.url = next()?.replace(/\/+$/, ''); break;
      case '--api-url': a.apiUrl = next()?.replace(/\/+$/, ''); break;
      case '--broker-url': a.brokerUrl = next()?.replace(/\/+$/, ''); break;
      case '--ledger-url': a.ledgerUrl = next()?.replace(/\/+$/, ''); break;
      case '--base-port': a.basePort = num(flag, next(), 1024); break;
      case '--verbose': a.verbose = true; break;
      default: throw new Error(`Unknown option "${raw}". Run "npm run loadtest -- --help" for usage.`);
    }
  }
  return a;
}

/** The offered rates of the run. */
export function plannedRates(a: LoadArgs): number[] {
  return a.rate !== null ? [a.rate] : rampRates(a.rampStart, a.rampFactor, a.rampSteps);
}
