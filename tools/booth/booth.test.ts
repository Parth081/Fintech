import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryBus } from '@ct/event-bus';
import { applyEvent, isControlEvent, makeControlEvent, newId, type BusEvent, type PaymentState, type RecordingMeta } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { brokerHttpSource, buildMeta, closingEvents, parseRecordArgs, recordRun, type LogSource } from './record';
import {
  listRecordings,
  makeTransformer,
  newestRecording,
  parseReplayArgs,
  parseRecording,
  playbackOffsets,
  plainIdsOf,
  recordingPath,
  metaPath,
  startReplayPublisher,
} from './replay';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ct-booth-test-'));
  dirs.push(d);
  return d;
};

/** A happy-path payment starting at `startMs` (1 s between stages), with an XML message carrying ids and times. */
function payment(startMs: number, paymentId = newId()): BusEvent[] {
  let prev: string | null = null;
  const out: BusEvent[] = [];
  const add = (type: Parameters<typeof makeEvent>[0], payload: unknown, producer: string, i: number) => {
    const e = makeEvent(type, paymentId, payload as never, { occurredAt: iso(startMs + i * 1000), causationId: prev, producer: producer as never }) as BusEvent;
    prev = e.eventId;
    out.push(e);
  };
  add('payment.initiated', sampleInitiatedPayload(), 'payment-api', 0);
  add('payment.screened', { result: 'clear', listVersion: 'v1' }, 'screening', 1);
  add('payment.scored', { fraudScore: 0.1, amlAlerts: [], decision: 'approve' }, 'risk', 2);
  add(
    'payment.quoted',
    {
      quoteId: newId(), rate: '83.1', spreadBps: 10, rateTimestamp: iso(startMs + 3000), expiresAt: iso(startMs + 33_000),
      sourceAmount: { amountMinor: 100, currency: 'USD' }, targetAmount: { amountMinor: 8310, currency: 'INR' },
    },
    'fx',
    3,
  );
  add('payment.routed', { providerId: 'orion', rail: 'r', estimatedFee: { amountMinor: 1, currency: 'USD' }, alternatives: [] }, 'routing', 4);
  add(
    'payment.sent',
    { providerId: 'orion', messageType: 'pacs.008', messageId: newId(), message: `<Document><EndToEndId>${paymentId}</EndToEndId><CreDtTm>${iso(startMs + 5000)}</CreDtTm></Document>` },
    'settlement',
    5,
  );
  add('payment.settled', { providerId: 'orion', settlementRef: 's', statusMessage: 'pacs.002', valueDate: '2026-10-21' }, 'settlement', 6);
  add(
    'ledger.posted',
    {
      journalId: newId(),
      entries: [
        { account: 'a', direction: 'debit', amount: { amountMinor: 100, currency: 'USD' } },
        { account: 'b', direction: 'credit', amount: { amountMinor: 100, currency: 'USD' } },
      ],
    },
    'ledger',
    7,
  );
  add('payment.reconciled', { statementRef: 'st', matched: true }, 'reconciliation', 8);
  return out;
}

let ctlSeq = 0;
const ctl = (type: Parameters<typeof makeControlEvent>[0], payload: unknown, atMs: number): BusEvent =>
  makeControlEvent(type, payload as never, { eventId: newId() + String(ctlSeq++).slice(0, 0), occurredAt: iso(atMs), producer: 'orchestrator' }) as BusEvent;

/** Outage scenario fixture: scenario start, outage start, payments across, outage end, scenario end. */
function outageFixture(): BusEvent[] {
  const runId = newId();
  const events = [
    ctl('control.scenario.started', { runId, scenarioId: 'provider-outage', title: 'Provider outage', seed: 's' }, T0),
    ...payment(T0 + 500),
    ctl('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'drill', runId }, T0 + 4000),
    ...payment(T0 + 4500),
    ctl('control.provider_outage.ended', { providerId: 'orion', runId }, T0 + 20_000),
    ctl('control.scenario.ended', { runId, scenarioId: 'provider-outage', outcome: 'completed' }, T0 + 21_000),
  ];
  return events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

function writeRecording(dataDir: string, name: string, events: BusEvent[], recordedAt = '2026-10-20T11:00:00.000Z'): RecordingMeta {
  const meta = buildMeta(name, events, 'provider-outage', recordedAt);
  mkdirSync(join(dataDir, 'recordings'), { recursive: true });
  writeFileSync(recordingPath(dataDir, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(metaPath(dataDir, name), JSON.stringify(meta));
  return meta;
}

/** Virtual time: sleep advances the clock. */
function virtualClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      t += Math.max(0, ms);
      await Promise.resolve();
    },
    set: (v: number) => (t = v),
  };
}

describe('listing', () => {
  it('lists valid recordings newest first and ignores damaged ones', () => {
    const dir = tmp();
    writeRecording(dir, 'old', outageFixture(), '2026-10-01T00:00:00.000Z');
    writeRecording(dir, 'new', outageFixture(), '2026-10-02T00:00:00.000Z');
    writeFileSync(join(dir, 'recordings', 'broken.meta.json'), '{nope');
    writeFileSync(join(dir, 'recordings', 'nojsonl.meta.json'), JSON.stringify({ ...buildMeta('nojsonl', outageFixture(), null, 'x'), recordedAt: '2026-10-03T00:00:00.000Z' }));
    expect(listRecordings(dir).map((m) => m.name)).toEqual(['new', 'old']);
    expect(newestRecording(dir)?.name).toBe('new');
    expect(newestRecording(tmp())).toBeUndefined();
    expect(listRecordings(join(dir, 'missing'))).toEqual([]);
  });

  it('rejects names that could escape the directory', () => {
    expect(() => recordingPath('d', '../x')).toThrow();
    expect(() => recordingPath('d', 'a/b')).toThrow();
    expect(() => recordingPath('d', '')).toThrow();
    expect(recordingPath('d', 'run-1.v2')).toMatch(/run-1\.v2\.jsonl$/);
  });
});

describe('transform (time shift + re-keying)', () => {
  const events = outageFixture();
  const make = (loopStarts: number[], speed = 1, salt = 's') =>
    makeTransformer({ firstMs: Date.parse(events[0]!.occurredAt), speed, salt, plainIds: plainIdsOf(events), loopStartMs: (l) => loopStarts[l]! });

  it('shifts occurredAt and embedded timestamps so the first event is at loop start; dates stay', () => {
    const t = make([5_000_000]);
    const first = t.apply(events[0]!, 0);
    expect(Date.parse(first.occurredAt)).toBe(5_000_000);
    const quoted = events.find((e) => e.type === 'payment.quoted')!;
    const q = t.apply(quoted, 0) as typeof quoted & { payload: { rateTimestamp: string; expiresAt: string } };
    const delta = 5_000_000 - T0;
    expect(Date.parse(q.occurredAt)).toBe(Date.parse(quoted.occurredAt) + delta);
    expect(Date.parse(q.payload.rateTimestamp)).toBe(Date.parse(quoted.occurredAt) + delta);
    expect(Date.parse(q.payload.expiresAt)).toBe(Date.parse(quoted.occurredAt) + 30_000 + delta);
    const settled = events.find((e) => e.type === 'payment.settled')!;
    expect((t.apply(settled, 0) as typeof settled & { payload: { valueDate: string } }).payload.valueDate).toBe('2026-10-21');
    const sent = events.find((e) => e.type === 'payment.sent')!;
    const xml = (t.apply(sent, 0) as typeof sent & { payload: { message: string } }).payload.message;
    expect(xml).toContain(new Date(Date.parse(sent.occurredAt) + delta).toISOString());
    expect(xml).not.toContain(sent.paymentId);
    expect(xml).toContain(t.apply(sent, 0).paymentId); // XML id re-keyed together with the paymentId
  });

  it('applies the speed factor to the timeline', () => {
    const t = make([0], 2);
    const last = events[events.length - 1]!;
    expect(Date.parse(t.apply(last, 0).occurredAt)).toBe((Date.parse(last.occurredAt) - T0) / 2);
  });

  it('re-keys ids consistently per loop and never reuses an id across loops or salts', () => {
    const t = make([1_000, 2_000]);
    const seen = new Set<string>();
    const ids = (loop: number) => events.map((e) => t.apply(e, loop));
    const l0 = ids(0);
    const l1 = ids(1);
    for (const e of [...l0, ...l1]) {
      expect(seen.has(e.eventId)).toBe(false);
      seen.add(e.eventId);
    }
    // payment ids differ between loops but are the same for all events of one payment inside a loop
    expect(new Set(l0.map((e) => e.paymentId)).size).toBe(new Set(events.map((e) => e.paymentId)).size);
    expect(l0.filter((e) => !isControlEvent(e)).every((e) => !events.some((o) => o.paymentId === e.paymentId))).toBe(true);
    expect(l0.map((e) => e.paymentId).filter((id) => id !== '__control__').some((id) => l1.some((e) => e.paymentId === id))).toBe(false);
    // causation / correlation stay consistent
    const byId = new Map(l0.map((e) => [e.eventId, e]));
    for (const e of l0) {
      if (isControlEvent(e)) continue;
      expect(e.correlationId).toBe(e.paymentId);
      if (e.causationId) expect(byId.get(e.causationId)?.paymentId).toBe(e.paymentId);
    }
    // deterministic for the same salt and loop; different for another salt
    expect(make([1_000, 2_000]).apply(events[1]!, 0).eventId).toBe(l0[1]!.eventId);
    expect(make([1_000], 1, 'other').apply(events[1]!, 0).eventId).not.toBe(l0[1]!.eventId);
    // scenario run ids are re-keyed too (a new run per loop)
    const run0 = (l0[0] as { payload: { runId: string } }).payload.runId;
    const run1 = (l1[0] as { payload: { runId: string } }).payload.runId;
    expect(run0).not.toBe(run1);
    expect(l0.find((e) => e.type === 'control.scenario.ended') && (l0.find((e) => e.type === 'control.scenario.ended') as { payload: { runId: string } }).payload.runId).toBe(run0);
  });

  it('re-keys non-UUID fixture ids with a suffix, without touching longer ids that contain them', () => {
    const e1 = makeEvent('payment.initiated', 'p-1', sampleInitiatedPayload(), { eventId: 'e-1', occurredAt: iso(T0) }) as BusEvent;
    const e2 = makeEvent('payment.screened', 'p-1', { result: 'clear', listVersion: 'v' }, { eventId: 'e-2', causationId: 'e-1', occurredAt: iso(T0 + 1000) }) as BusEvent;
    const e3 = makeEvent('payment.initiated', 'p-10', sampleInitiatedPayload(), { eventId: 'e-3', occurredAt: iso(T0 + 2000) }) as BusEvent;
    const all = [e1, e2, e3];
    const t = makeTransformer({ firstMs: T0, speed: 1, salt: 'z', plainIds: plainIdsOf(all), loopStartMs: () => T0 });
    const [a, b, c] = all.map((e) => t.apply(e, 3));
    expect(a!.paymentId).toBe('p-1~z3');
    expect((b as { causationId: string | null }).causationId).toBe('e-1~z3');
    expect(c!.paymentId).toBe('p-10~z3');
  });

  it('playback offsets are non-decreasing even if occurredAt goes backwards', () => {
    const e = [events[0]!, { ...events[1]!, occurredAt: iso(T0 + 5000) }, { ...events[2]!, occurredAt: iso(T0 + 3000) }];
    expect(playbackOffsets(e, 1)).toEqual([0, 5000, 5000]);
    expect(playbackOffsets(e, 5)).toEqual([0, 1000, 1000]);
  });
});

describe('startReplayPublisher', () => {
  it('publishes in order with the original relative timing (virtual clock) and ends', async () => {
    const dir = tmp();
    writeRecording(dir, 'r', outageFixture());
    const events = outageFixture();
    const clock = virtualClock(7_000_000);
    const bus = new InMemoryBus();
    const published: { at: number; id: string }[] = [];
    const orig = bus.publish.bind(bus);
    bus.publish = async (e) => {
      published.push({ at: clock.now(), id: e.eventId });
      return orig(e);
    };
    const h = await startReplayPublisher({ bus, file: recordingPath(dir, 'r'), now: clock.now, sleep: clock.sleep, salt: 'a' });
    await h.done;
    expect(published).toHaveLength(events.length);
    const rel = published.map((p) => p.at - 7_000_000);
    expect(rel).toEqual(events.map((e) => Date.parse(e.occurredAt) - T0));
    // the first event's occurredAt is "now" at playback start, every event's occurredAt equals its publish time
    const log = bus.events;
    expect(Date.parse(log[0]!.occurredAt)).toBe(7_000_000);
    log.forEach((e, i) => expect(Date.parse(e.occurredAt)).toBe(published[i]!.at));
    // payment events keep their order per payment
    const types = log.filter((e) => !isControlEvent(e)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(['payment.initiated', 'payment.screened', 'payment.scored']);
  });

  it('speed 2 plays in half the time and stamps matching times', async () => {
    const dir = tmp();
    writeRecording(dir, 'r', outageFixture());
    const events = outageFixture();
    const clock = virtualClock(0);
    const bus = new InMemoryBus();
    const h = await startReplayPublisher({ bus, file: recordingPath(dir, 'r'), now: clock.now, sleep: clock.sleep, speed: 2 });
    await h.done;
    const span = Date.parse(events[events.length - 1]!.occurredAt) - T0;
    expect(clock.now()).toBe(span / 2);
    expect(Date.parse(bus.events[bus.events.length - 1]!.occurredAt)).toBe(span / 2);
  });

  it('loops: new unique ids each iteration, payments counted once per loop, gap between loops, clean control state', async () => {
    const dir = tmp();
    writeRecording(dir, 'r', outageFixture());
    const events = outageFixture();
    const clock = virtualClock(100_000);
    const bus = new InMemoryBus();
    const loops: number[] = [];
    const h = await startReplayPublisher({
      bus,
      file: recordingPath(dir, 'r'),
      loop: true,
      gapMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      salt: 's',
      onLoop: (n) => {
        loops.push(n);
        if (n === 2) void h.stop();
      },
    });
    await h.done;
    expect(loops).toEqual([0, 1, 2]);
    // loop 2 was stopped before its first event
    expect(bus.events.length).toBe(events.length * 2);
    const ids = bus.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const second = bus.events.slice(events.length);
    const length = Date.parse(events[events.length - 1]!.occurredAt) - T0;
    expect(Date.parse(second[0]!.occurredAt)).toBe(100_000 + length + 3000);
    // fold payments: each loop's payments are separate, complete and reconciled
    const states = new Map<string, PaymentState>();
    for (const e of bus.events) {
      if (isControlEvent(e)) continue;
      states.set(e.paymentId, applyEvent(states.get(e.paymentId), e));
    }
    expect(states.size).toBe(4);
    expect([...states.values()].every((s) => s.status === 'reconciled')).toBe(true);
  });

  it('is idempotent when the same loop is published twice (bus eventId dedupe) and fresh salt avoids that', async () => {
    const dir = tmp();
    writeRecording(dir, 'r', outageFixture());
    const events = outageFixture();
    const bus = new InMemoryBus();
    for (const salt of ['same', 'same']) {
      const c = virtualClock(5);
      await (await startReplayPublisher({ bus, file: recordingPath(dir, 'r'), now: c.now, sleep: c.sleep, salt })).done;
    }
    expect(bus.events.length).toBe(events.length);
    const c = virtualClock(5);
    await (await startReplayPublisher({ bus, file: recordingPath(dir, 'r'), now: c.now, sleep: c.sleep, salt: 'other' })).done;
    expect(bus.events.length).toBe(events.length * 2);
  });

  it('retries a failed publish without duplicating or skipping events', async () => {
    const dir = tmp();
    writeRecording(dir, 'r', outageFixture());
    const events = outageFixture();
    const clock = virtualClock();
    const bus = new InMemoryBus();
    const orig = bus.publish.bind(bus);
    let calls = 0;
    bus.publish = async (e) => {
      calls += 1;
      if (calls === 3 || calls === 4) throw new Error('broker down');
      return orig(e);
    };
    await (await startReplayPublisher({ bus, file: recordingPath(dir, 'r'), now: clock.now, sleep: clock.sleep })).done;
    expect(bus.events.length).toBe(events.length);
    expect(bus.events.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it('stop() ends a looping run promptly (real timers)', async () => {
    const dir = tmp();
    writeRecording(dir, 'r', outageFixture());
    const bus = new InMemoryBus();
    const h = await startReplayPublisher({ bus, file: recordingPath(dir, 'r'), loop: true });
    await new Promise((r) => setTimeout(r, 30));
    const t = Date.now();
    await h.stop();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(bus.events.length).toBeGreaterThan(0);
    expect(bus.events.length).toBeLessThan(5);
  });

  it('rejects empty files and bad speed', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'recordings'), { recursive: true });
    writeFileSync(recordingPath(dir, 'empty'), '\n');
    await expect(startReplayPublisher({ bus: new InMemoryBus(), file: recordingPath(dir, 'empty') })).rejects.toThrow(/no events/);
    writeRecording(dir, 'r', outageFixture());
    await expect(startReplayPublisher({ bus: new InMemoryBus(), file: recordingPath(dir, 'r'), speed: 0 })).rejects.toThrow(/speed/);
  });

  it('parseRecording skips garbage lines', () => {
    const e = outageFixture()[0]!;
    const r = parseRecording(`${JSON.stringify(e)}\nnot json\n{"a":1}\n\n`);
    expect(r.events).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });
});

// ---- recorder ------------------------------------------------------------------------------------

/** A log that grows by `timeline` entries as virtual time passes. */
function growingSource(clock: ReturnType<typeof virtualClock>, startAt: number, timeline: { atMs: number; event: BusEvent }[]): LogSource & { all: BusEvent[] } {
  const all: BusEvent[] = [];
  const visible = () => {
    const t = clock.now() - startAt;
    // `before` events (atMs < 0) are already there at start
    return timeline.filter((x) => x.atMs <= t);
  };
  const sync = () => {
    const v = visible().map((x) => x.event);
    while (all.length < v.length) all.push(v[all.length]!);
  };
  return {
    all,
    async head() {
      sync();
      return all.length;
    },
    async read(from, limit) {
      sync();
      return all.slice(from, from + limit).map((event, i) => ({ offset: from + i, event }));
    },
  };
}

describe('recordRun', () => {
  const T = 50_000_000;

  function scenarioTimeline(): { atMs: number; event: BusEvent }[] {
    const early = payment(T - 20_000); // in flight / before the window: must not be recorded
    const runId = newId();
    const inWindow = payment(T + 1000);
    const late = payment(T + 9000); // initiated in the window, finishes after it
    const after = payment(T + 12_000); // initiated after the window: excluded
    const items = [
      ...early.map((e) => ({ atMs: -1, event: e })),
      { atMs: 100, event: ctl('control.scenario.started', { runId, scenarioId: 'provider-outage', title: 'Provider outage', seed: 's' }, T + 100) },
      ...inWindow.map((e) => ({ atMs: Date.parse(e.occurredAt) - T, event: e })),
      { atMs: 4000, event: ctl('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'x', runId }, T + 4000) },
      ...late.map((e) => ({ atMs: Date.parse(e.occurredAt) - T, event: e })),
      ...after.map((e) => ({ atMs: Date.parse(e.occurredAt) - T, event: e })),
      { atMs: 14_000, event: ctl('control.provider_outage.ended', { providerId: 'orion', runId }, T + 14_000) },
      { atMs: 15_000, event: ctl('control.scenario.ended', { runId, scenarioId: 'provider-outage', outcome: 'completed' }, T + 15_000) },
    ];
    return items.sort((a, b) => a.atMs - b.atMs);
  }

  it('records only the window, follows started payments past it, writes jsonl + meta, refuses to overwrite', async () => {
    const dir = tmp();
    const clock = virtualClock(T);
    const timeline = scenarioTimeline();
    const source = growingSource(clock, T, timeline);
    const posts: string[] = [];
    const fakeFetch = (async (url: string) => {
      posts.push(String(url));
      return new Response('{"runId":"x"}', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await recordRun({
      name: 'rec1', scenario: 'provider-outage', durationMs: 10_000, graceMs: 30_000, pollMs: 500, dataDir: dir,
      broker: source, gatewayUrl: 'http://gw.test', now: clock.now, sleep: (ms) => clock.sleep(ms), fetch: fakeFetch,
    });
    expect(posts).toEqual(['http://gw.test/api/control/orchestrator/scenarios/provider-outage/start']);
    expect(res.payments).toBe(2);
    const text = readFileSync(res.file, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as BusEvent);
    expect(lines).toHaveLength(res.meta.eventCount);
    const ids = new Set(lines.map((e) => e.paymentId));
    expect(ids.size).toBe(3); // two payments + __control__
    expect(lines.filter((e) => e.type === 'payment.reconciled')).toHaveLength(2);
    expect(res.closers).toBe(0); // the scenario ended inside the grace period
    expect(res.unfinishedPayments).toBe(0);
    // log order is preserved
    const order = lines.map((e) => Date.parse(e.occurredAt));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const meta = JSON.parse(readFileSync(res.metaFile, 'utf8')) as RecordingMeta;
    expect(meta).toMatchObject({ name: 'rec1', scenarioId: 'provider-outage', format: 1, eventCount: lines.length });
    expect(meta.durationMs).toBe(Date.parse(meta.lastOccurredAt) - Date.parse(meta.firstOccurredAt));
    expect(listRecordings(dir).map((m) => m.name)).toEqual(['rec1']);
    expect(existsSync(`${res.file}.tmp`)).toBe(false);

    await expect(
      recordRun({ name: 'rec1', durationMs: 1000, dataDir: dir, broker: source, now: clock.now, sleep: (ms) => clock.sleep(ms) }),
    ).rejects.toThrow(/already exists/);
    clock.set(T);
    const source2 = growingSource(clock, T, timeline);
    const forced = await recordRun({ name: 'rec1', force: true, durationMs: 5000, graceMs: 100, dataDir: dir, broker: source2, now: clock.now, sleep: (ms) => clock.sleep(ms) });
    expect(forced.meta.eventCount).toBeGreaterThan(0);
  });

  it('closes scenarios and outages still open when recording ends, and replays clean', async () => {
    const dir = tmp();
    const clock = virtualClock(T);
    const runId = newId();
    const pay = payment(T + 500);
    const timeline = [
      { atMs: 10, event: ctl('control.scenario.started', { runId, scenarioId: 'provider-outage', title: 'P', seed: 's' }, T + 10) },
      ...pay.map((e) => ({ atMs: Date.parse(e.occurredAt) - T, event: e })),
      { atMs: 3000, event: ctl('control.provider_outage.started', { providerId: 'lyra', mode: 'degraded', failureRate: 0.5, reason: 'x', runId }, T + 3000) },
    ];
    const res = await recordRun({ name: 'open', durationMs: 5000, graceMs: 2000, pollMs: 250, dataDir: dir, broker: growingSource(clock, T, timeline), now: clock.now, sleep: (ms) => clock.sleep(ms) });
    expect(res.closers).toBe(2);
    const lines = readFileSync(res.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as BusEvent);
    const tail = lines.slice(-2).map((e) => e.type).sort();
    expect(tail).toEqual(['control.provider_outage.ended', 'control.scenario.ended']);
    const closer = lines.find((e) => e.type === 'control.scenario.ended') as { payload: { runId: string; outcome: string } };
    expect(closer.payload).toMatchObject({ runId, outcome: 'stopped' });
    // deterministic closer ids
    expect(closingEvents(lines.slice(0, -2)).map((e) => e.eventId).sort()).toEqual(lines.slice(-2).map((e) => e.eventId).sort());
  });

  it('works against the in-memory bus as the log source', async () => {
    const dir = tmp();
    const bus = new InMemoryBus();
    for (const e of payment(T - 5000)) await bus.publish(e); // before recording
    const clock = virtualClock(T);
    const source: LogSource = {
      head: async () => bus.events.length,
      read: async (from, limit) => bus.events.slice(from, from + limit).map((event, i) => ({ offset: from + i, event })),
    };
    let published = false;
    const res = await recordRun({
      name: 'mem', durationMs: 3000, graceMs: 1000, pollMs: 500, dataDir: dir, broker: source, now: clock.now,
      sleep: async (ms) => {
        if (!published) {
          published = true;
          for (const e of payment(T + 100)) await bus.publish(e);
        }
        await clock.sleep(ms);
      },
    });
    expect(res.payments).toBe(1);
    expect(res.meta.eventCount).toBe(9);
  });

  it('errors clearly when nothing happened and when the scenario cannot start', async () => {
    const dir = tmp();
    const clock = virtualClock(T);
    const empty: LogSource = { head: async () => 0, read: async () => [] };
    await expect(recordRun({ name: 'none', durationMs: 1000, graceMs: 100, dataDir: dir, broker: empty, now: clock.now, sleep: (ms) => clock.sleep(ms) })).rejects.toThrow(/nothing was recorded/);
    expect(listRecordings(dir)).toEqual([]);
    const busy = (async () => new Response('{"error":"busy"}', { status: 409 })) as unknown as typeof fetch;
    await expect(recordRun({ name: 'busy', scenario: 'fx-spike', durationMs: 1000, dataDir: dir, broker: empty, fetch: busy, now: clock.now, sleep: (ms) => clock.sleep(ms) })).rejects.toThrow(/already running/);
    await expect(recordRun({ name: '../bad', durationMs: 1000, dataDir: dir, broker: empty })).rejects.toThrow(/invalid recording name/);
  });

  it('brokerHttpSource reads /health and /events pages from a (fake) broker over HTTP', async () => {
    const log = payment(T);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname === '/health') return void res.end(JSON.stringify({ ok: true, events: log.length }));
      const from = Number(url.searchParams.get('from'));
      const limit = Number(url.searchParams.get('limit'));
      res.end(JSON.stringify(log.slice(from, from + limit).map((event, i) => ({ offset: from + i, event }))));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const src = brokerHttpSource(url);
    expect(await src.head()).toBe(9);
    const page = await src.read(2, 3);
    expect(page.map((p) => p.offset)).toEqual([2, 3, 4]);
    expect(page[0]!.event.type).toBe('payment.scored');
    expect(await src.read(9, 10)).toEqual([]);
  });
});

describe('CLI parsing', () => {
  it('parses record args', () => {
    const { options } = parseRecordArgs(['--name', 'demo', '--scenario', 'provider-outage', '--duration=45', '--broker', 'http://127.0.0.1:38200', '--force', '--out-dir', 'x']);
    expect(options).toMatchObject({ name: 'demo', scenario: 'provider-outage', durationMs: 45_000, broker: 'http://127.0.0.1:38200', force: true, dataDir: 'x' });
    expect(() => parseRecordArgs([])).toThrow(/--name is required/);
    expect(() => parseRecordArgs(['--name', 'a b'])).toThrow(/invalid recording name/);
    expect(() => parseRecordArgs(['--name', 'a', '--duration', '0'])).toThrow(/positive/);
    expect(() => parseRecordArgs(['--name', 'a', '--bogus'])).toThrow(/Unknown option/);
    expect(parseRecordArgs(['--help']).help).toBe(true);
  });

  it('parses replay args', () => {
    expect(parseReplayArgs(['--name', 'demo', '--speed', '4', '--no-loop', '--gateway-port', '38202'])).toMatchObject({ name: 'demo', speed: 4, loop: false, gatewayPort: 38202 });
    expect(parseReplayArgs([])).toMatchObject({ speed: 1, loop: true });
    expect(() => parseReplayArgs(['--speed', '0'])).toThrow();
    expect(() => parseReplayArgs(['--gateway-port', '99999'])).toThrow();
  });
});
