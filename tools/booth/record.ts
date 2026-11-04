// Recorder for the recorded backup run ("safe mode"). Against a RUNNING live system it optionally starts a
// scenario and captures the broker log of a time window into
//   <dataDir>/recordings/<name>.jsonl      one BusEvent JSON per line, in log order
//   <dataDir>/recordings/<name>.meta.json  RecordingMeta
// What goes in: control events of the window, and every payment initiated in the window together with
// everything it produced (events that arrive after the window while the payment finishes are included, up to
// a grace period). Payments already in flight when recording started are left out, so the recording
// replays as a clean story. Scenarios, outages and shocks still open at the end are closed with synthetic
// control events so that every loop of the replay ends with clean control state.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicId, isControlEvent, makeControlEvent, serviceConfig, type BusEvent, type RecordingMeta } from '@ct/contracts';
import { assertRecordingName, metaPath, recordingPath, recordingsDir } from './replay';

/** Where the log is read from. The broker's HTTP API is the real one; tests also use an in-memory bus. */
export interface LogSource {
  /** Number of events in the log (= offset the next event gets). */
  head(): Promise<number>;
  read(from: number, limit: number): Promise<{ offset: number; event: BusEvent }[]>;
}

/** GET {brokerUrl}/health and GET {brokerUrl}/events?from=&limit= of services/broker. */
export function brokerHttpSource(brokerUrl: string, fetchFn: typeof fetch = fetch): LogSource {
  const base = brokerUrl.replace(/\/$/, '');
  return {
    async head() {
      const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`broker ${base}/health -> HTTP ${res.status}`);
      const body = (await res.json()) as { events?: unknown };
      if (typeof body.events !== 'number') throw new Error(`broker ${base}/health did not report an event count`);
      return body.events;
    },
    async read(from, limit) {
      const res = await fetchFn(`${base}/events?from=${from}&limit=${limit}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`broker ${base}/events -> HTTP ${res.status}`);
      return (await res.json()) as { offset: number; event: BusEvent }[];
    },
  };
}

export interface RecordOptions {
  name: string;
  /** Scenario to start through the gateway's orchestrator proxy (omit to record whatever happens). */
  scenario?: string;
  /** Length of the window in ms. Default 90 000. */
  durationMs?: number;
  /** Data dir root; recordings go to `<dataDir>/recordings`. Default env DATA_DIR, else .data. */
  dataDir?: string;
  /** Gateway URL, used only to start the scenario. Default http://127.0.0.1:7072. */
  gatewayUrl?: string;
  /** Log source: a broker URL or an already built source. Default http://127.0.0.1:7070. */
  broker?: string | LogSource;
  force?: boolean;
  /** How long after the window to wait for started payments to finish and scenarios to end. Default 20 000 ms. */
  graceMs?: number;
  /** Poll interval of the log. Default 400 ms. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface RecordResult {
  meta: RecordingMeta;
  file: string;
  metaFile: string;
  payments: number;
  controlEvents: number;
  /** Synthetic control events appended to close what was still open. */
  closers: number;
  /** Payments that had not finished when the grace period ended. */
  unfinishedPayments: number;
}

const TERMINAL = new Set(['payment.reconciled', 'payment.failed', 'payment.rejected', 'payment.held']);
const PAGE = 2000;

/** Control events that close what is still open at the end of the recording (pure; exported for tests). */
export function closingEvents(events: readonly BusEvent[]): BusEvent[] {
  const lastMs = events.length ? Date.parse(events[events.length - 1]!.occurredAt) : 0;
  const at = new Date(lastMs).toISOString();
  const mk = (type: Parameters<typeof makeControlEvent>[0], payload: unknown, key: string) =>
    makeControlEvent(type, payload as never, { eventId: deterministicId('recorder-close', type, key), occurredAt: at, producer: 'orchestrator' }) as BusEvent;
  const scenarios = new Map<string, { scenarioId: string }>();
  const outages = new Map<string, { runId?: string }>();
  const shocks = new Map<string, { runId?: string }>();
  let speed: unknown = null;
  let paused = false;
  for (const e of events) {
    if (!isControlEvent(e)) continue;
    switch (e.type) {
      case 'control.scenario.started':
        scenarios.set(e.payload.runId, { scenarioId: e.payload.scenarioId });
        break;
      case 'control.scenario.ended':
        scenarios.delete(e.payload.runId);
        break;
      case 'control.provider_outage.started':
        outages.set(e.payload.providerId, { runId: e.payload.runId });
        break;
      case 'control.provider_outage.ended':
        outages.delete(e.payload.providerId);
        break;
      case 'control.fx_shock.started':
        shocks.set(e.payload.shockId, { runId: e.payload.runId });
        break;
      case 'control.fx_shock.ended':
        shocks.delete(e.payload.shockId);
        break;
      case 'control.demo.speed':
        speed = e.payload.stageDelayMs === null && e.payload.settlementDelayMs === null ? null : e.payload;
        break;
      case 'control.demo.paused':
        paused = e.payload.paused;
        break;
      default:
        break;
    }
  }
  const out: BusEvent[] = [];
  for (const [providerId, o] of outages) out.push(mk('control.provider_outage.ended', { providerId, ...(o.runId ? { runId: o.runId } : {}) }, providerId));
  for (const [shockId, s] of shocks) out.push(mk('control.fx_shock.ended', { shockId, ...(s.runId ? { runId: s.runId } : {}) }, shockId));
  for (const [runId, s] of scenarios) out.push(mk('control.scenario.ended', { runId, scenarioId: s.scenarioId, outcome: 'stopped' }, runId));
  if (speed !== null) out.push(mk('control.demo.speed', { stageDelayMs: null, settlementDelayMs: null, label: 'Normal' }, 'speed'));
  if (paused) out.push(mk('control.demo.paused', { paused: false }, 'paused'));
  return out;
}

export function buildMeta(name: string, events: readonly BusEvent[], scenarioId: string | null, recordedAt: string): RecordingMeta {
  const times = events.map((e) => Date.parse(e.occurredAt));
  const first = Math.min(...times);
  const last = Math.max(...times);
  return {
    name,
    recordedAt,
    scenarioId,
    eventCount: events.length,
    firstOccurredAt: new Date(first).toISOString(),
    lastOccurredAt: new Date(last).toISOString(),
    durationMs: last - first,
    format: 1,
  };
}

export async function recordRun(opts: RecordOptions): Promise<RecordResult> {
  assertRecordingName(opts.name);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchFn = opts.fetch ?? fetch;
  const log = opts.log ?? (() => undefined);
  const durationMs = opts.durationMs ?? 90_000;
  const graceMs = opts.graceMs ?? 20_000;
  const pollMs = opts.pollMs ?? 400;
  const dataDir = resolve(opts.dataDir ?? serviceConfig().dataDir);
  const gatewayUrl = (opts.gatewayUrl ?? 'http://127.0.0.1:7072').replace(/\/$/, '');
  const source = typeof opts.broker === 'object' ? opts.broker : brokerHttpSource(opts.broker ?? 'http://127.0.0.1:7070', fetchFn);
  if (!(durationMs > 0)) throw new Error('duration must be positive');

  const file = recordingPath(dataDir, opts.name);
  const metaFile = metaPath(dataDir, opts.name);
  if (!opts.force && (existsSync(file) || existsSync(metaFile))) {
    throw new Error(`recording "${opts.name}" already exists (${file}); choose another --name or pass --force`);
  }

  const startHead = await source.head();
  const windowStart = now();
  if (opts.scenario) {
    const res = await fetchFn(`${gatewayUrl}/api/control/orchestrator/scenarios/${encodeURIComponent(opts.scenario)}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        res.status === 409
          ? `a scenario is already running; stop it first (presenter console) and try again (${detail})`
          : `could not start scenario "${opts.scenario}": HTTP ${res.status} ${detail}`,
      );
    }
    log(`scenario ${opts.scenario} started; recording for ${Math.round(durationMs / 1000)} s`);
  } else {
    log(`recording for ${Math.round(durationMs / 1000)} s (no scenario started)`);
  }

  const windowEnd = windowStart + durationMs;
  const captured: BusEvent[] = [];
  const tracked = new Set<string>(); // paymentIds initiated inside the window
  const finished = new Set<string>();
  let openScenarios = 0;
  let cursor = startHead;
  let windowEndHead: number | null = null;
  let graceEnd = Number.POSITIVE_INFINITY;

  const consume = (offset: number, event: BusEvent) => {
    if (isControlEvent(event)) {
      captured.push(event);
      if (event.type === 'control.scenario.started') openScenarios += 1;
      if (event.type === 'control.scenario.ended') openScenarios = Math.max(0, openScenarios - 1);
      return;
    }
    if (event.type === 'payment.initiated' && (windowEndHead === null || offset < windowEndHead)) tracked.add(event.paymentId);
    if (!tracked.has(event.paymentId)) return;
    captured.push(event);
    if (TERMINAL.has(event.type)) finished.add(event.paymentId);
  };

  const pump = async (upTo: number | null) => {
    for (;;) {
      const rows = await source.read(cursor, PAGE);
      if (rows.length === 0) return;
      for (const r of rows) {
        consume(r.offset, r.event);
        cursor = r.offset + 1;
      }
      if (upTo !== null && cursor >= upTo) return;
    }
  };

  let lastLog = windowStart;
  while (now() < windowEnd) {
    await pump(null);
    if (now() - lastLog >= 10_000) {
      lastLog = now();
      log(`  ${Math.round((now() - windowStart) / 1000)} s: ${captured.length} events, ${tracked.size} payments`);
    }
    await sleep(Math.min(pollMs, Math.max(0, windowEnd - now())));
  }
  windowEndHead = await source.head();
  await pump(windowEndHead);
  graceEnd = now() + graceMs;
  // Grace: let payments initiated in the window finish and scenarios end.
  while (now() < graceEnd && (finished.size < tracked.size || openScenarios > 0)) {
    await sleep(pollMs);
    await pump(null);
  }
  const unfinishedPayments = tracked.size - finished.size;

  if (captured.length === 0) throw new Error('nothing was recorded: the log did not grow in the window (is the system running, is ambient traffic on?)');
  const closers = closingEvents(captured);
  const events = [...captured, ...closers];
  const meta = buildMeta(opts.name, events, opts.scenario ?? null, new Date(now()).toISOString());

  mkdirSync(recordingsDir(dataDir), { recursive: true });
  const tmpJsonl = `${file}.tmp`;
  const tmpMeta = `${metaFile}.tmp`;
  writeFileSync(tmpJsonl, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + '\n');
  // Event file first: a recording only counts once its meta exists.
  renameSync(tmpJsonl, file);
  renameSync(tmpMeta, metaFile);

  return {
    meta,
    file,
    metaFile,
    payments: tracked.size,
    controlEvents: events.filter(isControlEvent).length,
    closers: closers.length,
    unfinishedPayments,
  };
}

// ---- CLI -----------------------------------------------------------------------------------------------

export const RECORD_USAGE = `Usage: npm run booth:record -- --name <name> [options]

Records a run of the RUNNING live system (npm start) so it can be played as the backup run ("safe mode").

  --name <n>          Recording name (required; letters, digits, . _ -)
  --scenario <id>     Start this scenario first: provider-outage | provider-degraded | fraud-ring | fx-spike |
                      sanctions-hit (default: none, record the ongoing traffic)
  --duration <s>      Length of the recorded window in seconds (default 90)
  --url <gateway>     Gateway URL, used to start the scenario (default http://127.0.0.1:7072)
  --broker <url>      Broker HTTP URL the log is read from (default http://127.0.0.1:7070)
  --out-dir <dir>     Data directory root; files go to <dir>/recordings (default env DATA_DIR, else .data)
  --grace <s>         Wait this long after the window for payments to finish (default 20)
  --force             Overwrite an existing recording
  -h, --help
`;

export interface RecordCliArgs {
  help: boolean;
  options: RecordOptions;
}

export function parseRecordArgs(argv: readonly string[]): RecordCliArgs {
  const options: RecordOptions = { name: '' };
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const next = (): string => {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new Error(`${flag} needs a value`);
      return v;
    };
    const seconds = (): number => {
      const v = next();
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number of seconds, got "${v}"`);
      return n * 1000;
    };
    switch (flag) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--name':
        options.name = next();
        break;
      case '--scenario':
        options.scenario = next();
        break;
      case '--duration':
        options.durationMs = seconds();
        break;
      case '--grace':
        options.graceMs = seconds();
        break;
      case '--url':
        options.gatewayUrl = next();
        break;
      case '--broker':
        options.broker = next();
        break;
      case '--out-dir':
        options.dataDir = next();
        break;
      case '--force':
        options.force = true;
        break;
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run booth:record -- --help" for usage.`);
    }
  }
  if (!help) {
    if (!options.name) throw new Error('--name is required');
    assertRecordingName(options.name);
  }
  return { help, options };
}

async function main(): Promise<void> {
  let args: RecordCliArgs;
  try {
    args = parseRecordArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(RECORD_USAGE);
    return;
  }
  try {
    const r = await recordRun({ ...args.options, log: (l) => console.log(`[record] ${l}`) });
    const m = r.meta;
    console.log(
      [
        '',
        `Recorded "${m.name}"${m.scenarioId ? ` (scenario ${m.scenarioId})` : ''}`,
        `  ${m.eventCount} events, ${r.payments} payments, ${r.controlEvents} control events (${r.closers} synthetic closers)`,
        `  plays for ${(m.durationMs / 1000).toFixed(1)} s, then loops`,
        `  ${r.file}`,
        r.unfinishedPayments > 0 ? `  note: ${r.unfinishedPayments} payment(s) had not finished when recording ended (they stay in flight in the replay)` : '',
        '',
      ]
        .filter((l, i, a) => l !== '' || i === 0 || i === a.length - 1)
        .join('\n'),
    );
  } catch (err) {
    console.error(`[record] ${(err as Error).message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
