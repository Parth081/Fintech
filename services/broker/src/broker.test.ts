import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { happyPath } from '@ct/contracts/testing';
import { startBroker, type BrokerHandle } from './broker';

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** Minimal raw-protocol client. */
async function rawClient(url: string) {
  const ws = new WebSocket(url);
  const inbox: Record<string, unknown>[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as Record<string, unknown>));
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  const next = async (pred: (m: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error('no matching message');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ws, inbox, send: (m: object) => ws.send(JSON.stringify(m)), next, close: () => ws.close() };
}

describe('local broker', () => {
  let dataDir: string;
  let broker: BrokerHandle | null = null;
  const warnings: string[] = [];
  const logger = { ...quiet, warn: (m: string) => { warnings.push(m); } };

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-broker-'));
    warnings.length = 0;
  });
  afterEach(async () => {
    await broker?.close();
    broker = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves /health and /events, acks publishes with sequential offsets', async () => {
    broker = await startBroker({ host: '127.0.0.1', port: 0, dataDir, logger });
    expect(broker.port).toBeGreaterThan(0);
    const c = await rawClient(broker.url);
    const evs = happyPath('p-1');
    evs.forEach((event, i) => c.send({ op: 'publish', reqId: i + 1, event }));
    const acks = await Promise.all(evs.map((_, i) => c.next((m) => m.op === 'ack' && m.reqId === i + 1)));
    expect(acks.map((a) => a.offset)).toEqual(evs.map((_, i) => i));

    const health = await (await fetch(`http://127.0.0.1:${broker.port}/health`)).json();
    expect(health).toEqual({ ok: true, events: evs.length });
    const page = (await (await fetch(`http://127.0.0.1:${broker.port}/events?from=2&limit=3`)).json()) as { offset: number; event: { eventId: string } }[];
    expect(page.map((p) => p.offset)).toEqual([2, 3, 4]);
    expect(page[0]!.event.eventId).toBe(evs[2]!.eventId);

    c.send({ op: 'publish', reqId: 99, event: { nope: true } });
    expect((await c.next((m) => m.reqId === 99)).op).toBe('error');

    // Log file is JSONL, one event per line.
    const lines = readFileSync(path.join(dataDir, 'broker', 'payments.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(evs.length);
    c.close();
  });

  it('respects credit (flow control) and persists commits atomically to offsets.json', async () => {
    broker = await startBroker({ host: '127.0.0.1', port: 0, dataDir, logger });
    const c = await rawClient(broker.url);
    const evs = happyPath('p-2');
    evs.forEach((event, i) => c.send({ op: 'publish', reqId: i + 1, event }));
    await c.next((m) => m.op === 'ack' && m.reqId === evs.length);

    c.send({ op: 'subscribe', reqId: 100, subId: 1, group: 'g', from: 'earliest', ephemeral: false, credit: 2 });
    expect((await c.next((m) => m.op === 'subscribed')).start).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.inbox.filter((m) => m.op === 'deliver').map((m) => m.offset)).toEqual([0, 1]);
    c.send({ op: 'credit', subId: 1, n: 3 });
    await c.next((m) => m.op === 'deliver' && m.offset === 4);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.inbox.some((m) => m.op === 'deliver' && m.offset === 5)).toBe(false);

    c.send({ op: 'commit', subId: 1, offset: 5 });
    c.send({ op: 'unsubscribe', reqId: 101, subId: 1 });
    await c.next((m) => m.op === 'unsubscribed');
    c.close();
    await broker.close();
    broker = null;
    const offsets = JSON.parse(readFileSync(path.join(dataDir, 'broker', 'offsets.json'), 'utf8'));
    expect(offsets).toEqual({ groups: { g: 5 } });

    broker = await startBroker({ host: '127.0.0.1', port: 0, dataDir, logger });
    const c2 = await rawClient(broker.url);
    c2.send({ op: 'subscribe', reqId: 1, subId: 7, group: 'g', from: 'earliest', ephemeral: false, credit: 100 });
    expect((await c2.next((m) => m.op === 'subscribed')).start).toBe(5);
    c2.close();
  });

  it('recovers from a truncated final log line', async () => {
    const dir = path.join(dataDir, 'broker');
    mkdirSync(dir, { recursive: true });
    const evs = happyPath('p-3');
    writeFileSync(path.join(dir, 'payments.log'), evs.slice(0, 3).map((e) => JSON.stringify(e) + '\n').join(''));
    appendFileSync(path.join(dir, 'payments.log'), JSON.stringify(evs[3]).slice(0, 40)); // torn write

    broker = await startBroker({ host: '127.0.0.1', port: 0, dataDir, logger });
    expect(warnings.some((w) => /truncated/.test(w))).toBe(true);
    const health = await (await fetch(`http://127.0.0.1:${broker.port}/health`)).json();
    expect(health).toEqual({ ok: true, events: 3 });

    const c = await rawClient(broker.url);
    c.send({ op: 'publish', reqId: 1, event: evs[3] });
    expect((await c.next((m) => m.op === 'ack')).offset).toBe(3);
    c.close();
    await broker.close();
    broker = null;

    // The file is clean again: every line parses.
    const lines = readFileSync(path.join(dir, 'payments.log'), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { eventId: string }).eventId)).toEqual(evs.slice(0, 4).map((e) => e.eventId));
  });

  it('keeps a final line that is complete JSON but lacks its newline', async () => {
    const dir = path.join(dataDir, 'broker');
    mkdirSync(dir, { recursive: true });
    const evs = happyPath('p-4');
    writeFileSync(path.join(dir, 'payments.log'), JSON.stringify(evs[0]) + '\n' + JSON.stringify(evs[1]));
    broker = await startBroker({ host: '127.0.0.1', port: 0, dataDir, logger });
    const c = await rawClient(broker.url);
    c.send({ op: 'publish', reqId: 1, event: evs[2] });
    expect((await c.next((m) => m.op === 'ack')).offset).toBe(2);
    c.close();
    await broker.close();
    broker = null;
    expect(readFileSync(path.join(dir, 'payments.log'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('deduplicates a retried publish by eventId', async () => {
    broker = await startBroker({ host: '127.0.0.1', port: 0, dataDir, logger });
    const c = await rawClient(broker.url);
    const [e] = happyPath('p-5');
    c.send({ op: 'publish', reqId: 1, event: e });
    expect((await c.next((m) => m.reqId === 1)).offset).toBe(0);
    c.send({ op: 'publish', reqId: 2, event: e, retry: true });
    const ack = await c.next((m) => m.reqId === 2);
    expect(ack).toMatchObject({ op: 'ack', offset: 0, duplicate: true });
    c.close();
  });
});
