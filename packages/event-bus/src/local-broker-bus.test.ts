import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEvent } from '@ct/contracts';
import { happyPath } from '@ct/contracts/testing';
import { startBroker, type BrokerHandle } from '../../../services/broker/src/broker';
import { LocalBrokerBus, type LocalBrokerBusOptions } from './local-broker-bus';
import type { EventBus } from './types';

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function events(n: number, paymentId = 'p'): AnyEvent[] {
  const out: AnyEvent[] = [];
  while (out.length < n) out.push(...happyPath(`${paymentId}-${out.length}`));
  return out.slice(0, n);
}

describe('LocalBrokerBus + broker', () => {
  let dataDir: string;
  let broker: BrokerHandle | null;
  const buses: EventBus[] = [];

  const start = async (port = 0) => {
    broker = await startBroker({ host: '127.0.0.1', port, dataDir, logger: quiet });
    return broker;
  };
  const connect = async (id: string, opts: LocalBrokerBusOptions = {}) => {
    const bus = await LocalBrokerBus.connect(broker!.url, id, { logger: quiet, ...opts });
    buses.push(bus);
    return bus;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-bus-'));
    broker = null;
  });
  afterEach(async () => {
    await Promise.all(buses.splice(0).map((b) => b.close()));
    await broker?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('publish returns increasing offsets and the log persists across a broker restart', async () => {
    await start();
    const bus = await connect('pub');
    const evs = events(5);
    const offsets = await Promise.all(evs.map((e) => bus.publish(e)));
    expect(offsets.map((o) => o.offset)).toEqual([0, 1, 2, 3, 4]);
    await bus.close();
    await broker!.close();

    await start();
    const health = (await (await fetch(`http://127.0.0.1:${broker!.port}/health`)).json()) as { ok: boolean; events: number };
    expect(health).toEqual({ ok: true, events: 5 });
    const bus2 = await connect('reader');
    const seen: string[] = [];
    await bus2.subscribe({ group: 'r', ephemeral: true }, (e) => { seen.push(e.eventId); });
    await waitFor(() => seen.length === 5);
    expect(seen).toEqual(evs.map((e) => e.eventId));
    expect((await bus2.publish(events(1, 'q')[0]!)).offset).toBe(5);
  });

  it('two clients see the same ordered log', async () => {
    await start();
    const a = await connect('a');
    const b = await connect('b');
    const seenA: [number, string][] = [];
    const seenB: [number, string][] = [];
    await a.subscribe({ group: 'view-a', ephemeral: true }, (e, m) => { seenA.push([m.offset, e.eventId]); });
    await b.subscribe({ group: 'view-b', ephemeral: true }, (e, m) => { seenB.push([m.offset, e.eventId]); });
    const evs = events(40);
    await Promise.all(evs.map((e, i) => (i % 2 ? a : b).publish(e)));
    await waitFor(() => seenA.length === 40 && seenB.length === 40);
    expect(seenA).toEqual(seenB);
    expect(seenA.map(([o]) => o)).toEqual([...Array(40).keys()]);
  });

  it('a group resumes from its committed offset after reconnect and broker restart', async () => {
    const port = (await start()).port;
    const pub = await connect('pub');
    for (const e of events(3)) await pub.publish(e);

    const c1 = await connect('c1');
    const seen: number[] = [];
    await c1.subscribe({ group: 'g' }, (_e, m) => { seen.push(m.offset); });
    await waitFor(() => seen.length === 3);
    await c1.close();
    for (const e of events(2, 'later')) await pub.publish(e);
    await pub.close();
    await broker!.close();

    await start(port);
    const c2 = await connect('c2');
    await c2.subscribe({ group: 'g' }, (_e, m) => { seen.push(m.offset); });
    await waitFor(() => seen.length >= 5);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('ephemeral and latest subscriptions', async () => {
    await start();
    const bus = await connect('x');
    for (const e of events(2)) await bus.publish(e);

    const latest: number[] = [];
    const eph1: number[] = [];
    const eph2: number[] = [];
    const newGroupLatest: number[] = [];
    await bus.subscribe({ group: 'l', from: 'latest', ephemeral: true }, (_e, m) => { latest.push(m.offset); });
    await bus.subscribe({ group: 'nl', from: 'latest' }, (_e, m) => { newGroupLatest.push(m.offset); });
    const s1 = await bus.subscribe({ group: 'e', ephemeral: true }, (_e, m) => { eph1.push(m.offset); });
    await bus.publish(events(1, 'new')[0]!);
    await waitFor(() => latest.length === 1 && eph1.length === 3 && newGroupLatest.length === 1);
    await s1.unsubscribe();
    // Ephemeral never commits: the same group name starts again from earliest.
    await bus.subscribe({ group: 'e', ephemeral: true }, (_e, m) => { eph2.push(m.offset); });
    await waitFor(() => eph2.length === 3);
    expect(latest).toEqual([2]);
    expect(newGroupLatest).toEqual([2]);
    expect(eph1).toEqual([0, 1, 2]);
    expect(eph2).toEqual([0, 1, 2]);
  });

  it('retries a throwing handler on the same event (at-least-once), in order', async () => {
    await start();
    const bus = await connect('r');
    for (const e of events(3)) await bus.publish(e);
    const calls: number[] = [];
    let failures = 0;
    await bus.subscribe({ group: 'g' }, (_e, m) => {
      calls.push(m.offset);
      if (m.offset === 1 && failures < 3) {
        failures += 1;
        throw new Error('boom');
      }
    });
    await waitFor(() => calls.length === 6);
    expect(calls).toEqual([0, 1, 1, 1, 1, 2]);
  });

  it('handler calls are strictly sequential and flow control keeps delivering with a tiny window', async () => {
    await start();
    const bus = await connect('fc', { window: 4 });
    const evs = events(60);
    await Promise.all(evs.map((e) => bus.publish(e)));
    let active = 0;
    let maxActive = 0;
    const seen: number[] = [];
    await bus.subscribe({ group: 'slow' }, async (_e, m) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, m.offset % 5 === 0 ? 2 : 0));
      seen.push(m.offset);
      active -= 1;
    });
    await waitFor(() => seen.length === 60);
    expect(seen).toEqual([...Array(60).keys()]);
    expect(maxActive).toBe(1);
  });

  it('reconnects after a broker restart and keeps consuming; publishes made while down are delivered', async () => {
    const port = (await start()).port;
    const bus = await connect('svc', { publishTimeoutMs: 10_000 });
    const seen: number[] = [];
    await bus.subscribe({ group: 'stage' }, (_e, m) => { seen.push(m.offset); });
    for (const e of events(2)) await bus.publish(e);
    await waitFor(() => seen.length === 2);

    await broker!.close();
    const pending = bus.publish(events(1, 'while-down')[0]!);
    await new Promise((r) => setTimeout(r, 100));
    await start(port);
    expect((await pending).offset).toBe(2);
    expect((await bus.publish(events(1, 'after')[0]!)).offset).toBe(3);
    await waitFor(() => seen.length >= 4);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('rejects a pending publish clearly when the broker stays down', async () => {
    await start();
    const bus = await connect('to', { publishTimeoutMs: 200 });
    await broker!.close();
    broker = null;
    await expect(bus.publish(events(1)[0]!)).rejects.toThrow(/timed out/);
  });

  it('connect fails clearly when no broker is reachable', async () => {
    await expect(LocalBrokerBus.connect('ws://127.0.0.1:1', 'nobody', { connectTimeoutMs: 200, logger: quiet })).rejects.toThrow(
      /cannot reach broker/,
    );
  });

  // ---- M2: head() and idempotent append
  it('head() reports the number of durable events and covers everything acked before it', async () => {
    await start();
    const bus = await connect('head');
    expect(await bus.head()).toBe(0);
    const evs = events(7);
    await Promise.all(evs.map((e) => bus.publish(e)));
    expect(await bus.head()).toBe(7);
    // A second client sees the same head.
    expect(await (await connect('head-2')).head()).toBe(7);
  });

  it('head() waits for a reconnect when the broker is briefly down', async () => {
    const b = await start();
    const port = b.port;
    const bus = await connect('head-reconnect', { maxReconnectDelayMs: 50 });
    await bus.publish(events(1)[0]!);
    await broker!.close();
    const pending = bus.head();
    await new Promise((r) => setTimeout(r, 100));
    await start(port);
    expect(await pending).toBe(1);
  });

  it('publishing the same eventId again (sequentially or concurrently, from any client) appends once', async () => {
    await start();
    const a = await connect('dup-a');
    const b = await connect('dup-b');
    const [e1, e2] = events(2);
    const first = await a.publish(e1!);
    expect((await b.publish(e1!)).offset).toBe(first.offset);
    // Concurrent duplicates while the first append is still in flight.
    const results = await Promise.all([a.publish(e2!), b.publish(e2!), a.publish(e2!), b.publish(e2!)]);
    expect(new Set(results.map((r) => r.offset)).size).toBe(1);
    expect(await a.head()).toBe(2);
    const health = (await (await fetch(`http://127.0.0.1:${broker!.port}/health`)).json()) as { events: number };
    expect(health.events).toBe(2);
  });

  it('catches up a large log in batches, in order, with no gaps', async () => {
    await start();
    const pub = await connect('bulk-pub');
    const evs = events(3000, 'bulk');
    await Promise.all(evs.map((e) => pub.publish(e)));
    const sub = await connect('bulk-sub', { window: 64 });
    const seen: number[] = [];
    await sub.subscribe({ group: 'bulk', from: 'earliest', ephemeral: true }, (_e, m) => {
      seen.push(m.offset);
    });
    await waitFor(() => seen.length === evs.length, 10_000);
    expect(seen).toEqual(evs.map((_, i) => i));
  });
});
