// M3 control plane (read side): projects control events (ControlTimeline) and keeps the small
// live aggregates the presenter console and the world map need: per-provider routing traffic in
// fixed time buckets and the most recent re-routes. Pure and clock-injected so it is unit tested.
import { ControlTimeline, PROVIDERS, type AnyEvent, type BreakerView, type ControlEvent, type PaymentState } from '@ct/contracts';
import type { ProviderTraffic, RerouteBrief, TrafficView } from './api-types';

export const TRAFFIC_BUCKET_MS = 5000;
export const TRAFFIC_BUCKETS = 12; // 60 s
export const MAX_REROUTES = 20;

interface Bucket {
  firstAttempt: number;
  rerouted: number;
  failed: number;
  settled: number;
}

const emptyBucket = (): Bucket => ({ firstAttempt: 0, rerouted: 0, failed: 0, settled: 0 });

/** Per-provider counts in fixed buckets keyed by floor(eventTime / bucketMs). */
export class TrafficMeter {
  private readonly byProvider = new Map<string, Map<number, Bucket>>();
  private maxBucket = Number.NEGATIVE_INFINITY;

  constructor(
    readonly bucketMs = TRAFFIC_BUCKET_MS,
    readonly buckets = TRAFFIC_BUCKETS,
  ) {}

  private bucket(providerId: string, atMs: number): Bucket | null {
    if (!Number.isFinite(atMs)) return null;
    const idx = Math.floor(atMs / this.bucketMs);
    // Ignore events far older than anything we keep (replays of old history cost nothing).
    if (idx <= this.maxBucket - this.buckets * 2) return null;
    let m = this.byProvider.get(providerId);
    if (!m) {
      m = new Map();
      this.byProvider.set(providerId, m);
    }
    let b = m.get(idx);
    if (!b) {
      b = emptyBucket();
      m.set(idx, b);
    }
    if (idx > this.maxBucket) {
      this.maxBucket = idx;
      this.prune();
    }
    return b;
  }

  private prune(): void {
    const cut = this.maxBucket - this.buckets * 2;
    for (const m of this.byProvider.values()) for (const k of m.keys()) if (k <= cut) m.delete(k);
  }

  record(event: AnyEvent): void {
    const at = Date.parse(event.occurredAt);
    switch (event.type) {
      case 'payment.routed': {
        const b = this.bucket(event.payload.providerId, at);
        if (!b) return;
        if ((event.payload.attempt ?? 1) <= 1) b.firstAttempt += 1;
        else b.rerouted += 1;
        return;
      }
      case 'payment.send_failed': {
        const b = this.bucket(event.payload.providerId, at);
        if (b) b.failed += 1;
        return;
      }
      case 'payment.settled': {
        const b = this.bucket(event.payload.providerId, at);
        if (b) b.settled += 1;
        return;
      }
      default:
        return;
    }
  }

  /** The last `buckets` buckets ending with the one containing `nowMs` (oldest first). */
  view(nowMs: number): TrafficView {
    const last = Math.floor(nowMs / this.bucketMs);
    const first = last - this.buckets + 1;
    const ids = new Set<string>(PROVIDERS.map((p) => p.id));
    for (const id of this.byProvider.keys()) ids.add(id);
    const providers: ProviderTraffic[] = [...ids].sort().map((providerId) => {
      const m = this.byProvider.get(providerId);
      const t: ProviderTraffic = { providerId, firstAttempt: [], rerouted: [], failed: [], settled: [], total: { firstAttempt: 0, rerouted: 0, failed: 0, settled: 0 } };
      for (let i = first; i <= last; i++) {
        const b = m?.get(i) ?? emptyBucket();
        t.firstAttempt.push(b.firstAttempt);
        t.rerouted.push(b.rerouted);
        t.failed.push(b.failed);
        t.settled.push(b.settled);
        t.total.firstAttempt += b.firstAttempt;
        t.total.rerouted += b.rerouted;
        t.total.failed += b.failed;
        t.total.settled += b.settled;
      }
      return t;
    });
    return { bucketMs: this.bucketMs, buckets: this.buckets, fromMs: first * this.bucketMs, toMs: (last + 1) * this.bucketMs, providers };
  }
}

/** Gateway-side control projection: control timeline + traffic + recent re-routes. */
export class ControlProjection {
  readonly timeline = new ControlTimeline();
  readonly traffic: TrafficMeter;
  private readonly reroutesList: RerouteBrief[] = [];
  /** Bumped whenever a control event is applied (push trigger). */
  version = 0;

  constructor(opts: { bucketMs?: number; buckets?: number } = {}) {
    this.traffic = new TrafficMeter(opts.bucketMs, opts.buckets);
  }

  applyControl(event: ControlEvent, offset: number): boolean {
    const before = this.timeline.current();
    this.timeline.apply(event, offset);
    const changed = this.timeline.current() !== before;
    if (changed) this.version += 1;
    return changed;
  }

  /** Call for every APPLIED payment event, with the payment's state after the event. */
  applyPayment(event: AnyEvent, state: PaymentState): void {
    this.traffic.record(event);
    if (event.type !== 'payment.routed') return;
    const attempt = event.payload.attempt ?? 1;
    if (attempt <= 1) return;
    const failed = state.facts['payment.send_failed'];
    const from = failed?.providerId ?? event.payload.excludedProviders?.at(-1);
    if (!from || from === event.payload.providerId) return;
    this.reroutesList.unshift({
      paymentId: event.paymentId,
      fromProviderId: from,
      toProviderId: event.payload.providerId,
      attempt,
      reasonCode: failed?.reasonCode,
      reason: failed?.reason,
      at: event.occurredAt,
    });
    if (this.reroutesList.length > MAX_REROUTES) this.reroutesList.length = MAX_REROUTES;
  }

  /** Newest first. */
  reroutes(): RerouteBrief[] {
    return [...this.reroutesList];
  }
}

export type BreakerFn = (states: Iterable<PaymentState>, atMs: number) => BreakerView[];

/** breakerStates() guarded: the gateway never fails because the breaker engine throws. */
export function safeBreakers(fn: BreakerFn, states: Iterable<PaymentState>, atMs: number): { breakers: BreakerView[]; error?: string } {
  try {
    const breakers = fn(states, atMs);
    return { breakers: Array.isArray(breakers) ? breakers : [] };
  } catch (err) {
    return { breakers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stable comparison key of a view for change detection (ignores fields that tick every request). */
export function changeKey(parts: unknown): string {
  return JSON.stringify(parts);
}
