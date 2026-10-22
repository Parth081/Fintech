// EventBus over Kafka/Redpanda (Docker profile, BUS=kafka). The kafkajs client is injected so the
// adapter logic can be unit-tested with a fake (see kafka-bus.test.ts).
import { randomUUID } from 'node:crypto';
import { PAYMENTS_TOPIC, type AnyEvent } from '@ct/contracts';
import type { DeliveryMeta, EventBus, EventHandler, SubscribeOptions, Subscription } from './types';

// ---- the slice of kafkajs this adapter uses (structurally compatible with kafkajs' Kafka) ----
export interface KafkaMessageLike {
  offset: string;
  key?: Buffer | string | null;
  value: Buffer | string | null;
}
export interface EachMessagePayloadLike {
  topic: string;
  partition: number;
  message: KafkaMessageLike;
}
export interface ProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    acks?: number;
    messages: { key: string; value: string }[];
  }): Promise<{ partition: number; baseOffset?: string; offset?: string }[]>;
}
export interface ConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(opts: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(opts: { autoCommit?: boolean; eachMessage: (p: EachMessagePayloadLike) => Promise<void> }): Promise<void>;
  commitOffsets(offsets: { topic: string; partition: number; offset: string }[]): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  events?: { GROUP_JOIN?: string };
}
export interface AdminLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTopics(opts: {
    topics: { topic: string; numPartitions?: number; replicationFactor?: number }[];
    waitForLeaders?: boolean;
  }): Promise<boolean>;
  /** kafkajs: per partition, `offset`/`high` = high watermark (next offset to be written). */
  fetchTopicOffsets?(topic: string): Promise<{ partition: number; offset: string; high?: string; low?: string }[]>;
}
export interface KafkaLike {
  producer(config?: Record<string, unknown>): ProducerLike;
  consumer(config: { groupId: string } & Record<string, unknown>): ConsumerLike;
  admin?(): AdminLike;
}

export interface KafkaBusOptions {
  topic?: string;
  /** Max handler-retry backoff. Default 1000ms. */
  maxRetryDelayMs?: number;
  /** How long subscribe() waits for the consumer to join its group. Default 15s. */
  groupJoinTimeoutMs?: number;
  /** Create the topic (1 partition) on start. Default true. */
  ensureTopic?: boolean;
  /**
   * How many recently published / delivered eventIds are remembered for de-duplication (publish side per
   * bus, delivery side per subscription). Default 1,000,000 (~10k payments x 12 events fit many times over).
   */
  dedupeWindow?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}

/**
 * Idempotency on Kafka (see docs/adr/0006). Kafka has no "append unless this key exists", so the
 * guarantee is layered:
 *  1. idempotent producer (acks=all, max 1 in flight): broker-side retries of one send never duplicate;
 *  2. publish() is idempotent per bus instance: the same eventId published again (sequentially or
 *     concurrently) returns the first offset without sending;
 *  3. every subscription drops a delivery whose eventId it has already handed to its handler, so a
 *     duplicate that still reaches the log (a process killed after its send reached Kafka, then the
 *     restarted process re-publishing before it caught up) is never processed twice;
 *  4. stages catch up to head() before acting and the state machine ignores known eventIds.
 * What remains possible is a duplicate *record* in the topic in that crash window; the local broker,
 * which deduplicates at append time, has no such window.
 */
export class KafkaBus implements EventBus {
  private admin: AdminLike | null = null;
  private adminReady: Promise<AdminLike> | null = null;
  private published: BoundedMap<string, Promise<DeliveryMeta>>;

  /** High watermark of the single partition = number of records in the topic. */
  async head(): Promise<number> {
    if (this.closed) throw new Error('bus closed');
    await this.start();
    const admin = await this.getAdmin();
    if (!admin.fetchTopicOffsets) throw new Error('kafka admin client cannot fetch topic offsets');
    const parts = await admin.fetchTopicOffsets(this.topic);
    const p0 = parts.find((p) => p.partition === 0) ?? parts[0];
    if (!p0) throw new Error(`kafka: topic ${this.topic} has no partitions`);
    return Number(p0.high ?? p0.offset);
  }

  private getAdmin(): Promise<AdminLike> {
    this.adminReady ??= (async () => {
      if (!this.kafka.admin) throw new Error('kafka client has no admin()');
      const admin = this.kafka.admin();
      await admin.connect();
      this.admin = admin;
      return admin;
    })().catch((err) => {
      this.adminReady = null;
      throw err;
    });
    return this.adminReady;
  }

  private readonly producer: ProducerLike;
  private started: Promise<void> | null = null;
  private closed = false;
  private readonly subs = new Set<KafkaSub>();
  private readonly topic: string;
  private readonly opts: Required<Omit<KafkaBusOptions, 'topic' | 'logger'>> & { logger: Pick<Console, 'warn' | 'error'> };

  constructor(private readonly kafka: KafkaLike, options: KafkaBusOptions = {}) {
    this.topic = options.topic ?? PAYMENTS_TOPIC;
    this.opts = {
      maxRetryDelayMs: options.maxRetryDelayMs ?? 1000,
      groupJoinTimeoutMs: options.groupJoinTimeoutMs ?? 15_000,
      ensureTopic: options.ensureTopic ?? true,
      dedupeWindow: options.dedupeWindow ?? 1_000_000,
      logger: options.logger ?? console,
    };
    this.published = new BoundedMap(this.opts.dedupeWindow);
    // Idempotent + one in-flight request keeps publish order = log order.
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  }

  static async connect(brokers: string[], clientId: string, options: KafkaBusOptions = {}): Promise<EventBus> {
    const mod = await import('kafkajs');
    const kafkajs = ((mod as { default?: unknown }).default ?? mod) as typeof import('kafkajs');
    const kafka = new kafkajs.Kafka({ clientId, brokers, logLevel: kafkajs.logLevel.WARN });
    const bus = new KafkaBus(kafka as unknown as KafkaLike, options);
    await bus.start();
    return bus;
  }

  /** Connects the producer and makes sure the single-partition topic exists. Idempotent. */
  start(): Promise<void> {
    this.started ??= (async () => {
      if (this.opts.ensureTopic && this.kafka.admin) {
        const admin = this.kafka.admin();
        await admin.connect();
        try {
          // Single partition so the order of the whole lifecycle log is global. No-op if it exists.
          await admin.createTopics({ topics: [{ topic: this.topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
        } finally {
          await admin.disconnect();
        }
      }
      await this.producer.connect();
    })();
    return this.started;
  }

  publish(event: AnyEvent): Promise<DeliveryMeta> {
    if (this.closed) return Promise.reject(new Error('bus closed'));
    const known = this.published.get(event.eventId);
    if (known) return known;
    const p = this.send(event);
    this.published.set(event.eventId, p);
    // A failed send may be retried by the caller: forget it so the retry really sends.
    p.catch(() => {
      if (this.published.get(event.eventId) === p) this.published.delete(event.eventId);
    });
    return p;
  }

  private async send(event: AnyEvent): Promise<DeliveryMeta> {
    await this.start();
    const result = await this.producer.send({
      topic: this.topic,
      acks: -1, // all in-sync replicas: durable before we resolve
      messages: [{ key: event.paymentId, value: JSON.stringify(event) }],
    });
    const meta = result[0];
    const raw = meta?.baseOffset ?? meta?.offset;
    if (raw === undefined) throw new Error('kafka: send returned no offset');
    return { offset: Number(raw) };
  }

  async subscribe(options: SubscribeOptions, handler: EventHandler): Promise<Subscription> {
    if (this.closed) throw new Error('bus closed');
    await this.start();
    const from = options.from ?? 'earliest';
    const groupId = options.ephemeral ? `${options.group}.ephemeral.${randomUUID()}` : options.group;
    const consumer = this.kafka.consumer({ groupId });
    const sub = new KafkaSub(consumer, this.topic, options, handler, this.opts, new BoundedSet(this.opts.dedupeWindow));
    await consumer.connect();
    const joined = waitForGroupJoin(consumer, this.opts.groupJoinTimeoutMs);
    // A group with a committed offset resumes from it; fromBeginning only applies when there is none.
    // Ephemeral groups are fresh every time, so they always start at `from`.
    await consumer.subscribe({ topic: this.topic, fromBeginning: from === 'earliest' });
    await consumer.run({ autoCommit: false, eachMessage: (p) => sub.onMessage(p) });
    // For 'latest' we want "events published after subscribe() resolved", so wait for the group join.
    await joined;
    this.subs.add(sub);
    return {
      unsubscribe: async () => {
        if (!this.subs.delete(sub)) return;
        await sub.stop();
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const subs = [...this.subs];
    this.subs.clear();
    await Promise.all(subs.map((s) => s.stop()));
    if (this.started) {
      await this.started.catch(() => {});
      await this.producer.disconnect();
    }
    await this.adminReady?.catch(() => null);
    await this.admin?.disconnect().catch(() => {});
    this.admin = null;
  }
}

/** Insertion-ordered map that forgets its oldest entries beyond `capacity`. */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(k: K): V | undefined {
    return this.map.get(k);
  }
  has(k: K): boolean {
    return this.map.has(k);
  }
  set(k: K, v: V): void {
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  delete(k: K): void {
    this.map.delete(k);
  }
}

class BoundedSet<K> {
  private readonly map: BoundedMap<K, true>;
  constructor(capacity: number) {
    this.map = new BoundedMap(capacity);
  }
  has(k: K): boolean {
    return this.map.has(k);
  }
  add(k: K): void {
    this.map.set(k, true);
  }
}

function waitForGroupJoin(consumer: ConsumerLike, timeoutMs: number): Promise<void> {
  const eventName = consumer.events?.GROUP_JOIN;
  if (!consumer.on || !eventName) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs); // don't hang forever; consumption continues regardless
    consumer.on!(eventName, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

class KafkaSub {
  private stopped = false;
  private stopWake: (() => void) | null = null;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly consumer: ConsumerLike,
    private readonly topic: string,
    private readonly options: SubscribeOptions,
    private readonly handler: EventHandler,
    private readonly opts: { maxRetryDelayMs: number; logger: Pick<Console, 'warn' | 'error'> },
    private readonly seen: BoundedSet<string>,
  ) {}

  /** kafkajs calls this sequentially per partition (one partition => strictly sequential). */
  async onMessage({ topic, partition, message }: EachMessagePayloadLike): Promise<void> {
    if (this.stopped) return;
    const offset = Number(message.offset);
    let event: AnyEvent | null = null;
    try {
      const text = typeof message.value === 'string' ? message.value : message.value?.toString('utf8');
      event = text ? (JSON.parse(text) as AnyEvent) : null;
    } catch {
      event = null;
    }
    if (event && this.seen.has(event.eventId)) {
      // Duplicate record of an event this subscription already handled (see the KafkaBus doc comment).
      event = null;
    } else if (!event) {
      this.opts.logger.warn(`[bus] skipping unparseable message at ${topic}/${partition}@${message.offset}`);
    }
    if (event) {
      let attempt = 0;
      for (;;) {
        if (this.stopped) return; // not committed: redelivered to the group later
        try {
          await this.handler(event, { offset });
          break;
        } catch (err) {
          attempt += 1;
          if (attempt === 1 || attempt % 20 === 0) {
            this.opts.logger.warn(
              `[bus] handler for group "${this.options.group}" failed at offset ${offset} (attempt ${attempt}), retrying: ${String((err as Error)?.message ?? err)}`,
            );
          }
          await this.sleep(Math.min(this.opts.maxRetryDelayMs, 20 * 2 ** (attempt - 1)));
        }
      }
      this.seen.add(event.eventId);
    }
    if (!this.options.ephemeral) {
      // Kafka's committed offset is the *next* offset to read.
      await this.consumer.commitOffsets([{ topic, partition, offset: String(offset + 1) }]);
    }
  }

  private sleep(ms: number): Promise<void> {
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

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      this.stopWake?.();
      await this.consumer.disconnect(); // waits for an in-flight eachMessage to return
    })();
    return this.stopping;
  }
}
