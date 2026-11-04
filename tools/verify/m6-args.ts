// CLI parsing for `npm run verify:m6` (the M6 dress rehearsal). Pure, unit-tested.

export interface VerifyM6Args {
  help: boolean;
  quick: boolean;
  /** Virtual kiosk visitors (default 40, quick 10). */
  visitors: number;
  /** Seed of the visitor scripts and of the chaos victim order. */
  seed: number;
  /** Kills per victim class in the chaos phase (full: 2, quick: 1). The broker is killed at least once. */
  killsPerClass: number;
  /** A killed service must be healthy again within this long, by the supervisor alone (documented in ADR 0019). */
  recoverBoundMs: number;
  /** Demo resets under load (full 3, quick 1); each must finish under resetBoundMs. */
  resets: number;
  resetBoundMs: number;
  /** Safe-mode round trips (full 2, quick 1); safe mode must be reported within safeBoundMs. */
  safeRoundTrips: number;
  safeBoundMs: number;
  /** Length of the recorded run (provider-outage) used for safe mode, in seconds. */
  recordSeconds: number;
  ambientRate: number;
  stageDelayMs: number;
  settlementDelayMs: number;
  staffPin: string;
  /** Verify an already-running system with limited checks (visitors, leads, offline listing of nothing, copy). */
  url?: string;
  controlUrl?: string;
  /** First port of the launched system (38070..38099): broker, api +1, gateway +2, ledger +3, orchestrator +4, ops +5, assistant +6, booth +7, control +9. */
  basePort: number;
  keep: boolean;
  verbose: boolean;
  reportDir?: string;
}

export const VERIFY_M6_USAGE = `Usage: npm run verify:m6 -- [options]

M6 dress rehearsal (Gate 3, software part). Launches the whole system offline (ports 38070-38079, temp data
dir, supervisor ON, ambient traffic ON, ASSISTANT_LLM=off) and runs, in order: preflight; virtual kiosk
visitors; chaos (kill -9 of every service class, no manual restart: the supervisor must heal); demo resets
under load; safe-mode round trips on a recorded run; the offline proof (no non-loopback TCP connection of
the launched process tree); the copy check; the leads export. Prints a per-check table, writes a JSON report
and exits non-zero on any failed check.

Options:
  --quick                    Short run for CI: 10 visitors, one kill per class, 1 reset, 1 safe-mode round trip
  --visitors <n>             Virtual visitors (default 40; quick 10)
  --seed <n>                 Seed for scripts and chaos order (default 6)
  --kills <n>                Kills per victim class (default 2; quick 1)
  --recover-bound <ms>       Max time to recover per kill (default 15000)
  --resets <n>               Resets under load (default 3; quick 1)
  --safe-roundtrips <n>      Safe-mode round trips (default 2; quick 1)
  --record-seconds <n>       Length of the recorded run (default 40; quick 30)
  --ambient <n>              Ambient payments/s (default 3)
  --stage-delay <ms>         Stage delay (default 0)
  --settlement-delay <ms>    Settlement delay (default 0)
  --staff-pin <pin>          Booth staff PIN (default 2468, or env BOOTH_STAFF_PIN)
  --url <gateway-url>        Check an already-running system (limited: visitors, booth, copy; no chaos)
  --control-url <url>        Launcher control API of that system
  --base-port <n>            First port of the launched system (default 38070)
  --report-dir <dir>         Where to write the JSON report (default <data dir>/reports)
  --keep                     Keep the launched system's temp data dir
  --verbose                  Print service logs of the launched system
  -h, --help                 Show this help
`;

function toInt(flag: string, v: string | undefined, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v.startsWith('--') || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}, got "${v ?? ''}"`);
  }
  return n;
}

export function parseVerifyM6Args(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): VerifyM6Args {
  const given = new Set<string>();
  const quick = argv.includes('--quick');
  const a: VerifyM6Args = {
    help: false,
    quick,
    visitors: quick ? 10 : 40,
    seed: 6,
    killsPerClass: quick ? 1 : 2,
    recoverBoundMs: 15_000,
    resets: quick ? 1 : 3,
    resetBoundMs: 10_000,
    safeRoundTrips: quick ? 1 : 2,
    safeBoundMs: 10_000,
    recordSeconds: quick ? 30 : 40,
    ambientRate: 3,
    stageDelayMs: 0,
    settlementDelayMs: 0,
    staffPin: env.BOOTH_STAFF_PIN || '2468',
    basePort: 38070,
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
    given.add(flag);
    switch (flag) {
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '--quick':
        break;
      case '--visitors':
        a.visitors = toInt(flag, next(), 1, 5000);
        break;
      case '--seed':
        a.seed = toInt(flag, next(), 0, 2 ** 31);
        break;
      case '--kills':
        a.killsPerClass = toInt(flag, next(), 1, 20);
        break;
      case '--recover-bound':
        a.recoverBoundMs = toInt(flag, next(), 1000, 300_000);
        break;
      case '--resets':
        a.resets = toInt(flag, next(), 0, 20);
        break;
      case '--safe-roundtrips':
        a.safeRoundTrips = toInt(flag, next(), 0, 10);
        break;
      case '--record-seconds':
        a.recordSeconds = toInt(flag, next(), 5, 600);
        break;
      case '--ambient': {
        const v = next();
        const n = Number(v);
        if (v === undefined || !Number.isFinite(n) || n < 0 || n > 50) throw new Error(`--ambient must be between 0 and 50, got "${v ?? ''}"`);
        a.ambientRate = n;
        break;
      }
      case '--stage-delay':
        a.stageDelayMs = toInt(flag, next(), 0, 60_000);
        break;
      case '--settlement-delay':
        a.settlementDelayMs = toInt(flag, next(), 0, 60_000);
        break;
      case '--staff-pin':
        a.staffPin = str();
        break;
      case '--url':
        a.url = str().replace(/\/+$/, '');
        break;
      case '--control-url':
        a.controlUrl = str().replace(/\/+$/, '');
        break;
      case '--base-port':
        a.basePort = toInt(flag, next(), 1024, 65_525);
        break;
      case '--report-dir':
        a.reportDir = str();
        break;
      case '--keep':
        a.keep = true;
        break;
      case '--verbose':
        a.verbose = true;
        break;
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run verify:m6 -- --help" for usage.`);
    }
  }
  return a;
}
