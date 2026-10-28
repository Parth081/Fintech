// CLI parsing for `npm run verify:m4`. Pure, unit-tested.

export interface VerifyM4Args {
  help: boolean;
  /** Target an already-running system (gateway URL) instead of launching one. */
  url?: string;
  /** Broker of a running system (the raw event log is read from its HTTP /events). */
  brokerUrl?: string;
  /** First port of the launched system: broker, api +1, gateway +2, ledger +3, orchestrator +4, ops +5. */
  basePort: number;
  stageDelayMs: number;
  settlementDelayMs: number;
  /** Payments sent while lyra is disabled (check g). */
  routingSample: number;
  /** Max wait for one payment / one workflow step. */
  stepTimeoutMs: number;
  keep: boolean;
  verbose: boolean;
  reportDir?: string;
}

export const VERIFY_M4_USAGE = `Usage: npm run verify:m4 -- [options]

M4 (operations console + risk & compliance) end-to-end verification. Drives the real workflows through
the gateway (/api/ops/*, /api/control/orchestrator/*, /api/payments) as different demo users and checks:
  (a) sanctions-hit: payments held, sanctions alerts, a case per payment
  (b) fraud-ring: AML and fraud alerts rolled up into cases
  (c) analyst proposes release on a high/critical case; the analyst cannot approve; a manager approves
      -> payment.released -> reconciled
  (d) reject (four-eyes) -> payment.rejected atStage ops, no ledger journal
  (e) operator retry of a failed payment -> completes
  (f) refund maker-checker -> payment.refunded, balanced mirror reversal, ledger invariants ok
  (g) admin disables lyra, a second admin approves -> control.config.updated -> no first-attempt routing to lyra
  (h) fx-spike: quotes during the shock have wider spreads
  (i) every mutating call audited with its actor; audit trail append-only
  (j) no duplicate events, valid state-machine walks, trial balance balanced, gateway rejectedEvents 0

By default it launches the whole system on 127.0.0.1 (ports 28170-28175, temp data dir, PGlite) and stops it
afterwards. Writes a JSON report and exits non-zero if any check fails.

Options:
  --url <gateway-url>        Verify an already-running system (e.g. Docker: http://127.0.0.1:7072)
  --broker-url <ws-url>      Broker of that system (default env BROKER_URL or ws://127.0.0.1:7070)
  --base-port <n>            First port of the launched system (default 28170)
  --stage-delay <ms>         Stage delay of the launched system (default 100)
  --settlement-delay <ms>    Settlement delay of the launched system (default 300)
  --routing-sample <n>       Payments sent while lyra is disabled (default 24)
  --step-timeout <ms>        Max wait for a payment or workflow step (default 90000)
  --report-dir <dir>         Where to write the JSON report (default <data dir>/reports)
  --keep                     Keep the launched system's temp data dir
  --verbose                  Print service logs of the launched system
  -h, --help                 Show this help
`;

function num(flag: string, v: string | undefined, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer between ${min} and ${max}, got "${v}"`);
  return n;
}

export function parseVerifyM4Args(argv: readonly string[]): VerifyM4Args {
  const args: VerifyM4Args = {
    help: false,
    basePort: 28170,
    stageDelayMs: 100,
    settlementDelayMs: 300,
    routingSample: 24,
    stepTimeoutMs: 90_000,
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
        args.help = true;
        break;
      case '--url':
        args.url = str().replace(/\/+$/, '');
        break;
      case '--broker-url':
        args.brokerUrl = str();
        break;
      case '--base-port':
        args.basePort = num(flag, next(), 1024, 65530);
        break;
      case '--stage-delay':
        args.stageDelayMs = num(flag, next());
        break;
      case '--settlement-delay':
        args.settlementDelayMs = num(flag, next());
        break;
      case '--routing-sample':
        args.routingSample = num(flag, next(), 1, 500);
        break;
      case '--step-timeout':
        args.stepTimeoutMs = num(flag, next(), 1000);
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
        throw new Error(`Unknown option "${raw}". Run "npm run verify:m4 -- --help" for usage.`);
    }
  }
  return args;
}
