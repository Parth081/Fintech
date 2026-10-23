import type { AnyEvent, BusEvent } from '@ct/contracts';
import type { DeliveryMeta, EventBus, EventHandler, SubscribeOptions, Subscription } from './types';

/** Single-process bus for unit tests. Same delivery semantics as the real buses, no persistence. */
export class InMemoryBus implements EventBus {
  private readonly log: BusEvent[] = [];
  private readonly committed = new Map<string, number>();
  private readonly consumers = new Set<Consumer>();
  private closed = false;

  get events(): readonly BusEvent[] {
    return this.log;
  }

  /** Payment events only (control events filtered out). Test helper. */
  get paymentEvents(): AnyEvent[] {
    return this.log.filter((e): e is AnyEvent => !e.type.startsWith('control.'));
  }

  private readonly offsetsById = new Map<string, number>();

  async head(): Promise<number> {
    return this.log.length;
  }

  async publish(event: BusEvent): Promise<DeliveryMeta> {
    if (this.closed) throw new Error('bus closed');
    const existing = this.offsetsById.get(event.eventId);
    if (existing !== undefined) return { offset: existing };
    const offset = this.log.push(structuredClone(event)) - 1;
    this.offsetsById.set(event.eventId, offset);
    for (const c of this.consumers) c.wake();
    return { offset };
  }

  async subscribe(options: SubscribeOptions, handler: EventHandler): Promise<Subscription> {
    if (this.closed) throw new Error('bus closed');
    const from = options.from ?? 'earliest';
    const start = options.ephemeral
      ? from === 'earliest' ? 0 : this.log.length
      : this.committed.get(options.group) ?? (from === 'earliest' ? 0 : this.log.length);
    const consumer = new Consumer(this, options, handler, start);
    this.consumers.add(consumer);
    consumer.wake();
    return {
      unsubscribe: async () => {
        this.consumers.delete(consumer);
        await consumer.stop();
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.consumers].map((c) => c.stop()));
    this.consumers.clear();
  }

  /** Resolves when every active consumer has processed the whole log. Test helper. */
  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ([...this.consumers].some((c) => c.position < this.log.length || c.busy)) {
      if (Date.now() > deadline) throw new Error('drain timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** @internal */
  read(offset: number): BusEvent | undefined {
    const e = this.log[offset];
    return e === undefined ? undefined : structuredClone(e);
  }

  /** @internal */
  commit(group: string, nextOffset: number): void {
    this.committed.set(group, nextOffset);
  }
}

class Consumer {
  position: number;
  busy = false;
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly bus: InMemoryBus,
    private readonly options: SubscribeOptions,
    private readonly handler: EventHandler,
    start: number,
  ) {
    this.position = start;
  }

  wake(): void {
    if (!this.running && !this.stopped) {
      this.running = this.loop().finally(() => {
        this.running = null;
        // An event published after loop() saw the end of the log but before this cleanup would
        // otherwise wait for the next publish.
        if (!this.stopped && this.bus.read(this.position)) this.wake();
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const event = this.bus.read(this.position);
      if (!event) return;
      this.busy = true;
      try {
        await this.handler(event, { offset: this.position });
        this.position += 1;
        if (!this.options.ephemeral) this.bus.commit(this.options.group, this.position);
      } catch {
        await new Promise((r) => setTimeout(r, 20)); // retry same event
      } finally {
        this.busy = false;
      }
    }
  }
}
