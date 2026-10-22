// Argument parsing and HTTP sending for `npm run traffic`. Kept separate from index.ts so it is testable.
import { serviceConfig } from '@ct/contracts';
import type { GeneratedPayment } from './generator';

export interface TrafficArgs {
  help: boolean;
  count: number;
  seed: number;
  /** Payments per second; 0 = as fast as possible. */
  rate: number;
  scenario?: string;
  url: string;
  start: number;
}

export const TRAFFIC_USAGE = `Usage: npm run traffic -- [options]

Posts seeded synthetic payments to the Payment API (POST /payments). Re-running the same seed is
idempotent: each payment's Idempotency-Key is derived from seed + index (+ scenario).

Options:
  --count <n>        Number of payments (default 10)
  --seed <n>         PRNG seed (default 42)
  --rate <n>         Payments per second, 0 = no pacing (default 2)
  --scenario <name>  Scenario tag passed to the pipeline, e.g. force-hold
  --start <n>        First index (default 0)
  --url <url>        Payment API base URL (env PAYMENT_API_URL, default http://127.0.0.1:7071)
  -h, --help         Show this help
`;

function num(flag: string, v: string | undefined, { integer = true } = {}): number {
  if (v === undefined) throw new Error(`${flag} needs a value`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${flag} must be a non-negative ${integer ? 'integer' : 'number'}, got "${v}"`);
  }
  return n;
}

export function parseTrafficArgs(argv: readonly string[], defaultUrl = serviceConfig().paymentApiUrl): TrafficArgs {
  const args: TrafficArgs = { help: false, count: 10, seed: 42, rate: 2, url: defaultUrl, start: 0 };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const next = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--count':
        args.count = num(flag, next());
        break;
      case '--seed':
        args.seed = num(flag, next());
        break;
      case '--rate':
        args.rate = num(flag, next(), { integer: false });
        break;
      case '--start':
        args.start = num(flag, next());
        break;
      case '--scenario': {
        const v = next();
        if (!v) throw new Error('--scenario needs a value');
        args.scenario = v;
        break;
      }
      case '--url': {
        const v = next();
        if (!v) throw new Error('--url needs a value');
        args.url = v.replace(/\/+$/, '');
        break;
      }
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run traffic -- --help" for usage.`);
    }
  }
  return args;
}

export type Outcome = 'accepted' | 'duplicate' | 'error';

export interface SendResult {
  outcome: Outcome;
  status?: number;
  paymentId?: string;
  detail?: string;
}

/**
 * Classify a POST /payments response. A replay of a known Idempotency-Key is a duplicate when the API
 * says so (409, an Idempotent-Replayed header, or a duplicate/replayed flag in the body); any other
 * 2xx is a newly accepted payment.
 */
export function classifyResponse(status: number, headers: Headers, body: unknown): SendResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const paymentId = typeof b.paymentId === 'string' ? b.paymentId : undefined;
  const replayHeader = (headers.get('idempotent-replayed') ?? headers.get('idempotency-replayed') ?? '').toLowerCase();
  const duplicate =
    status === 409 || replayHeader === 'true' || b.duplicate === true || b.replayed === true || b.idempotentReplay === true;
  if (duplicate) return { outcome: 'duplicate', status, paymentId };
  if (status >= 200 && status < 300) return { outcome: 'accepted', status, paymentId };
  const base = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : JSON.stringify(body);
  const detail = Array.isArray(b.details) ? `${base}: ${b.details.join('; ')}` : base;
  return { outcome: 'error', status, paymentId, detail };
}

export async function sendPayment(baseUrl: string, p: GeneratedPayment): Promise<SendResult> {
  try {
    const res = await fetch(`${baseUrl}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': p.idempotencyKey },
      body: JSON.stringify(p.body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    return classifyResponse(res.status, res.headers, body);
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code;
    return { outcome: 'error', detail: code === 'ECONNREFUSED' ? `connection refused (${baseUrl})` : err.message };
  }
}
