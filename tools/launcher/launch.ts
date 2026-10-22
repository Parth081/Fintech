// Starts the whole Control Tower as separate local processes, in dependency order, and stops it
// again without leaving orphans. Used by `npm start` (index.ts) and by the end-to-end test.
import type { ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { busyPortsMessage, findBusyPorts } from './ports';
import { isRunning, killTree, spawnShell, spawnTs, waitForExit } from './process';

/** Stage processes (services/stages). Since M2 the ledger is its own service (services/ledger), not a stage. */
export const STAGES = ['screening', 'risk', 'fx', 'routing', 'settlement', 'reconciliation'] as const;
export type Stage = (typeof STAGES)[number];

/** Every process the launcher manages, in start order. Names accepted by restart()/kill(). */
export const SERVICE_NAMES = ['broker', 'payment-api', ...STAGES, 'ledger', 'gateway'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const DEFAULT_ROOT_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export interface LaunchOptions {
  /** Repo root (default: two levels above this file). */
  rootDir?: string;
  host?: string;
  /** Ports; `ledger` defaults to gateway + 1 (7073 with the default gateway port). */
  ports?: { broker?: number; paymentApi?: number; gateway?: number; ledger?: number };
  /** Event-log directory; relative paths resolve against rootDir. */
  dataDir?: string;
  /** Delete dataDir before starting. */
  reset?: boolean;
  stageDelayMs?: number;
  settlementDelayMs?: number;
  /** Postgres URL for the ledger; empty/undefined = embedded PGlite under dataDir/ledger (env DATABASE_URL). */
  databaseUrl?: string;
  /** Simulation seed for markets and providers (env SIM_SEED). */
  simSeed?: string;
  /** Provider failure scale, 0 disables failures (env PROVIDER_FAILURE_SCALE). */
  providerFailureScale?: number;
  /** Extra environment for every child (wins over the computed values). */
  env?: Record<string, string>;
  /** Suppress child log lines (errors and timeouts are still reported). */
  quiet?: boolean;
  /** Run `npm run build:web` if apps/web/dist/index.html is missing (default true). */
  buildWeb?: boolean;
  /** Per-service readiness timeout (default 30s). */
  startupTimeoutMs?: number;
  /** Where log lines go (default: process.stdout). */
  log?: (line: string) => void;
  /** Called once if a service dies after startup; everything has already been stopped. */
  onUnexpectedExit?: (error: Error) => void;
}

export interface LaunchedSystem {
  urls: { gateway: string; paymentApi: string; broker: string; ledger: string };
  /** Names of the processes this launch manages (broker omitted with BUS=kafka). */
  services: readonly ServiceName[];
  /**
   * Kill one service (whole process tree, no graceful shutdown: a crash, for chaos tests). The rest of
   * the system keeps running and the exit is not treated as a failure. No-op if it is not running.
   */
  kill(name: ServiceName): Promise<void>;
  /** Kill (if running) and start one service again; resolves once it is ready (health URL / ready line). */
  restart(name: ServiceName): Promise<void>;
  /** True while the service's process is alive. */
  isRunning(name: ServiceName): boolean;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------

const COLORS: Record<string, number> = {
  broker: 35,
  'payment-api': 36,
  screening: 33,
  risk: 31,
  fx: 32,
  routing: 34,
  settlement: 95,
  ledger: 96,
  reconciliation: 93,
  gateway: 92,
  'build:web': 90,
  launcher: 97,
};

function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

const PREFIX_WIDTH = 'reconciliation'.length + 2;

export function prefixLine(name: string, line: string, color = useColor()): string {
  const tag = `[${name}]`.padEnd(PREFIX_WIDTH + 1);
  if (!color) return `${tag}${line}`;
  return `\x1b[${COLORS[name] ?? 37}m${tag}\x1b[0m${line}`;
}

/** Services already tag their own lines ("[fx] ready"); drop that tag so it is not printed twice. */
export function stripOwnTag(name: string, line: string): string {
  const tag = `[${name}] `;
  return line.startsWith(tag) ? line.slice(tag.length) : line;
}

interface ServiceSpec {
  name: string;
  script: string;
  args?: string[];
  /** Readiness: HTTP GET healthUrl returns 200, or a stdout line matches readyLine. */
  healthUrl?: string;
  readyLine?: RegExp;
}

interface Running {
  spec: ServiceSpec;
  child: ChildProcess;
  tail: string[];
  sawReadyLine: boolean;
  readyWaiters: (() => void)[];
  /** Killed on purpose via kill()/restart(): its exit is not a crash. */
  intentional: boolean;
}

const TAIL_LINES = 25;

class StartupError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Refuse to recursively delete the repo root, a parent of it, or a filesystem root. */
export function assertSafeToDelete(dir: string, rootDir: string): void {
  const target = path.resolve(dir);
  const root = path.resolve(rootDir);
  const rel = path.relative(target, root);
  const targetIsAncestorOrSelf = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (targetIsAncestorOrSelf || path.parse(target).root === target) {
    throw new Error(`Refusing to delete "${target}" for --reset: it is the repo root or one of its parents.`);
  }
}

export async function launch(options: LaunchOptions = {}): Promise<LaunchedSystem> {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  // Probe/connect via loopback when binding to all interfaces.
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const brokerPort = options.ports?.broker ?? 7070;
  const paymentApiPort = options.ports?.paymentApi ?? 7071;
  const gatewayPort = options.ports?.gateway ?? 7072;
  const ledgerPort = options.ports?.ledger ?? gatewayPort + 1;
  const dataDir = path.resolve(rootDir, options.dataDir ?? '.data');
  const timeoutMs = options.startupTimeoutMs ?? 30_000;
  const quiet = options.quiet ?? false;
  const write = options.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const say = (msg: string): void => write(prefixLine('launcher', msg));
  const bus = options.env?.BUS ?? process.env.BUS ?? 'local';

  const urls = {
    broker: `ws://${probeHost}:${brokerPort}`,
    paymentApi: `http://${probeHost}:${paymentApiPort}`,
    gateway: `http://${probeHost}:${gatewayPort}`,
    ledger: `http://${probeHost}:${ledgerPort}`,
  };

  // 1. Ports first: fail fast with a helpful message instead of a cryptic EADDRINUSE later.
  const wanted = [
    ...(bus === 'kafka' ? [] : [{ name: 'broker', port: brokerPort }]),
    { name: 'payment-api', port: paymentApiPort },
    { name: 'gateway', port: gatewayPort },
    { name: 'ledger', port: ledgerPort },
  ];
  if (new Set(wanted.map((w) => w.port)).size !== wanted.length) {
    throw new StartupError(`Ports must be different: ${wanted.map((w) => `${w.name} ${w.port}`).join(', ')}`);
  }
  const busy = await findBusyPorts(wanted, probeHost);
  if (busy.length > 0) throw new StartupError(busyPortsMessage(busy, probeHost));

  // 2. Reset data if asked.
  if (options.reset) {
    assertSafeToDelete(dataDir, rootDir);
    rmSync(dataDir, { recursive: true, force: true });
    say(`reset: deleted ${dataDir}`);
  }

  const webDist = path.join(rootDir, 'apps', 'web', 'dist');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CT_SUPERVISED: '1',
    HOST: host,
    BROKER_PORT: String(brokerPort),
    PAYMENT_API_PORT: String(paymentApiPort),
    GATEWAY_PORT: String(gatewayPort),
    LEDGER_PORT: String(ledgerPort),
    BUS: bus,
    BROKER_URL: urls.broker,
    PAYMENT_API_URL: urls.paymentApi,
    GATEWAY_URL: urls.gateway,
    LEDGER_URL: urls.ledger,
    DATA_DIR: dataDir,
    DATABASE_URL: options.databaseUrl ?? process.env.DATABASE_URL ?? '',
    SIM_SEED: options.simSeed ?? process.env.SIM_SEED ?? 'control-tower',
    PROVIDER_FAILURE_SCALE: String(options.providerFailureScale ?? process.env.PROVIDER_FAILURE_SCALE ?? 1),
    WEB_DIST: webDist,
    STAGE_DELAY_MS: String(options.stageDelayMs ?? process.env.STAGE_DELAY_MS ?? 400),
    SETTLEMENT_DELAY_MS: String(options.settlementDelayMs ?? process.env.SETTLEMENT_DELAY_MS ?? 900),
    ...options.env,
  };

  const running: Running[] = [];
  const specs = new Map<ServiceName, ServiceSpec>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopping = true;
      stopPromise = (async () => {
        // Stop in reverse dependency order (gateway, then api + stages, then broker) so consumers do
        // not log broker-disconnect noise. Each tier is killed in parallel; killTree waits for exit.
        const tier = (r: Running): number => (r.spec.name === 'gateway' ? 0 : r.spec.name === 'broker' ? 2 : 1);
        await Promise.all(restarting);
        for (const t of [0, 1, 2]) {
          await Promise.all(running.filter((r) => tier(r) === t && !(r.intentional && !isRunning(r.child))).map((r) => killTree(r.child)));
        }
      })();
    }
    return stopPromise;
  };

  const describeFailure = (r: Running, why: string): string => {
    const tail = r.tail.length ? r.tail.map((l) => `    ${l}`).join('\n') : '    (no output)';
    return `${why}\n  Last log lines from [${r.spec.name}]:\n${tail}`;
  };

  let started = false;
  let reportedCrash = false;
  /** First service that died while the system was still starting up. */
  let startupCrash: Running | undefined;
  const crashWaiters: (() => void)[] = [];
  const onExit = (r: Running, code: number | null, signal: NodeJS.Signals | null): void => {
    if (stopping || r.intentional) return;
    if (!started) {
      startupCrash ??= r;
      for (const w of crashWaiters.splice(0)) w();
      return;
    }
    // Windows delivers Ctrl+C to children too; give our own SIGINT handler a moment to set `stopping`.
    setTimeout(() => {
      if (stopping || reportedCrash) return;
      reportedCrash = true;
      const err = new Error(
        describeFailure(r, `Service [${r.spec.name}] exited unexpectedly (code ${code}, signal ${signal}). Stopping everything.`),
      );
      write(prefixLine('launcher', err.message));
      void stop().then(() => {
        if (options.onUnexpectedExit) options.onUnexpectedExit(err);
      });
    }, 300);
  };

  const start = (spec: ServiceSpec): Running => {
    specs.set(spec.name as ServiceName, spec);
    const r: Running = { spec, child: undefined as unknown as ChildProcess, tail: [], sawReadyLine: false, readyWaiters: [], intentional: false };
    r.child = spawnTs({
      rootDir,
      script: spec.script,
      args: spec.args,
      env: childEnv,
      onLine: (line) => {
        r.tail.push(line);
        if (r.tail.length > TAIL_LINES) r.tail.shift();
        if (!quiet) write(prefixLine(spec.name, stripOwnTag(spec.name, line)));
        if (spec.readyLine && !r.sawReadyLine && spec.readyLine.test(line)) {
          r.sawReadyLine = true;
          for (const w of r.readyWaiters.splice(0)) w();
        }
      },
    });
    r.child.on('error', (e) => r.tail.push(`spawn error: ${e.message}`));
    r.child.on('exit', (code, signal) => onExit(r, code, signal));
    running.push(r);
    return r;
  };

  const waitReady = async (r: Running): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    const exited = (): boolean => !isRunning(r.child) || startupCrash !== undefined;
    if (r.spec.healthUrl) {
      while (Date.now() < deadline) {
        if (exited()) break;
        if (await httpOk(r.spec.healthUrl)) return;
        await sleep(150);
      }
    } else if (r.spec.readyLine) {
      if (r.sawReadyLine) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        r.readyWaiters.push(done);
        crashWaiters.push(done);
        r.child.once('exit', done);
        if (startupCrash || !isRunning(r.child)) done();
      });
      if (r.sawReadyLine) return;
    }
    const culprit = startupCrash ?? r;
    // Let trailing output arrive before quoting it.
    await waitForExit(culprit.child, 200);
    if (culprit !== r) {
      throw new StartupError(
        describeFailure(culprit, `Service [${culprit.spec.name}] exited during startup (code ${culprit.child.exitCode}).`),
      );
    }
    const why = !isRunning(r.child)
      ? `Service [${r.spec.name}] exited during startup (code ${r.child.exitCode}).`
      : `Service [${r.spec.name}] did not become ready within ${timeoutMs} ms ` +
        (r.spec.healthUrl ? `(GET ${r.spec.healthUrl} never returned 200).` : `(no stdout line matching ${r.spec.readyLine}).`);
    throw new StartupError(describeFailure(r, why));
  };

  try {
    // 3. UI build (only when missing).
    if ((options.buildWeb ?? true) && !existsSync(path.join(webDist, 'index.html'))) {
      say('apps/web/dist is missing - building the UI (npm run build:web)...');
      const tail: string[] = [];
      const build = spawnShell('npm run build:web', rootDir, process.env, (line) => {
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        if (!quiet) write(prefixLine('build:web', line));
      });
      const code = await new Promise<number | null>((resolve) => {
        build.once('error', () => resolve(-1));
        build.once('exit', (c) => resolve(c));
      });
      if (code !== 0) {
        throw new StartupError(
          `UI build failed (npm run build:web exited with ${code}).\n${tail.map((l) => `    ${l}`).join('\n')}`,
        );
      }
    }

    // 4. Broker (unless an external Kafka/Redpanda is the bus).
    if (bus !== 'kafka') {
      const broker = start({ name: 'broker', script: 'services/broker/src/index.ts', healthUrl: `http://${probeHost}:${brokerPort}/health` });
      await waitReady(broker);
    }

    // 5. Payment API + one process per stage, in parallel.
    const api = start({ name: 'payment-api', script: 'services/payment-api/src/index.ts', healthUrl: `${urls.paymentApi}/health` });
    const stages = STAGES.map((s) =>
      start({ name: s, script: 'services/stages/src/index.ts', args: ['--stage', s], readyLine: /\bready\b/i }),
    );
    // The ledger service (M2) replaces the old ledger stage: consumes settlements, posts journals.
    const ledger = start({ name: 'ledger', script: 'services/ledger/src/index.ts', healthUrl: `${urls.ledger}/health` });
    await Promise.all([api, ...stages, ledger].map(waitReady));

    // 6. Gateway (serves the UI).
    const gateway = start({ name: 'gateway', script: 'services/gateway/src/index.ts', healthUrl: `${urls.gateway}/health` });
    await waitReady(gateway);
    started = true;
  } catch (e) {
    await stop();
    throw e;
  }

  const current = (name: ServiceName): Running | undefined => {
    for (let i = running.length - 1; i >= 0; i--) if (running[i]!.spec.name === name) return running[i];
    return undefined;
  };
  const restarting = new Set<Promise<void>>();

  const kill = async (name: ServiceName): Promise<void> => {
    if (stopping) return;
    const r = current(name);
    if (!r) throw new Error(`unknown service "${name}" (have: ${[...specs.keys()].join(', ')})`);
    if (!isRunning(r.child)) return;
    r.intentional = true;
    await killTree(r.child);
  };

  const restart = (name: ServiceName): Promise<void> => {
    const spec = specs.get(name);
    if (!spec) return Promise.reject(new Error(`unknown service "${name}" (have: ${[...specs.keys()].join(', ')})`));
    const p = (async () => {
      await kill(name);
      if (stopping) return;
      const old = current(name);
      if (old) running.splice(running.indexOf(old), 1);
      const r = start(spec);
      if (!quiet) say(`restarting ${name}`);
      await waitReady(r);
    })();
    restarting.add(p);
    void p.finally(() => restarting.delete(p)).catch(() => {});
    return p;
  };

  return {
    urls,
    services: [...specs.keys()],
    kill,
    restart,
    isRunning: (name) => {
      const r = current(name);
      return r !== undefined && isRunning(r.child);
    },
    stop,
  };
}

export function banner(gatewayUrl: string): string {
  const lines = [
    'Global Fintech Control Tower is running',
    '',
    `  Open ${gatewayUrl}`,
    '  Then click "Send test payment", or run: npm run traffic -- --count 10',
    '',
    '  Simulation · synthetic data · runs offline',
    '  Press Ctrl+C to stop all services.',
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const bar = '─'.repeat(width);
  return [`┌${bar}┐`, ...lines.map((l) => `│ ${l.padEnd(width - 1)}│`), `└${bar}┘`].join('\n');
}
