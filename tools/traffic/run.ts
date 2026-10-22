// Rate-controlled, bounded-concurrency sender shared by `npm run traffic` and `npm run verify:m2`.
import { generatePayment, type GenerateOptions, type GeneratedPayment } from './generator';
import { sendPayment, type Outcome, type SendResult } from './send';

export interface RunTrafficOptions extends GenerateOptions {
  url: string;
  seed: number;
  count: number;
  start?: number;
  /** Payments per second; 0 = as fast as `concurrency` allows. */
  rate: number;
  /** Max requests in flight (default 8). */
  concurrency?: number;
  /** Transport errors / 5xx are retried this many times with the same Idempotency-Key (safe). Default 3. */
  retries?: number;
  /** Called after every payment (in completion order). */
  onResult?: (p: GeneratedPayment, r: SendResult) => void;
  /** Stop early (e.g. API unreachable); checked between payments. */
  shouldStop?: () => boolean;
}

export interface TrafficResult {
  payment: GeneratedPayment;
  result: SendResult;
  attempts: number;
}

export interface TrafficSummary {
  results: TrafficResult[];
  counts: Record<Outcome, number>;
  retried: number;
  durationMs: number;
  /** Accepted + duplicate per second over the run. */
  achievedRate: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryable(r: SendResult): boolean {
  return r.outcome === 'error' && (r.status === undefined || r.status >= 500 || r.status === 429);
}

export async function runTraffic(opts: RunTrafficOptions): Promise<TrafficSummary> {
  const start = opts.start ?? 0;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const maxRetries = opts.retries ?? 3;
  const intervalMs = opts.rate > 0 ? 1000 / opts.rate : 0;
  const results: TrafficResult[] = new Array(opts.count);
  const counts: Record<Outcome, number> = { accepted: 0, duplicate: 0, error: 0 };
  let retried = 0;
  let next = 0;
  const t0 = Date.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.shouldStop?.()) return;
      const i = next++;
      if (i >= opts.count) return;
      // Open-loop schedule: payment i is due at t0 + i/rate regardless of how long earlier ones took.
      const wait = t0 + i * intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      const payment = generatePayment(opts.seed, start + i, opts);
      let attempts = 0;
      let result: SendResult;
      for (;;) {
        attempts += 1;
        result = await sendPayment(opts.url, payment);
        if (!retryable(result) || attempts > maxRetries) break;
        retried += 1;
        await sleep(100 * 2 ** (attempts - 1));
      }
      counts[result.outcome] += 1;
      results[i] = { payment, result, attempts };
      opts.onResult?.(payment, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, opts.count)) }, worker));
  const durationMs = Date.now() - t0;
  return {
    results: results.filter(Boolean),
    counts,
    retried,
    durationMs,
    achievedRate: durationMs > 0 ? ((counts.accepted + counts.duplicate) * 1000) / durationMs : 0,
  };
}
