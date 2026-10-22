// Local broker benchmark: publish throughput, catch-up delivery throughput (ephemeral subscribers
// replaying the whole log, as every stage does on start), broker reload time and memory.
//
//   npx tsx tools/bench/broker-bench.ts [--payments 10000] [--publishers 8] [--subscribers 10] [--pipelined]
//
// Spawns the real broker as a child process on a free port with a temp data dir and removes it after.
// The synthetic event mix mimics M2: ~12 events per payment, 3 of them carrying a 2-4 KB ISO 20022 XML.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AnyEvent } from '@ct/contracts';
import { LocalBrokerBus } from '../../packages/event-bus/src/local-broker-bus';
import type { EventBus } from '../../packages/event-bus/src/types';
import { DEFAULT_ROOT_DIR } from '../launcher/launch';
import { killTree, spawnTs, waitForExit } from '../launcher/process';
import { processRssBytes } from './rss';

const TYPES = [
  'payment.initiated', 'payment.screened', 'payment.scored', 'payment.quoted', 'payment.routed', 'payment.sent',
  'payment.send_failed', 'payment.routed', 'payment.sent', 'payment.settled', 'ledger.posted', 'payment.reconciled',
] as const;
const XML_TYPES = new Set(['payment.sent', 'payment.settled', 'payment.send_failed']);

function xml(seed: number): string {
  const n = 2048 + (seed % 2048);
  const head = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf>`;
  let body = '';
  while (body.length < n) body += `<CdtTrfTxInf><PmtId><EndToEndId>E2E${seed}</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="USD">1234.56</IntrBkSttlmAmt></CdtTrfTxInf>`;
  return `${head}${body.slice(0, n)}</FIToFICstmrCdtTrf></Document>`;
}

export function syntheticEvents(payments: number): AnyEvent[] {
  const out: AnyEvent[] = [];
  for (let p = 0; p < payments; p++) {
    const paymentId = `bench-${p.toString(36).padStart(8, '0')}-0000-4000-8000-000000000000`;
    let prev: string | null = null;
    TYPES.forEach((type, i) => {
      const eventId = `${paymentId}-e${i}`;
      const payload: Record<string, unknown> = {
        amount: { amountMinor: 100_000 + p, currency: 'USD' },
        providerId: 'orion',
        note: 'synthetic benchmark event',
      };
      if (XML_TYPES.has(type)) payload.message = xml(p * 13 + i);
      out.push({
        eventId,
        type,
        schemaVersion: 1,
        paymentId,
        occurredAt: new Date(1_790_000_000_000 + p * 1000 + i).toISOString(),
        correlationId: paymentId,
        causationId: prev,
        producer: 'settlement',
        payload,
        trace: { stage: 'settlement', decision: 'bench', reasonCodes: ['BENCH'], inputs: { p, i }, ruleVersion: 'bench-v1', latencyMs: 0.1 },
      } as unknown as AnyEvent);
      prev = eventId;
    });
  }
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const quiet = { warn: () => {}, error: (...a: unknown[]) => console.error(...a) };

async function startBrokerProcess(port: number, dataDir: string) {
  const t0 = performance.now();
  const lines: string[] = [];
  const child = spawnTs({
    rootDir: DEFAULT_ROOT_DIR,
    script: 'services/broker/src/index.ts',
    env: { ...process.env, BROKER_PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1', CT_SUPERVISED: '1' },
    onLine: (l) => lines.push(l),
  });
  for (;;) {
    if (child.exitCode !== null) throw new Error(`broker exited: ${lines.join('\n')}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) {
        const body = (await r.json()) as { events: number };
        return { child, readyMs: performance.now() - t0, events: body.events, lines };
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function rate(n: number, ms: number): string {
  return `${Math.round((n / ms) * 1000).toLocaleString('en-US')}/s`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string, d: number) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? Number(argv[i + 1]) : d;
  };
  const payments = opt('payments', 10_000);
  const publishers = opt('publishers', 8);
  const subscribers = opt('subscribers', 10);
  const pipelined = argv.includes('--pipelined');
  const events = syntheticEvents(payments);
  const totalBytes = events.reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e)), 0);
  console.log(`events: ${events.length.toLocaleString('en-US')} (${(totalBytes / 1e6).toFixed(1)} MB JSON), publishers ${publishers}${pipelined ? ' (pipelined)' : ' (sequential, like stages)'}, subscribers ${subscribers}`);

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-bench-'));
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  let broker = await startBrokerProcess(port, dataDir);
  const results: Record<string, string | number> = {};
  try {
    // ---- publish
    const buses: EventBus[] = await Promise.all(Array.from({ length: publishers }, (_, i) => LocalBrokerBus.connect(url, `bench-pub-${i}`, { logger: quiet })));
    let next = 0;
    const offsets: number[] = [];
    const t0 = performance.now();
    await Promise.all(
      buses.map(async (bus) => {
        if (pipelined) {
          const inflight = new Set<Promise<unknown>>();
          while (next < events.length) {
            const i = next++;
            const p: Promise<unknown> = bus.publish(events[i]!).then((m) => { offsets[i] = m.offset; inflight.delete(p); });
            inflight.add(p);
            if (inflight.size >= 64) await Promise.race(inflight);
          }
          await Promise.all(inflight);
        } else {
          while (next < events.length) {
            const i = next++;
            offsets[i] = (await bus.publish(events[i]!)).offset;
          }
        }
      }),
    );
    const pubMs = performance.now() - t0;
    results.publish = rate(events.length, pubMs);
    console.log(`publish: ${events.length} events in ${(pubMs / 1000).toFixed(2)} s = ${results.publish}`);

    // ---- duplicate publish (idempotent append): republish 1000 already-stored events
    const dupT0 = performance.now();
    const dupOffsets = await Promise.all(events.slice(0, 1000).map((e) => buses[0]!.publish(e)));
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { events: number };
    const dupOk = dupOffsets.every((m, i) => m.offset === offsets[i]) && health.events === events.length;
    console.log(`idempotent re-publish of 1000 events: ${dupOk ? 'no new appends, original offsets returned' : `APPENDED DUPLICATES (log now ${health.events})`} (${(performance.now() - dupT0).toFixed(0)} ms)`);
    results.idempotentAppend = dupOk ? 'ok' : 'FAILED';
    await Promise.all(buses.map((b) => b.close()));

    // ---- catch-up delivery: N ephemeral subscribers (separate processes, like stages) replay the whole log
    let peakRss = 0;
    const sampler = setInterval(() => {
      void processRssBytes(broker.child.pid!).then((r) => {
        if (r && r > peakRss) peakRss = r;
      });
    }, 250);
    const c0 = performance.now();
    const perSub = await Promise.all(
      Array.from(
        { length: subscribers },
        (_, i) =>
          new Promise<number>((resolve, reject) => {
            let done: number | null = null;
            const out: string[] = [];
            const child = spawnTs({
              rootDir: DEFAULT_ROOT_DIR,
              script: 'tools/bench/sub-worker.ts',
              args: [url, String(events.length), `sub-${i}`],
              env: process.env,
              onLine: (l) => {
                out.push(l);
                const m = /^done (\d+)/.exec(l);
                if (m) done = Number(m[1]);
              },
            });
            child.once('exit', () => (done === null ? reject(new Error(`subscriber ${i} failed:\n${out.join('\n')}`)) : resolve(done)));
          }),
      ),
    );
    clearInterval(sampler);
    const catchMs = performance.now() - c0;
    results.catchUpAll = `${(catchMs / 1000).toFixed(2)} s`;
    results.deliveryAggregate = rate(events.length * subscribers, catchMs);
    console.log(
      `catch-up: ${subscribers} subscribers x ${events.length} events in ${(catchMs / 1000).toFixed(2)} s ` +
        `(aggregate ${results.deliveryAggregate}, slowest subscriber ${(Math.max(...perSub) / 1000).toFixed(2)} s)`,
    );
    const rssAfterFanout = peakRss || null;

    // ---- reload
    await killTree(broker.child);
    await waitForExit(broker.child, 5000);
    const logBytes = statSync(path.join(dataDir, 'broker', 'payments.log')).size;
    broker = await startBrokerProcess(port, dataDir);
    const rss = await processRssBytes(broker.child.pid!);
    results.reloadMs = Math.round(broker.readyMs);
    console.log(
      `reload: ${broker.events} events / ${(logBytes / 1e6).toFixed(1)} MB log ready in ${(broker.readyMs / 1000).toFixed(2)} s ` +
        `(incl. ~0.5-1 s node+tsx startup); broker RSS after reload ${rss ? (rss / 1e6).toFixed(0) : '?'} MB, peak during fan-out ${rssAfterFanout ? (rssAfterFanout / 1e6).toFixed(0) : '?'} MB`,
    );
    const stats = await fetch(`http://127.0.0.1:${port}/stats`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (stats) console.log(`broker /stats: ${JSON.stringify(stats)}`);
  } finally {
    await killTree(broker.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const entry = process.argv[1];
if (entry && path.resolve(entry).toLowerCase().endsWith(path.join('tools', 'bench', 'broker-bench.ts').toLowerCase())) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
