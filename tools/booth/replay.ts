// Recorded backup run ("safe mode"): replay library. A recording is a JSONL file (one BusEvent per line, in
// log order) next to a RecordingMeta (`<dataDir>/recordings/<name>.jsonl` + `.meta.json`), made by record.ts.
//
// Playback publishes the events into a (fresh) bus in order with their original relative timing and makes
// every loop look brand new to the UI:
//   * Time: every ISO date-time in the event (occurredAt, quote rateTimestamp/expiresAt, timestamps inside
//     XML messages, decision traces, alert evidence) is mapped to  loopStart + (t - firstOccurredAt) / speed,
//     so the first event of each loop is "now". Plain dates (valueDate, bookingDate) are kept.
//   * Identity: every id is re-keyed per (publisher start, loop): UUIDs through a deterministic UUID-shaped
//     hash, other ids (test fixtures) by a suffix. The same mapping is applied to the whole event text, so
//     paymentId, correlationId, causationId, eventId and ids embedded in payloads / XML stay consistent, and
//     scenario run ids differ per loop. Events never collide with an earlier loop, so the bus' eventId
//     idempotency only swallows a genuine re-publish of the same loop (e.g. a retried publish).
//   * Counts: each loop adds its payments as NEW payments (like a live system, totals keep climbing); nothing
//     is double counted and nothing is rejected as a duplicate. The recorder closes scenarios/outages that
//     were still open at the end, so every loop leaves the control state clean.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deterministicId, type BusEvent, type RecordingMeta } from '@ct/contracts';
import type { EventBus } from '@ct/event-bus';

export const RECORDINGS_DIR = 'recordings';
export const RECORDING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function assertRecordingName(name: string): void {
  if (!RECORDING_NAME_RE.test(name) || name.endsWith('.') || name.includes('..')) {
    throw new Error(`invalid recording name "${name}" (letters, digits, dot, dash, underscore; max 80)`);
  }
}

export const recordingsDir = (dataDir: string): string => join(dataDir, RECORDINGS_DIR);

/** `<dataDir>/recordings/<name>.jsonl` */
export function recordingPath(dataDir: string, name: string): string {
  assertRecordingName(name);
  return join(recordingsDir(dataDir), `${name}.jsonl`);
}

/** `<dataDir>/recordings/<name>.meta.json` */
export function metaPath(dataDir: string, name: string): string {
  assertRecordingName(name);
  return join(recordingsDir(dataDir), `${name}.meta.json`);
}

function isMeta(x: unknown): x is RecordingMeta {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    typeof m.recordedAt === 'string' &&
    typeof m.eventCount === 'number' &&
    typeof m.firstOccurredAt === 'string' &&
    typeof m.lastOccurredAt === 'string' &&
    typeof m.durationMs === 'number' &&
    m.format === 1
  );
}

/** All usable recordings (meta valid, event file present), newest first. A damaged meta file is skipped. */
export function listRecordings(dataDir: string): RecordingMeta[] {
  const dir = recordingsDir(dataDir);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RecordingMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    const name = f.slice(0, -'.meta.json'.length);
    if (!RECORDING_NAME_RE.test(name)) continue;
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (isMeta(meta) && meta.name === name && existsSync(join(dir, `${name}.jsonl`))) out.push(meta);
    } catch {
      /* unreadable meta: not a usable recording */
    }
  }
  return out.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.name.localeCompare(b.name));
}

export function newestRecording(dataDir: string): RecordingMeta | undefined {
  return listRecordings(dataDir)[0];
}

// ---- reading -----------------------------------------------------------------------------------

export interface LoadedRecording {
  events: BusEvent[];
  /** Lines that were not a valid event (skipped). */
  skipped: number;
}

export function parseRecording(text: string): LoadedRecording {
  const events: BusEvent[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as BusEvent;
      if (typeof e?.eventId === 'string' && typeof e.type === 'string' && typeof e.paymentId === 'string' && Number.isFinite(Date.parse(e.occurredAt))) events.push(e);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

export function readRecording(file: string): LoadedRecording {
  return parseRecording(readFileSync(file, 'utf8'));
}

// ---- transform: time shift + re-keying ------------------------------------------------------------

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ISO_DATETIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Transformer {
  /** Event as it is published in loop `loop` (a new object; the input is not modified). */
  apply(event: BusEvent, loop: number): BusEvent;
}

export interface TransformOptions {
  /** Time of the first event in the recording (ms). */
  firstMs: number;
  /** Playback speed factor (1 = real time). */
  speed: number;
  /** Distinguishes publisher starts (so a restarted publisher never collides with its previous run). */
  salt: string;
  /** Non-UUID payment/event ids found in the recording (fixtures); UUIDs need no list. */
  plainIds: readonly string[];
}

/** Ids of the recording that are not UUIDs (they need an explicit mapping). */
export function plainIdsOf(events: readonly BusEvent[]): string[] {
  const set = new Set<string>();
  const uuid = new RegExp(`^${UUID}$`);
  for (const e of events) {
    for (const id of [e.eventId, e.paymentId, (e as { correlationId?: string }).correlationId, (e as { causationId?: string | null }).causationId]) {
      if (typeof id === 'string' && id !== '' && id !== '__control__' && !uuid.test(id)) set.add(id);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

export function makeTransformer(opts: TransformOptions & { loopStartMs: (loop: number) => number }): Transformer {
  const plain = opts.plainIds.length ? `|(?<![A-Za-z0-9_.~-])(?:${opts.plainIds.map(escapeRe).join('|')})(?![A-Za-z0-9_.~-])` : '';
  const source = `(${ISO_DATETIME})|(${UUID})${plain}`;
  return {
    apply(event, loop) {
      const base = opts.loopStartMs(loop);
      const re = new RegExp(source, 'g');
      const text = JSON.stringify(event).replace(re, (match: string, iso: string | undefined, uuid: string | undefined) => {
        if (iso !== undefined) {
          const t = Date.parse(iso);
          return Number.isFinite(t) ? new Date(Math.round(base + (t - opts.firstMs) / opts.speed)).toISOString() : match;
        }
        if (uuid !== undefined) return deterministicId(uuid.toLowerCase(), 'replay', opts.salt, String(loop));
        return `${match}~${opts.salt}${loop}`;
      });
      return JSON.parse(text) as BusEvent;
    },
  };
}

/** Milliseconds from the loop start at which each event is published (non-decreasing, speed applied). */
export function playbackOffsets(events: readonly BusEvent[], speed: number): number[] {
  const first = Date.parse(events[0]!.occurredAt);
  let prev = 0;
  return events.map((e) => {
    prev = Math.max(prev, (Date.parse(e.occurredAt) - first) / speed);
    return prev;
  });
}

// ---- publisher -------------------------------------------------------------------------------------

export interface ReplayOptions {
  bus: EventBus;
  /** Path of the .jsonl recording (see recordingPath). */
  file: string;
  /** Play again and again (default false). Each loop starts `gapMs` after the previous one ended. */
  loop?: boolean;
  /** Called when a loop iteration starts (0 for the first), before its first event. */
  onLoop?: (iteration: number) => void;
  /** Clock in ms (tests). Default Date.now. */
  now?: () => number;
  /** Wait that must resolve early when `signal` aborts (tests inject a virtual-time sleep). Default: setTimeout. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 1 = original timing, 2 = twice as fast. Default 1. */
  speed?: number;
  /** Pause between the end of a loop and the start of the next one. Default 3000 ms. */
  gapMs?: number;
  /** Id salt (default: the start time). Same salt + same loop = same ids. */
  salt?: string;
  log?: (line: string) => void;
}

export interface ReplayHandle {
  stop(): Promise<void>;
  /** Resolves when playback is over: the last event of a non-looping run was published, or stop() was called. */
  done: Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export async function startReplayPublisher(options: ReplayOptions): Promise<ReplayHandle> {
  const { bus, file } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const speed = options.speed ?? 1;
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error(`speed must be a positive number, got ${String(options.speed)}`);
  const gapMs = options.gapMs ?? 3000;
  const log = options.log ?? (() => undefined);
  const { events, skipped } = readRecording(file);
  if (skipped > 0) log(`[replay] skipped ${skipped} unreadable line(s) in ${file}`);
  if (events.length === 0) throw new Error(`recording ${file} has no events`);

  const offsets = playbackOffsets(events, speed);
  const lengthMs = offsets[offsets.length - 1] ?? 0;
  const loopStarts: number[] = [];
  const transformer = makeTransformer({
    firstMs: Date.parse(events[0]!.occurredAt),
    speed,
    salt: options.salt ?? now().toString(36),
    plainIds: plainIdsOf(events),
    loopStartMs: (loop) => loopStarts[loop] ?? now(),
  });

  const abort = new AbortController();
  const waitUntil = async (target: number) => {
    while (!abort.signal.aborted) {
      const wait = target - now();
      if (wait <= 0) return;
      await sleep(wait, abort.signal);
    }
  };

  const publish = async (event: BusEvent): Promise<void> => {
    // The bus append is idempotent by eventId, so retrying after a transient failure is always safe.
    for (let attempt = 0; !abort.signal.aborted; attempt++) {
      try {
        await bus.publish(event);
        return;
      } catch (err) {
        if (attempt === 0 || attempt % 10 === 0) log(`[replay] publish failed (${(err as Error).message}); retrying`);
        await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)), abort.signal);
      }
    }
  };

  const run = async (): Promise<void> => {
    let loopStart = now();
    for (let iteration = 0; !abort.signal.aborted; iteration++) {
      loopStarts[iteration] = loopStart;
      options.onLoop?.(iteration);
      for (let i = 0; i < events.length && !abort.signal.aborted; i++) {
        await waitUntil(loopStart + offsets[i]!);
        if (abort.signal.aborted) break;
        await publish(transformer.apply(events[i]!, iteration));
      }
      if (!options.loop || abort.signal.aborted) break;
      loopStart = Math.max(now(), loopStart + lengthMs) + gapMs;
      await waitUntil(loopStart);
    }
  };

  const done = run().catch((err: unknown) => {
    log(`[replay] stopped: ${(err as Error).message}`);
  });
  return {
    done,
    async stop() {
      abort.abort();
      await done;
    },
  };
}

// ---- CLI: `npm run booth:replay -- --name <n>` -----------------------------------------------------------
// A minimal safe system for manual use: broker + gateway (SYSTEM_MODE=safe) + this replay publisher, looping.
// (The launcher's safe-mode switch starts the same pieces, plus the assistant and the booth.)

export const REPLAY_USAGE = `Usage: npm run booth:replay -- [--name <n>] [options]

Starts a minimal safe system (broker + gateway + looping replay of a recording) for manual checks:
the big screen at http://127.0.0.1:<gateway-port>/#/stage shows the RECORDED RUN. Ctrl+C stops it.
The launcher's safe-mode switch (presenter console) is the normal way; this is for trying a recording.

  --name <n>          Recording to play (default: the newest in <data-dir>/recordings)
  --data-dir <dir>    Where recordings live (default env DATA_DIR, else .data)
  --speed <x>         Playback speed, 1 = original timing (default 1)
  --no-loop           Play once and stay on the final picture
  --gateway-port <n>  (default env GATEWAY_PORT, else 7072)
  --broker-port <n>   (default env BROKER_PORT, else 7070)
  --host <h>          (default 127.0.0.1)
  -h, --help
`;

export interface ReplayCliArgs {
  help: boolean;
  name?: string;
  dataDir?: string;
  speed: number;
  loop: boolean;
  gatewayPort?: number;
  brokerPort?: number;
  host?: string;
}

export function parseReplayArgs(argv: readonly string[]): ReplayCliArgs {
  const args: ReplayCliArgs = { help: false, speed: 1, loop: true };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const next = (): string => {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new Error(`${flag} needs a value`);
      return v;
    };
    const port = (): number => {
      const v = next();
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${flag} must be a port, got "${v}"`);
      return n;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--name':
        args.name = next();
        assertRecordingName(args.name);
        break;
      case '--data-dir':
        args.dataDir = next();
        break;
      case '--speed': {
        const v = next();
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > 100) throw new Error(`--speed must be a number between 0 and 100, got "${v}"`);
        args.speed = n;
        break;
      }
      case '--no-loop':
        args.loop = false;
        break;
      case '--gateway-port':
        args.gatewayPort = port();
        break;
      case '--broker-port':
        args.brokerPort = port();
        break;
      case '--host':
        args.host = next();
        break;
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run booth:replay -- --help" for usage.`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  let args: ReplayCliArgs;
  try {
    args = parseReplayArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(REPLAY_USAGE);
    return;
  }
  const { serviceConfig } = await import('@ct/contracts');
  const config = serviceConfig();
  const dataDir = resolve(args.dataDir ?? config.dataDir);
  const meta = args.name ? listRecordings(dataDir).find((m) => m.name === args.name) : newestRecording(dataDir);
  if (!meta) {
    console.error(args.name ? `[replay] no recording "${args.name}" in ${recordingsDir(dataDir)}` : `[replay] no recordings in ${recordingsDir(dataDir)} (make one with npm run booth:record)`);
    process.exit(1);
  }
  const host = args.host ?? config.host;
  const brokerPort = args.brokerPort ?? config.brokerPort;
  const gatewayPort = args.gatewayPort ?? config.gatewayPort;
  const { startBroker } = await import('../../services/broker/src/broker');
  const { startGateway } = await import('../../services/gateway/src/server');
  const { LocalBrokerBus } = await import('../../packages/event-bus/src/local-broker-bus');

  // A fresh, temporary log: the live data directory is never touched.
  const brokerData = mkdtempSync(join(tmpdir(), 'ct-replay-'));
  const broker = await startBroker({ host, port: brokerPort, dataDir: brokerData, logger: { log: () => undefined, warn: console.warn, error: console.error } });
  const gwBus = await LocalBrokerBus.connect(broker.url, 'gateway');
  const pubBus = await LocalBrokerBus.connect(broker.url, 'replay');
  const gateway = await startGateway({ bus: gwBus, host, port: gatewayPort, paymentApiUrl: 'http://127.0.0.1:1', mode: 'safe', recording: meta.name, simSeed: config.simSeed });
  const replay = await startReplayPublisher({
    bus: pubBus,
    file: recordingPath(dataDir, meta.name),
    loop: args.loop,
    speed: args.speed,
    onLoop: (n) => console.log(`[replay] loop ${n + 1} starts`),
    log: (l) => console.log(l),
  });
  console.log(`[replay] "${meta.name}" (${meta.eventCount} events, ${(meta.durationMs / 1000 / args.speed).toFixed(0)} s per loop) -> http://${host}:${gateway.port}/#/stage  (RECORDED RUN)`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[replay] ${signal}: stopping`);
    await replay.stop();
    await gateway.close();
    await pubBus.close();
    await gwBus.close();
    await broker.close();
    rmSync(brokerData, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  await replay.done;
  if (!args.loop) console.log('[replay] finished; the final picture stays up. Ctrl+C to stop.');
  await new Promise<void>(() => undefined);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('[replay] failed', err);
    process.exit(1);
  });
}
