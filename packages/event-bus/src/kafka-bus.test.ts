import { describe, expect, it } from 'vitest';
import { PAYMENTS_TOPIC } from '@ct/contracts';
import { happyPath } from '@ct/contracts/testing';
import { KafkaBus, type ConsumerLike, type EachMessagePayloadLike, type KafkaLike, type ProducerLike } from './kafka-bus';

const quiet = { warn: () => {}, error: () => {} };

/** A tiny single-partition Kafka imitation with kafkajs-like consumer-group semantics. */
class FakeKafka implements KafkaLike {
  readonly log: { key: string; value: string }[] = [];
  readonly committed = new Map<string, number>();
  readonly commits: { groupId: string; offset: string }[] = [];
  readonly createdTopics: { topic: string; numPartitions?: number }[] = [];
  readonly groupIds: string[] = [];
  producerConfig: Record<string, unknown> | undefined;
  private readonly wakers = new Set<() => void>();

  producer(config?: Record<string, unknown>): ProducerLike {
    this.producerConfig = config;
    return {
      connect: async () => {},
      disconnect: async () => {},
      send: async ({ topic, messages }) => {
        expect(topic).toBe(PAYMENTS_TOPIC);
        const base = this.log.length;
        this.log.push(...messages);
        for (const w of this.wakers) w();
        return [{ partition: 0, baseOffset: String(base) }];
      },
    };
  }

  admin() {
    return {
      connect: async () => {},
      disconnect: async () => {},
      createTopics: async ({ topics }: { topics: { topic: string; numPartitions?: number }[] }) => {
        this.createdTopics.push(...topics);
        return true;
      },
    };
  }

  consumer({ groupId }: { groupId: string }): ConsumerLike {
    this.groupIds.push(groupId);
    let fromBeginning = false;
    let running: Promise<void> | null = null;
    let stopped = false;
    let wake: (() => void) | null = null;
    const listeners: (() => void)[] = [];
    const fake = this;
    return {
      events: { GROUP_JOIN: 'consumer.group_join' },
      on: (_event: string, l: () => void) => listeners.push(l),
      connect: async () => {},
      subscribe: async (o) => {
        fromBeginning = o.fromBeginning ?? false;
      },
      run: async ({ eachMessage }) => {
        let pos = fake.committed.get(groupId) ?? (fromBeginning ? 0 : fake.log.length);
        const waker = () => wake?.();
        fake.wakers.add(waker);
        running = (async () => {
          while (!stopped) {
            const m = fake.log[pos];
            if (!m) {
              await new Promise<void>((r) => { wake = r; });
              continue;
            }
            const payload: EachMessagePayloadLike = {
              topic: PAYMENTS_TOPIC,
              partition: 0,
              message: { offset: String(pos), key: Buffer.from(m.key), value: Buffer.from(m.value) },
            };
            await eachMessage(payload);
            pos += 1;
          }
          fake.wakers.delete(waker);
        })();
        setTimeout(() => listeners.forEach((l) => l()), 1);
      },
      commitOffsets: async (offsets) => {
        for (const o of offsets) {
          fake.committed.set(groupId, Number(o.offset));
          fake.commits.push({ groupId, offset: o.offset });
        }
      },
      disconnect: async () => {
        stopped = true;
        wake?.();
        await running;
      },
    };
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('KafkaBus (fake kafkajs client)', () => {
  it('creates a single-partition topic, keys by paymentId, returns Kafka offsets', async () => {
    const kafka = new FakeKafka();
    const bus = new KafkaBus(kafka, { logger: quiet });
    const evs = happyPath('pay-1');
    const metas = [];
    for (const e of evs.slice(0, 3)) metas.push(await bus.publish(e));
    expect(metas.map((m) => m.offset)).toEqual([0, 1, 2]);
    expect(kafka.createdTopics).toEqual([{ topic: PAYMENTS_TOPIC, numPartitions: 1, replicationFactor: 1 }]);
    expect(kafka.producerConfig).toMatchObject({ idempotent: true, maxInFlightRequests: 1 });
    expect(kafka.log[0]!.key).toBe('pay-1');
    expect(JSON.parse(kafka.log[0]!.value).eventId).toBe(evs[0]!.eventId);
    await bus.close();
  });

  it('consumes in order, commits next offset after the handler, resumes the group', async () => {
    const kafka = new FakeKafka();
    const bus = new KafkaBus(kafka, { logger: quiet });
    const evs = happyPath('pay-2');
    for (const e of evs.slice(0, 3)) await bus.publish(e);
    const seen: number[] = [];
    const sub = await bus.subscribe({ group: 'risk' }, (e, m) => {
      expect(e.eventId).toBe(evs[m.offset]!.eventId);
      seen.push(m.offset);
    });
    await waitFor(() => seen.length === 3);
    expect(kafka.groupIds).toEqual(['risk']);
    await waitFor(() => kafka.committed.get('risk') === 3);
    expect(kafka.commits.map((c) => c.offset)).toEqual(['1', '2', '3']);
    await sub.unsubscribe();

    for (const e of evs.slice(3, 5)) await bus.publish(e);
    await bus.subscribe({ group: 'risk' }, (_e, m) => { seen.push(m.offset); });
    await waitFor(() => seen.length === 5);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    await bus.close();
  });

  it('retries a throwing handler without committing until it succeeds', async () => {
    const kafka = new FakeKafka();
    const bus = new KafkaBus(kafka, { logger: quiet });
    for (const e of happyPath('pay-3').slice(0, 2)) await bus.publish(e);
    const calls: number[] = [];
    let fails = 0;
    await bus.subscribe({ group: 'g' }, (_e, m) => {
      calls.push(m.offset);
      if (m.offset === 0 && fails < 2) {
        fails += 1;
        expect(kafka.committed.get('g')).toBeUndefined();
        throw new Error('boom');
      }
    });
    await waitFor(() => calls.length === 4);
    expect(calls).toEqual([0, 0, 0, 1]);
    await waitFor(() => kafka.committed.get('g') === 2);
    await bus.close();
  });

  it('ephemeral subscriptions use a unique group, never commit, and honour from', async () => {
    const kafka = new FakeKafka();
    const bus = new KafkaBus(kafka, { logger: quiet });
    const evs = happyPath('pay-4');
    for (const e of evs.slice(0, 2)) await bus.publish(e);
    const early: number[] = [];
    const late: number[] = [];
    await bus.subscribe({ group: 'view', ephemeral: true }, (_e, m) => { early.push(m.offset); });
    await bus.subscribe({ group: 'view', ephemeral: true, from: 'latest' }, (_e, m) => { late.push(m.offset); });
    await bus.publish(evs[2]!);
    await waitFor(() => early.length === 3 && late.length === 1);
    expect(late).toEqual([2]);
    expect(kafka.groupIds).toHaveLength(2);
    expect(new Set(kafka.groupIds).size).toBe(2);
    expect(kafka.groupIds.every((g) => g.startsWith('view.ephemeral.'))).toBe(true);
    expect(kafka.commits).toEqual([]);
    await bus.close();
  });

  it('unsubscribe during retries stops without committing', async () => {
    const kafka = new FakeKafka();
    const bus = new KafkaBus(kafka, { logger: quiet, maxRetryDelayMs: 5000 });
    await bus.publish(happyPath('pay-5')[0]!);
    let calls = 0;
    const sub = await bus.subscribe({ group: 'g' }, () => {
      calls += 1;
      throw new Error('always');
    });
    await waitFor(() => calls >= 1);
    const t0 = Date.now();
    await sub.unsubscribe();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(kafka.commits).toEqual([]);
    await bus.close();
  });
});
