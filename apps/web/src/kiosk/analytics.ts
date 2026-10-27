// Anonymous kiosk analytics: events are queued and sent in small batches to /api/booth/analytics.
// A random session id per visit (reset on idle). Never carries personal data; nothing is written to
// browser storage. If the booth service is down, events are dropped (bounded queue).
import type { AnalyticsEvent } from '@ct/contracts/browser';

export type AnalyticsType = AnalyticsEvent['type'];
export type AnalyticsData = NonNullable<AnalyticsEvent['data']>;

/** Random URL-safe id (matches the booth's [A-Za-z0-9_-]{8,64}). */
export function newSessionId(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = randomBytes(20);
  let s = 'k_';
  for (const b of bytes) s += alphabet[b & 63];
  return s;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export interface AnalyticsOptions {
  send: (events: AnalyticsEvent[]) => Promise<boolean>;
  now?: () => number;
  /** Flush as soon as this many events are queued. */
  batchSize?: number;
  /** Events beyond this are dropped (booth down for a long time). */
  maxQueue?: number;
  newId?: () => string;
}

export class AnalyticsBatcher {
  private queue: AnalyticsEvent[] = [];
  private inFlight: Promise<void> | null = null;
  private session: string;
  private visitStartedAt: number | null = null;
  private readonly send: AnalyticsOptions['send'];
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private readonly newId: () => string;
  enabled = true;
  dropped = 0;

  constructor(options: AnalyticsOptions) {
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 10, 50));
    this.maxQueue = options.maxQueue ?? 200;
    this.newId = options.newId ?? (() => newSessionId());
    this.session = this.newId();
  }

  get sessionId(): string {
    return this.session;
  }

  get pending(): readonly AnalyticsEvent[] {
    return this.queue;
  }

  get visitOpen(): boolean {
    return this.visitStartedAt !== null;
  }

  track(type: AnalyticsType, data?: AnalyticsData): void {
    if (!this.enabled) return;
    if (this.queue.length >= this.maxQueue) {
      this.dropped += 1;
      return;
    }
    const e: AnalyticsEvent = { sessionId: this.session, type, at: new Date(this.now()).toISOString() };
    if (data && Object.keys(data).length) e.data = { ...data };
    this.queue.push(e);
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  startVisit(): void {
    if (this.visitStartedAt !== null) return;
    this.visitStartedAt = this.now();
    this.track('visit.start');
  }

  /** Ends the visit (visit.end with dwell seconds), flushes, and starts a fresh anonymous session id. */
  async endVisit(reason: 'idle' | 'finished'): Promise<void> {
    if (this.visitStartedAt !== null) {
      const seconds = Math.max(0, Math.round((this.now() - this.visitStartedAt) / 1000));
      this.track('visit.end', { reason, seconds });
    }
    this.visitStartedAt = null;
    const flushing = this.flush();
    this.session = this.newId();
    await flushing;
  }

  /** Sends queued events (up to 50 per request). Failed batches are dropped, not retried forever. */
  flush(): Promise<void> {
    // Resolves only once nothing is queued or in flight (another caller may have taken the next batch).
    if (this.inFlight) return this.inFlight.then(() => this.flush());
    if (!this.queue.length) return Promise.resolve();
    const batch = this.queue.splice(0, 50);
    this.inFlight = (async () => {
      try {
        const ok = await this.send(batch);
        if (!ok) this.dropped += batch.length;
      } catch {
        this.dropped += batch.length;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight.then(() => this.flush());
  }
}
