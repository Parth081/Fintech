// Turns WebSocket messages into map dots and traffic shares. Pure apart from its own state (no DOM),
// so the whole feed -> dots path is unit-testable.
//
// The gateway sends, per 50 ms window, the latest summary of each changed payment plus the event
// briefs (type + paymentId, no payload). The provider of a routed/sent event is taken from the
// payment's summary. If a frame was capped and the summary arrives a frame later, the event waits
// here briefly (PENDING_MS) instead of being lost.
import { isTerminal, type PaymentStatus } from '@ct/contracts/browser';
import { applyDotEvents, clearDots, createDotEngine, DEFAULT_DOT_CONFIG, isDotEvent, type DotConfig, type DotEngine, type DotEvent } from './dots';
import { routeKey } from './geo';
import { TrafficWindow } from './traffic';

export interface PaymentRef {
  corridor: string;
  providerId?: string;
  status: PaymentStatus;
}

export interface FeedPayment {
  paymentId: string;
  corridor: string;
  providerId?: string;
  status: PaymentStatus;
}

export type FeedMessage =
  | { kind: 'snapshot'; payments: readonly FeedPayment[] }
  | { kind: 'update'; payments: readonly FeedPayment[]; events: readonly DotEvent[] }
  | { kind: 'stats' };

export const PENDING_MS = 2_000;
export const MAX_REFS = 4_000;

export interface IngestOptions {
  /** Route hub position by route key; routes not listed get no dots. */
  routes: ReadonlyMap<string, { hubT: number }>;
  config?: DotConfig;
  /** True when new dots to this provider are probes (breaker half-open). */
  isProbe?: (providerId: string) => boolean;
}

export class StageIngest {
  readonly engine: DotEngine = createDotEngine();
  readonly traffic = new TrafficWindow();
  config: DotConfig;
  isProbe: (providerId: string) => boolean;
  private readonly routes: ReadonlyMap<string, { hubT: number }>;
  private readonly refs = new Map<string, PaymentRef>();
  private pending: { e: DotEvent; at: number }[] = [];

  constructor(opts: IngestOptions) {
    this.routes = opts.routes;
    this.config = opts.config ?? DEFAULT_DOT_CONFIG;
    this.isProbe = opts.isProbe ?? (() => false);
  }

  get refCount(): number {
    return this.refs.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Forget everything (the demo was reset: old payments, dots and traffic are gone). */
  reset(): void {
    clearDots(this.engine);
    this.traffic.clear();
    this.refs.clear();
    this.pending = [];
  }

  private remember(p: FeedPayment): void {
    this.refs.delete(p.paymentId); // re-insert: Map order doubles as recency
    this.refs.set(p.paymentId, { corridor: p.corridor, providerId: p.providerId, status: p.status });
  }

  private hubT = (key: string): number => this.routes.get(key)?.hubT ?? 0.5;

  apply(msg: FeedMessage, nowMs: number): void {
    if (msg.kind === 'stats') return;
    if (msg.kind === 'snapshot') {
      this.pending = [];
      for (const p of msg.payments) this.remember(p);
      this.trimRefs();
      return;
    }
    for (const p of msg.payments) this.remember(p);

    const queue = [...this.pending, ...msg.events.filter((e) => isDotEvent(e.type)).map((e) => ({ e, at: nowMs }))];
    this.pending = [];
    const waiting = new Set<string>();
    for (const item of queue) {
      const { e } = item;
      if (waiting.has(e.paymentId)) {
        this.keep(item, nowMs);
        continue;
      }
      const spawn = e.type === 'payment.routed' || e.type === 'payment.sent';
      const ref = this.refs.get(e.paymentId);
      if (spawn && !ref?.providerId && !this.engine.active.has(e.paymentId)) {
        if (this.keep(item, nowMs)) waiting.add(e.paymentId);
        continue;
      }
      if (e.type === 'payment.routed' && ref?.providerId) this.traffic.record(ref.providerId, nowMs);
      applyDotEvents(this.engine, [e], (id) => this.resolve(id), this.config, this.hubT);
    }

    // Forget finished payments (a late duplicate event then simply makes no dot).
    for (const p of msg.payments) if (isTerminal(p.status) && !this.engine.active.has(p.paymentId)) this.refs.delete(p.paymentId);
    this.trimRefs();
  }

  private keep(item: { e: DotEvent; at: number }, nowMs: number): boolean {
    if (nowMs - item.at > PENDING_MS) return false;
    this.pending.push(item);
    return true;
  }

  private resolve(paymentId: string) {
    const ref = this.refs.get(paymentId);
    if (!ref?.providerId) return null;
    const key = routeKey(ref.corridor, ref.providerId);
    const route = this.routes.get(key);
    if (!route) return null;
    return { routeKey: key, providerId: ref.providerId, hubT: route.hubT, probe: this.isProbe(ref.providerId) };
  }

  private trimRefs(): void {
    if (this.refs.size <= MAX_REFS) return;
    let extra = this.refs.size - MAX_REFS;
    for (const id of this.refs.keys()) {
      if (extra-- <= 0) break;
      this.refs.delete(id);
    }
  }
}
