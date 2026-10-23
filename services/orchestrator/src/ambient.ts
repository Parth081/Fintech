// Ambient traffic: a steady stream of seeded synthetic payments (traffic v2 generator). Payment `index`
// always has the same body and Idempotency-Key for a seed, so a restarted orchestrator that re-sends an
// index never creates a second payment (the Payment API dedupes by key).
import { generatePayment, hash32, type GeneratedPayment } from '../../../tools/traffic/generator';
import { sendPayment, type SendResult } from '../../../tools/traffic/send';
import type { Clock, TimerHandle } from './clock';

export const MAX_AMBIENT_RATE = 50;
const MAX_IN_FLIGHT = 32;
const MAX_RETRY_QUEUE = 1000;

export type PaymentSender = (baseUrl: string, p: GeneratedPayment) => Promise<SendResult>;

export function ambientKeyPrefix(seed: string): string {
  return `ambient-${seed.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}-`;
}

/** The ambient payment with this index (deterministic for seed + index). */
export function ambientPayment(seed: string, index: number): GeneratedPayment {
  const p = generatePayment(hash32(`ambient:${seed}`), index);
  return { ...p, idempotencyKey: `${ambientKeyPrefix(seed)}${index}` };
}

/** Index encoded in an ambient Idempotency-Key, or undefined if the key is not ours. */
export function ambientIndexOf(seed: string, key: string): number | undefined {
  const prefix = ambientKeyPrefix(seed);
  if (!key.startsWith(prefix)) return undefined;
  const n = Number(key.slice(prefix.length));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export interface AmbientOptions {
  seed: string;
  paymentApiUrl: string;
  clock: Clock;
  rate: number;
  send?: PaymentSender;
  log?: (line: string) => void;
}

export class AmbientTraffic {
  private rateValue: number;
  private pausedValue = false;
  private timer: TimerHandle | undefined;
  private nextIndex = 0;
  private readonly retry: number[] = [];
  private inFlight = 0;
  private readonly inFlightSet = new Set<Promise<void>>();
  private sentCount = 0;
  private errors = 0;
  private stopped = false;
  private readonly send: PaymentSender;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: AmbientOptions) {
    this.rateValue = clampRate(opts.rate);
    this.send = opts.send ?? sendPayment;
    this.log = opts.log ?? (() => {});
  }

  get rate(): number {
    return this.rateValue;
  }
  get sent(): number {
    return this.sentCount;
  }
  get running(): boolean {
    return this.rateValue > 0 && !this.stopped;
  }
  get next(): number {
    return this.nextIndex;
  }

  /** Never re-use indexes below `index` (restart: continue after what the log already holds). */
  resumeFrom(index: number, alreadySent: number): void {
    if (index > this.nextIndex) this.nextIndex = index;
    if (alreadySent > this.sentCount) this.sentCount = alreadySent;
  }

  start(): void {
    this.schedule();
  }

  setRate(rate: number): void {
    this.rateValue = clampRate(rate);
    this.schedule();
  }

  setPaused(paused: boolean): void {
    this.pausedValue = paused;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.opts.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inFlightSet]);
  }

  private schedule(): void {
    this.opts.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.pausedValue || this.rateValue <= 0) return;
    this.timer = this.opts.clock.setTimeout(() => this.tick(), 1000 / this.rateValue);
  }

  private tick(): void {
    this.timer = undefined;
    if (this.stopped || this.pausedValue || this.rateValue <= 0) return;
    if (this.inFlight < MAX_IN_FLIGHT) {
      const index = this.retry.shift() ?? this.nextIndex++;
      this.fire(index);
    }
    this.schedule();
  }

  private fire(index: number): void {
    this.inFlight += 1;
    const p = (async () => {
      const result = await this.send(this.opts.paymentApiUrl, ambientPayment(this.opts.seed, index));
      if (result.outcome === 'error') {
        this.errors += 1;
        if (this.retry.length < MAX_RETRY_QUEUE) this.retry.push(index);
        if (this.errors === 1 || this.errors % 50 === 0) {
          this.log(`[orchestrator] ambient payment ${index} failed (${result.status ?? '-'} ${result.detail ?? ''}); will retry (errors so far: ${this.errors})`);
        }
      } else {
        this.sentCount += 1;
      }
    })()
      .catch(() => {
        if (this.retry.length < MAX_RETRY_QUEUE) this.retry.push(index);
      })
      .finally(() => {
        this.inFlight -= 1;
        this.inFlightSet.delete(p);
      });
    this.inFlightSet.add(p);
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return Math.min(MAX_AMBIENT_RATE, rate);
}
