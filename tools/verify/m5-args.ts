// CLI parsing for `npm run verify:m5` (AI explainer + booth). Pure, unit-tested.

export const M5_SCENARIOS = ['provider-outage', 'provider-degraded'] as const;

export interface VerifyM5Args {
  help: boolean;
  /** Scenario ids to run (default: every scripted scenario the orchestrator lists). Empty = all. */
  scenarios: string[];
  /** Minimum number of questions asked per scenario (default 100). */
  minQuestions: number;
  /** Parallel /ask requests (default 4). */
  concurrency: number;
  ambientRate: number;
  stageDelayMs: number;
  settlementDelayMs: number;
  /** Booth staff PIN for the launched system (and the one sent to staff routes). */
  staffPin: string;
  /** Verify an already-running system instead of launching one (ASSISTANT_LLM there is not ours to set). */
  url?: string;
  brokerUrl?: string;
  orchestratorUrl?: string;
  controlUrl?: string;
  /** First port of the launched system: broker, api +1, gateway +2, ledger +3, orchestrator +4, assistant +6, booth +7, control +9. */
  basePort: number;
  keep: boolean;
  verbose: boolean;
  reportDir?: string;
}

export const VERIFY_M5_USAGE = `Usage: npm run verify:m5 -- [options]

M5 (AI explainer and booth mode). Launches the whole system offline (ports 37070-37079, temp data dir,
ASSISTANT_LLM=off: grounded answers must pass with no network), then for every scripted scenario:
runs it with ambient traffic, builds >= 100 questions with the assistant's question bank, asks them
THROUGH THE GATEWAY (POST /api/assistant/ask) and re-derives every cited fact from the broker /events
log: answer.verified, every number matches a citation, every citation equals the log value at
eventId + field, key facts present. Also: off-topic questions are declined, prompt injection neither
leaks nor acts, the booth rejects a lead without consent, staff routes need the PIN, analytics reject
personal data, leads survive a demo reset, and services/booth has no outbound HTTP client.
Prints a per-scenario table, writes a JSON report and exits non-zero on any failure.

Options:
  --scenario <id>            Run only this scenario (repeatable; default: all scripted scenarios)
  --min-questions <n>        Questions per scenario (default 100)
  --concurrency <n>          Parallel questions (default 4)
  --ambient <n>              Ambient payments/s of the launched system (default 3)
  --stage-delay <ms>         Stage delay (default 0)
  --settlement-delay <ms>    Settlement delay (default 0)
  --staff-pin <pin>          Booth staff PIN (default 2468, or env BOOTH_STAFF_PIN)
  --url <gateway-url>        Verify an already-running system (also --broker-url, --orchestrator-url,
                             --control-url; without --control-url scenarios are not reset in between)
  --base-port <n>            First port of the launched system (default 37070)
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

export function parseVerifyM5Args(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): VerifyM5Args {
  const a: VerifyM5Args = {
    help: false,
    scenarios: [],
    minQuestions: 100,
    concurrency: 4,
    ambientRate: 3,
    stageDelayMs: 0,
    settlementDelayMs: 0,
    staffPin: env.BOOTH_STAFF_PIN || '2468',
    basePort: 37070,
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
    switch (flag) {
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '--scenario':
        a.scenarios.push(str());
        break;
      case '--min-questions':
        a.minQuestions = toInt(flag, next(), 1, 100_000);
        break;
      case '--concurrency':
        a.concurrency = toInt(flag, next(), 1, 64);
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
      case '--broker-url':
        a.brokerUrl = str();
        break;
      case '--orchestrator-url':
        a.orchestratorUrl = str().replace(/\/+$/, '');
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
        throw new Error(`Unknown option "${raw}". Run "npm run verify:m5 -- --help" for usage.`);
    }
  }
  return a;
}
