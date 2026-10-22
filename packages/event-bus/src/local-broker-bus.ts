// EventBus client for the local broker (services/broker). Protocol: services/broker/README.md.
import WebSocket from 'ws';
import type { AnyEvent } from '@ct/contracts';
import type { DeliveryMeta, EventBus, EventHandler, SubscribeOptions, Subscription } from './types';

const PROTOCOL_VERSION = 2;

type BrokerMessage =
  | { op: 'welcome'; protocol: number; length: number }
  | { op: 'ack'; reqId: number; offset: number; duplicate?: boolean }
  | { op: 'subscribed'; reqId: number; subId: number; start: number }
  | { op: 'unsubscribed'; reqId: number; subId: number }
  | { op: 'deliver'; subId: number; offset: number; event: AnyEvent }
  | { op: 'deliver-batch'; subId: number; offset: number; events: AnyEvent[] }
  | { op: 'head'; reqId: number; length: number }
  | { op: 'error'; reqId?: number; message: string };

export interface LocalBrokerBusOptions {
  /** How long connect() keeps trying to reach the broker before rejecting. Default 10s. */
  connectTimeoutMs?: number;
  /** A publish that cannot be acknowledged (broker unreachable) within this time is rejected. Default 30s. */
  publishTimeoutMs?: number;
  /** Flow-control window per subscription: max deliveries buffered client-side. Default 1024. */
  window?: number;
  /** Max reconnect backoff. Default 2000ms. */
  maxReconnectDelayMs?: number;
  /** Max handler-retry backoff. Default 1000ms. */
  maxRetryDelayMs?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}

interface PendingPublish {
  event: AnyEvent;
  sentOnce: boolean;
  resolve: (m: DeliveryMeta) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingUnsub {
  resolve: () => void;
}

interface PendingHead {
  resolve: (length: number) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class LocalBrokerBus implements EventBus {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reqSeq = 0;
  private subSeq = 0;
  private readonly publishes = new Map<number, PendingPublish>();
  private readonly subs = new Map<number, ClientSub>();
  private readonly subscribeReqs = new Map<number, ClientSub>();
  private readonly unsubReqs = new Map<number, PendingUnsub>();
  private readonly headReqs = new Map<number, PendingHead>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 100;
  private readonly opts: Required<Omit<LocalBrokerBusOptions, 'logger'>> & { logger: Pick<Console, 'warn' | 'error'> };

  private constructor(
    private readonly url: string,
    private readonly clientId: string,
    options: LocalBrokerBusOptions,
  ) {
    this.opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      publishTimeoutMs: options.publishTimeoutMs ?? 30_000,
      window: Math.max(2, options.window ?? 1024),
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 2000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 1000,
      logger: options.logger ?? console,
    };
  }

  static async connect(url: string, clientId: string, options: LocalBrokerBusOptions = {}): Promise<EventBus> {
    const bus = new LocalBrokerBus(url, clientId, options);
    await bus.initialConnect();
    return bus;
  }

  /** True while a socket to the broker is open. */
  get isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------- connection

  private async initialConnect(): Promise<void> {
    const deadline = Date.now() + this.opts.connectTimeoutMs;
    let delay = 50;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await this.openSocket();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        delay = Math.min(delay * 2, 500);
      }
    }
    this.closed = true;
    throw new Error(`LocalBrokerBus: cannot reach broker at ${this.url}: ${String((lastErr as Error)?.message ?? lastErr)}`);
  }

  /** Opens a socket; resolves once open (and wired up), rejects if it fails before opening. */
  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let opened = false;
      ws.on('open', () => {
        if (this.closed) {
          ws.terminate();
          reject(new Error('bus closed'));
          return;
        }
        opened = true;
        this.ws = ws;
        this.connected = true;
        this.reconnectDelay = 100;
        this.onConnected();
        resolve();
      });
      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('close', () => {
        if (!opened) {
          reject(new Error('connection closed before open'));
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
          this.onDisconnected();
        }
      });
    });
  }

  private onConnected(): void {
    this.send({ op: 'hello', clientId: this.clientId, protocol: PROTOCOL_VERSION });
    for (const sub of this.subs.values()) this.sendSubscribe(sub);
    for (const [reqId, p] of this.publishes) {
      this.sendPublish(reqId, p.event, p.sentOnce);
      p.sentOnce = true;
    }
    for (const reqId of this.headReqs.keys()) this.send({ op: 'head', reqId });
  }

  private onDisconnected(): void {
    this.subscribeReqs.clear();
    // Nothing more will come from the old socket for these; the unsubscribe is moot once disconnected.
    for (const u of this.unsubReqs.values()) u.resolve();
    this.unsubReqs.clear();
    for (const sub of this.subs.values()) sub.onDisconnected();
    if (this.closed) return;
    this.opts.logger.warn(`[bus:${this.clientId}] lost connection to broker ${this.url}; reconnecting`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.opts.maxReconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openSocket().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private send(msg: object): boolean {
    return this.sendRaw(JSON.stringify(msg));
  }

  private sendRaw(frame: string): boolean {
    const ws = this.ws;
    if (!ws || !this.connected || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(frame);
    return true;
  }

  /**
   * Publish frame with `event` as the last key, so the broker can store the event's JSON as sent instead of
   * re-serializing it (see rawEventText in services/broker). The broker deduplicates by eventId either way.
   */
  private sendPublish(reqId: number, event: AnyEvent, retry: boolean): boolean {
    return this.sendRaw(`{"op":"publish","reqId":${reqId}${retry ? ',"retry":true' : ''},"event":${JSON.stringify(event)}}`);
  }

  private onMessage(raw: string): void {
    let msg: BrokerMessage;
    try {
      msg = JSON.parse(raw) as BrokerMessage;
    } catch {
      this.opts.logger.warn(`[bus:${this.clientId}] ignoring non-JSON frame from broker`);
      return;
    }
    switch (msg.op) {
      case 'welcome':
        return;
      case 'ack': {
        const p = this.publishes.get(msg.reqId);
        if (!p) return;
        this.publishes.delete(msg.reqId);
        clearTimeout(p.timer);
        p.resolve({ offset: msg.offset });
        return;
      }
      case 'subscribed': {
        const sub = this.subscribeReqs.get(msg.reqId);
        this.subscribeReqs.delete(msg.reqId);
        if (sub && this.subs.get(sub.subId) === sub) sub.onSubscribed(msg.start);
        return;
      }
      case 'unsubscribed': {
        const u = this.unsubReqs.get(msg.reqId);
        this.unsubReqs.delete(msg.reqId);
        u?.resolve();
        return;
      }
      case 'deliver':
        this.subs.get(msg.subId)?.onDeliver(msg.offset, msg.event);
        return;
      case 'deliver-batch': {
        const sub = this.subs.get(msg.subId);
        if (sub) msg.events.forEach((event, i) => sub.onDeliver(msg.offset + i, event));
        return;
      }
      case 'head': {
        const h = this.headReqs.get(msg.reqId);
        if (!h) return;
        this.headReqs.delete(msg.reqId);
        clearTimeout(h.timer);
        h.resolve(msg.length);
        return;
      }
      case 'error': {
        const err = new Error(`broker: ${msg.message}`);
        if (msg.reqId !== undefined) {
          const p = this.publishes.get(msg.reqId);
          if (p) {
            this.publishes.delete(msg.reqId);
            clearTimeout(p.timer);
            p.reject(err);
            return;
          }
          const sub = this.subscribeReqs.get(msg.reqId);
          if (sub) {
            this.subscribeReqs.delete(msg.reqId);
            this.subs.delete(sub.subId);
            sub.fail(err);
            return;
          }
        }
        this.opts.logger.warn(`[bus:${this.clientId}] ${err.message}`);
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- EventBus

  publish(event: AnyEvent): Promise<DeliveryMeta> {
    if (this.closed) return Promise.reject(new Error('bus closed'));
    return new Promise<DeliveryMeta>((resolve, reject) => {
      const reqId = ++this.reqSeq;
      const timer = setTimeout(() => {
        if (this.publishes.delete(reqId)) {
          reject(new Error(`publish timed out after ${this.opts.publishTimeoutMs}ms (broker ${this.url} unreachable)`));
        }
      }, this.opts.publishTimeoutMs);
      const p: PendingPublish = { event, sentOnce: false, resolve, reject, timer };
      this.publishes.set(reqId, p);
      if (this.sendPublish(reqId, event, false)) p.sentOnce = true;
      // else: queued; sent (with retry flag where needed) on reconnect.
    });
  }

  /** Number of durable events in the broker's log. Waits (up to publishTimeoutMs) for a connection. */
  head(): Promise<number> {
    if (this.closed) return Promise.reject(new Error('bus closed'));
    return new Promise<number>((resolve, reject) => {
      const reqId = ++this.reqSeq;
      const timer = setTimeout(() => {
        if (this.headReqs.delete(reqId)) reject(new Error(`head() timed out after ${this.opts.publishTimeoutMs}ms (broker ${this.url})`));
      }, this.opts.publishTimeoutMs);
      this.headReqs.set(reqId, { resolve, reject, timer });
      this.send({ op: 'head', reqId }); // else sent on reconnect
    });
  }

  async subscribe(options: SubscribeOptions, handler: EventHandler): Promise<Subscription> {
    if (this.closed) throw new Error('bus closed');
    const sub = new ClientSub(++this.subSeq, options, handler, this.opts, {
      credit: (subId, n) => this.send({ op: 'credit', subId, n }),
      commit: (subId, offset) => this.send({ op: 'commit', subId, offset }),
    });
    this.subs.set(sub.subId, sub);
    if (this.connected) this.sendSubscribe(sub);
    await sub.ready;
    return {
      unsubscribe: async () => {
        if (!this.subs.has(sub.subId)) return;
        this.subs.delete(sub.subId);
        await sub.stop();
        await this.sendUnsubscribe(sub.subId);
      },
    };
  }

  private sendSubscribe(sub: ClientSub): void {
    const reqId = ++this.reqSeq;
    this.subscribeReqs.set(reqId, sub);
    const window = sub.resetForSubscribe();
    this.send({
      op: 'subscribe',
      reqId,
      subId: sub.subId,
      group: sub.options.group,
      from: sub.options.from ?? 'earliest',
      ephemeral: sub.options.ephemeral === true,
      position: sub.position,
      credit: window,
      batch: true,
    });
  }

  private sendUnsubscribe(subId: number): Promise<void> {
    const reqId = ++this.reqSeq;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, 2000);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.unsubReqs.set(reqId, { resolve: done });
      if (!this.send({ op: 'unsubscribe', reqId, subId })) {
        this.unsubReqs.delete(reqId);
        done();
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const subs = [...this.subs.values()];
    this.subs.clear();
    await Promise.all(subs.map((s) => s.stop()));
    // Let the final commits go out on the socket, confirmed by an unsubscribe round trip.
    await Promise.all(subs.map((s) => this.sendUnsubscribe(s.subId)));
    for (const s of subs) s.fail(new Error('bus closed'));
    for (const p of this.publishes.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('bus closed'));
    }
    this.publishes.clear();
    for (const h of this.headReqs.values()) {
      clearTimeout(h.timer);
      h.reject(new Error('bus closed'));
    }
    this.headReqs.clear();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1000);
        ws.once('close', () => {
          clearTimeout(t);
          resolve();
        });
        ws.close();
      });
    }
  }
}

interface SubTransport {
  credit(subId: number, n: number): void;
  commit(subId: number, offset: number): void;
}

interface Item {
  offset: number;
  event: AnyEvent;
  gen: number;
}

/** One subscription: a bounded buffer fed by the broker and a strictly sequential handler loop. */
class ClientSub {
  /** Next offset this subscription still has to process; undefined until the broker assigns a start. */
  position: number | undefined;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private settled = false;
  private buffer: Item[] = [];
  private gen = 0;
  private owed = 0;
  private window = 0;
  private stopped = false;
  private wakeUp: (() => void) | null = null;
  private stopWake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    readonly subId: number,
    readonly options: SubscribeOptions,
    private readonly handler: EventHandler,
    private readonly opts: { window: number; maxRetryDelayMs: number; logger: Pick<Console, 'warn' | 'error'> },
    private readonly transport: SubTransport,
  ) {
    this.ready = new Promise<void>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => {});
  }

  /** Called right before (re)sending subscribe: drops anything buffered from an older connection. */
  resetForSubscribe(): number {
    this.gen += 1;
    this.buffer = [];
    this.owed = 0;
    this.window = this.opts.window;
    return this.window;
  }

  onSubscribed(start: number): void {
    if (this.position === undefined) this.position = start;
    if (!this.settled) {
      this.settled = true;
      this.resolveReady();
    }
    this.ensureLoop();
  }

  onDisconnected(): void {
    this.buffer = [];
    this.owed = 0;
  }

  fail(err: Error): void {
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(err);
    }
  }

  onDeliver(offset: number, event: AnyEvent): void {
    if (this.stopped) return;
    this.buffer.push({ offset, event, gen: this.gen });
    this.wakeUp?.();
  }

  private ensureLoop(): void {
    if (!this.loopPromise && !this.stopped) {
      this.loopPromise = this.loop().catch((err) => {
        this.opts.logger.error(`[bus] subscription ${this.options.group} loop crashed`, err);
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeUp?.();
    this.stopWake?.();
    await this.loopPromise;
  }

  private returnCredit(item: Item): void {
    if (item.gen !== this.gen) return;
    this.owed += 1;
    if (this.owed >= Math.ceil(this.window / 2)) {
      this.transport.credit(this.subId, this.owed);
      this.owed = 0;
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const item = this.buffer.shift();
      if (!item) {
        await new Promise<void>((r) => {
          this.wakeUp = r;
        });
        this.wakeUp = null;
        continue;
      }
      if (this.position !== undefined && item.offset < this.position) {
        // Redelivery after a reconnect of something we already processed.
        this.returnCredit(item);
        continue;
      }
      let attempt = 0;
      for (;;) {
        if (this.stopped) return; // not processed: stays uncommitted, will be redelivered
        try {
          await this.handler(item.event, { offset: item.offset });
          break;
        } catch (err) {
          attempt += 1;
          if (attempt === 1 || attempt % 20 === 0) {
            this.opts.logger.warn(
              `[bus] handler for group "${this.options.group}" failed at offset ${item.offset} (attempt ${attempt}), retrying: ${String((err as Error)?.message ?? err)}`,
            );
          }
          await this.interruptibleSleep(Math.min(this.opts.maxRetryDelayMs, 20 * 2 ** (attempt - 1)));
        }
      }
      this.position = item.offset + 1;
      if (!this.options.ephemeral) this.transport.commit(this.subId, this.position);
      this.returnCredit(item);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.stopWake = null;
        resolve();
      }, ms);
      this.stopWake = () => {
        clearTimeout(t);
        this.stopWake = null;
        resolve();
      };
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
