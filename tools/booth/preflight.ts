// `npm run booth:preflight [-- --hot-spare]` - is THIS laptop ready to run the booth?
//
// Run it the evening before and again in the morning, with the same environment variables you will start the
// system with (BOOTH_STAFF_PIN, ASSISTANT_LLM). Every check says ok / warn / fail in plain English with a fix.
// Exit code 1 when anything FAILS (warnings do not fail). It starts nothing and changes nothing except a
// short-lived scratch file used to prove the data folder is writable.
// In-process (verify:m6): `runPreflight({ ... probes })` returns { checks, ok }; every probe can be replaced in tests.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface PreflightCheck {
  id: string;
  title: string;
  status: CheckStatus;
  /** Plain English: what was found. */
  message: string;
  /** What to do about it (always present for warn/fail). */
  fix?: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** True when no check failed (warnings are allowed). */
  ok: boolean;
  /** Items only a person can check, in the order to do them. */
  manual: string[];
  /** Present with hotSpare: the commands to prepare a second laptop. */
  hotSpare?: string[];
}

/** Everything that touches the machine. Replace any of these in tests. */
export interface PreflightProbes {
  nodeVersion(): string;
  platform(): NodeJS.Platform;
  exists(p: string): boolean;
  readText(p: string): string | null;
  listDir(p: string): string[];
  /** Total size in bytes of a folder (best effort). */
  dirSize(p: string): number;
  /** Newest modification time (ms) of any file under the given files/folders; null when none exist. */
  newestMtime(paths: string[]): number | null;
  mtime(p: string): number | null;
  /** Ports from the list that something already uses. */
  busyPorts(ports: number[]): Promise<number[]>;
  diskFreeBytes(dir: string): Promise<number | null>;
  freeMemBytes(): number;
  totalMemBytes(): number;
  nowMs(): number;
  /** Can a file be created in (and removed from) this folder? Creates the folder when missing. */
  canWrite(dir: string): boolean;
  /** `docker --version` output, or null when Docker is not installed / not answering. */
  dockerVersion(): Promise<string | null>;
}

export interface PreflightOptions {
  rootDir?: string;
  /** DATA_DIR (default env DATA_DIR or .data), resolved against rootDir. */
  dataDir?: string;
  /** Ports that must be free (default 7070-7079). */
  ports?: number[];
  env?: Record<string, string | undefined>;
  hotSpare?: boolean;
  /** Where the second laptop's copy will live, used to fill in the hot-spare commands. */
  sparePath?: string;
  probes?: Partial<PreflightProbes>;
}

export const DEFAULT_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 7070 + i);
export const MIN_NODE_MAJOR = 22;
export const MIN_DISK_BYTES = 2 * 1024 ** 3;
export const MIN_FREE_MEM_BYTES = 2 * 1024 ** 3;
export const HARD_MIN_FREE_MEM_BYTES = 1024 ** 3;
export const DEFAULT_STAFF_PIN = '2468';
const GB = 1024 ** 3;
const fmtGb = (b: number) => `${(b / GB).toFixed(1)} GB`;

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ------------------------------------------------------------------------------------------------ real probes

function walkFiles(p: string, visit: (file: string, size: number, mtimeMs: number) => void, depth = 0): void {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isFile()) return visit(p, st.size, st.mtimeMs);
  if (!st.isDirectory() || depth > 12) return;
  let names: string[];
  try {
    names = readdirSync(p);
  } catch {
    return;
  }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue;
    walkFiles(path.join(p, n), visit, depth + 1);
  }
}

function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  // Two probes: a connect succeeds when anything listens (also on 0.0.0.0, which Windows lets us bind next to),
  // and a bind catches the rest (EADDRINUSE / EACCES, for example a reserved range).
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(400, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => {
      sock.destroy();
      const srv = net.createServer();
      srv.once('error', () => resolve(true));
      srv.listen(port, host, () => srv.close(() => resolve(false)));
    });
  });
}

export function realProbes(): PreflightProbes {
  return {
    nodeVersion: () => process.version,
    platform: () => process.platform,
    exists: (p) => existsSync(p),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    dirSize: (p) => {
      let total = 0;
      walkFiles(p, (_f, size) => (total += size));
      return total;
    },
    newestMtime: (paths) => {
      let newest: number | null = null;
      for (const p of paths) walkFiles(p, (_f, _s, m) => (newest = newest === null || m > newest ? m : newest));
      return newest;
    },
    mtime: (p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
    busyPorts: async (ports) => {
      const busy: number[] = [];
      for (const p of ports) if (await portInUse(p)) busy.push(p);
      return busy;
    },
    diskFreeBytes: async (dir) => {
      // The data folder may not exist yet: ask about the nearest folder that does.
      let d = path.resolve(dir);
      while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
      try {
        const s = await statfs(d);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return null;
      }
    },
    freeMemBytes: () => os.freemem(),
    totalMemBytes: () => os.totalmem(),
    nowMs: () => Date.now(),
    canWrite: (dir) => {
      try {
        mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `.preflight-${process.pid}.tmp`);
        writeFileSync(f, 'ok');
        rmSync(f, { force: true });
        return true;
      } catch {
        return false;
      }
    },
    dockerVersion: () =>
      new Promise((resolve) => {
        try {
          const child = spawn('docker', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
          let out = '';
          const timer = setTimeout(() => {
            child.kill();
            resolve(null);
          }, 4000);
          child.stdout.on('data', (d: Buffer) => (out += d.toString()));
          child.once('error', () => {
            clearTimeout(timer);
            resolve(null);
          });
          child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? out.trim() || 'docker' : null);
          });
        } catch {
          resolve(null);
        }
      }),
  };
}

// ------------------------------------------------------------------------------------------------ the checks

/** Names of the workspace packages (from their package.json), to prove `npm install` linked them. */
function workspaceNames(root: string, p: PreflightProbes): string[] {
  const names: string[] = [];
  for (const group of ['packages', 'services', 'apps']) {
    for (const dir of p.listDir(path.join(root, group))) {
      const text = p.readText(path.join(root, group, dir, 'package.json'));
      if (!text) continue;
      try {
        const name = (JSON.parse(text) as { name?: string }).name;
        if (name) names.push(name);
      } catch {
        /* unreadable package.json: reported by the missing link */
      }
    }
  }
  return names;
}

export function parsePorts(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    const lo = range ? Number(range[1]) : Number(part);
    const hi = range ? Number(range[2]) : lo;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65535 || hi < lo || hi - lo > 200) throw new Error(`--ports: "${part}" is not a port or a range like 7070-7079`);
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  if (out.size === 0) throw new Error('--ports needs at least one port');
  return [...out].sort((a, b) => a - b);
}

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const root = options.rootDir ?? DEFAULT_ROOT;
  const env = options.env ?? process.env;
  const p: PreflightProbes = { ...realProbes(), ...options.probes };
  const dataDir = path.resolve(root, options.dataDir ?? env.DATA_DIR ?? '.data');
  const ports = options.ports ?? [...DEFAULT_PORTS];
  const checks: PreflightCheck[] = [];
  const add = (id: string, title: string, status: CheckStatus, message: string, fix?: string) => checks.push({ id, title, status, message, ...(fix ? { fix } : {}) });

  // Node
  {
    const v = p.nodeVersion();
    const major = Number(/^v?(\d+)/.exec(v)?.[1] ?? 0);
    const pinned = (p.readText(path.join(root, '.nvmrc')) ?? '').trim().replace(/^v/, '');
    if (major < MIN_NODE_MAJOR) add('node', 'Node.js version', 'fail', `Node ${v} is too old; the system needs Node ${MIN_NODE_MAJOR} or newer.`, `Install Node ${pinned || '24'} (nodejs.org, or "nvm use" in this folder), then open a new terminal.`);
    else if (pinned && String(major) !== pinned.split('.')[0]) add('node', 'Node.js version', 'ok', `Node ${v} works (supported: ${MIN_NODE_MAJOR}+). The project pins ${pinned}; rehearse on the version you will show on.`);
    else add('node', 'Node.js version', 'ok', `Node ${v}.`);
  }

  // Dependencies
  {
    const missing: string[] = [];
    for (const name of workspaceNames(root, p)) if (!p.exists(path.join(root, 'node_modules', ...name.split('/')))) missing.push(name);
    for (const dep of ['@anthropic-ai/sdk', 'tsx', 'vite', 'react']) if (!p.exists(path.join(root, 'node_modules', ...dep.split('/'), 'package.json'))) missing.push(dep);
    if (missing.length === 0) add('deps', 'Dependencies installed', 'ok', 'Workspace links, @anthropic-ai/sdk, tsx, vite and react are present.');
    else add('deps', 'Dependencies installed', 'fail', `Missing in node_modules: ${missing.join(', ')}.`, 'Run "npm install" in the project folder while you still have internet. It is not needed again at the booth.');
  }

  // Built UI
  {
    const index = path.join(root, 'apps', 'web', 'dist', 'index.html');
    const built = p.mtime(index);
    if (built === null) add('web-dist', 'Screens built', 'fail', 'apps/web/dist is missing, so the browser would show a blank page until a build finishes.', 'Run "npm run build:web" (works offline).');
    else {
      const newestSource = p.newestMtime([
        path.join(root, 'apps', 'web', 'src'),
        path.join(root, 'apps', 'web', 'index.html'),
        path.join(root, 'apps', 'web', 'vite.config.ts'),
        path.join(root, 'packages', 'contracts', 'src'),
      ]);
      if (newestSource !== null && newestSource > built + 2000) add('web-dist', 'Screens built', 'warn', 'The built screens are older than the source files, so the booth could show an old version.', 'Run "npm run build:web", then run this check again.');
      else add('web-dist', 'Screens built', 'ok', `apps/web/dist is up to date (built ${new Date(built).toISOString().replace('T', ' ').slice(0, 16)} UTC).`);
    }
  }

  // Ports
  {
    const busy = await p.busyPorts(ports);
    const range = ports.length > 1 && ports[ports.length - 1]! - ports[0]! === ports.length - 1 ? `${ports[0]}-${ports[ports.length - 1]}` : ports.join(', ');
    if (busy.length === 0) add('ports', 'Ports free', 'ok', `Ports ${range} are free.`);
    else
      add(
        'ports',
        'Ports free',
        'fail',
        `Already in use: ${busy.join(', ')}. Another copy of the Control Tower (or another program) is running.`,
        p.platform() === 'win32'
          ? `Find the program: netstat -ano | findstr :${busy[0]}  then taskkill /PID <pid> /F. Or start on other ports (npm start -- --broker-port 7170 --api-port 7171 --gateway-port 7172 ...).`
          : `Find the program: lsof -i :${busy[0]}  then kill <pid>. Or start on other ports (npm start -- --broker-port 7170 --api-port 7171 --gateway-port 7172 ...).`,
      );
  }

  // Disk
  {
    const free = await p.diskFreeBytes(dataDir);
    if (free === null) add('disk', 'Free disk space', 'warn', 'Could not read the free disk space.', 'Check by hand that the drive has at least 2 GB free.');
    else if (free < MIN_DISK_BYTES) add('disk', 'Free disk space', 'fail', `Only ${fmtGb(free)} free; at least ${fmtGb(MIN_DISK_BYTES)} is needed (event log, ledger, recordings).`, 'Delete downloads or old exports, empty the recycle bin, then run this check again.');
    else add('disk', 'Free disk space', 'ok', `${fmtGb(free)} free.`);
  }

  // Memory
  {
    const free = p.freeMemBytes();
    const total = p.totalMemBytes();
    if (free < HARD_MIN_FREE_MEM_BYTES) add('memory', 'Free memory', 'fail', `Only ${fmtGb(free)} of ${fmtGb(total)} memory is free; 13 processes plus a browser will not fit.`, 'Close browsers, chat apps and sync tools; restart the laptop if it is still low.');
    else if (free < MIN_FREE_MEM_BYTES) add('memory', 'Free memory', 'warn', `${fmtGb(free)} of ${fmtGb(total)} memory is free; 2 GB or more is comfortable.`, 'Close other programs before the doors open.');
    else add('memory', 'Free memory', 'ok', `${fmtGb(free)} of ${fmtGb(total)} memory is free.`);
  }

  // Clock
  {
    const now = p.nowMs();
    const newest = p.newestMtime(['apps', 'packages', 'services', 'tools', 'docs'].map((d) => path.join(root, d)));
    if (newest === null) add('clock', 'System clock', 'info', 'No project files found to compare the clock with.');
    else if (now < newest - 3_600_000) add('clock', 'System clock', 'warn', `The clock (${new Date(now).toISOString().slice(0, 16)}Z) is earlier than the newest project file (${new Date(newest).toISOString().slice(0, 16)}Z). Lead times and the event log would be wrong.`, 'Set the date, time and time zone correctly (turn automatic time on while you have internet).');
    else if (now > newest + 5 * 365 * 86_400_000) add('clock', 'System clock', 'warn', `The clock is more than 5 years after the newest project file; it may be wrong (${new Date(now).toISOString().slice(0, 16)}Z).`, 'Check the date and time and time zone.');
    else add('clock', 'System clock', 'ok', `The clock looks sane (${new Date(now).toISOString().slice(0, 16)}Z). Check the time zone yourself: lead timestamps are shown in UTC in the export.`);
  }

  // Data folder, leads, recordings
  {
    if (p.canWrite(dataDir)) add('data-dir', 'Data folder writable', 'ok', `${dataDir} can be written.`);
    else add('data-dir', 'Data folder writable', 'fail', `Cannot write to ${dataDir}.`, 'Run the terminal as the same user who owns the project folder, or pick another folder with DATA_DIR / --data-dir.');

    const booth = path.join(dataDir, 'booth');
    if (!p.exists(booth)) add('leads', 'Leads folder', 'ok', 'No leads folder yet: the booth starts with no stored visitor data.');
    else {
      const mb = (p.dirSize(booth) / 1024 ** 2).toFixed(1);
      add('leads', 'Leads folder', 'warn', `${booth} exists (${mb} MB) and may hold leads or analytics from an earlier event. A reset never deletes it.`, 'Export anything you need (npm run booth:export-leads), then clear it on purpose with the system stopped: npm run booth:clear-leads. Do not start a new event on old visitors\' data.');
    }

    const recDir = path.join(dataDir, 'recordings');
    const metas = p.listDir(recDir).filter((n) => n.endsWith('.meta.json'));
    if (metas.length === 0) add('recordings', 'Recorded backup run (safe mode)', 'warn', 'No recording found. Safe mode (the recorded backup run) has nothing to play if the live demo breaks.', 'Record one: npm start, then in a second terminal npm run booth:record -- --name backup --scenario provider-outage --duration 90');
    else {
      const named = metas.map((m) => m.replace(/\.meta\.json$/, ''));
      const complete = named.filter((n) => p.exists(path.join(recDir, `${n}.jsonl`)));
      if (complete.length === 0) add('recordings', 'Recorded backup run (safe mode)', 'warn', `Found ${metas.length} recording description(s) but no event file (.jsonl).`, 'Record it again: npm run booth:record -- --name backup --scenario provider-outage --duration 90');
      else {
        const newest = complete.map((n) => ({ n, t: p.mtime(path.join(recDir, `${n}.meta.json`)) ?? 0 })).sort((a, b) => b.t - a.t)[0]!;
        add('recordings', 'Recorded backup run (safe mode)', 'ok', `${complete.length} recording(s); newest "${newest.n}". Test it once: npm run booth:replay -- --name ${newest.n}.`);
      }
    }
  }

  // Staff PIN (only this process's environment is visible)
  {
    const pin = env.BOOTH_STAFF_PIN;
    if (!pin) add('pin', 'Staff PIN', 'warn', `BOOTH_STAFF_PIN is not set in this terminal, so the booth would use the public demo PIN ${DEFAULT_STAFF_PIN}. Anyone who has read the README could open the leads.`, 'Choose a PIN for this event and set it in the terminal you start the booth from (PowerShell: $env:BOOTH_STAFF_PIN="<PIN>"; Git Bash: export BOOTH_STAFF_PIN=<PIN>).');
    else if (pin === DEFAULT_STAFF_PIN) add('pin', 'Staff PIN', 'warn', `BOOTH_STAFF_PIN is the public demo default (${DEFAULT_STAFF_PIN}).`, 'Choose a different PIN for this event.');
    else if (pin.length < 4) add('pin', 'Staff PIN', 'warn', 'The staff PIN is shorter than 4 characters.', 'Use at least 4 characters.');
    else add('pin', 'Staff PIN', 'ok', 'A custom staff PIN is set in this terminal (not shown).');
  }

  // AI mode
  {
    const mode = env.ASSISTANT_LLM === 'off' ? 'off' : 'auto';
    const key = Boolean(env.ANTHROPIC_API_KEY);
    if (mode === 'off') add('assistant', 'AI explainer mode', 'info', 'ASSISTANT_LLM=off: grounded answers only, fully offline. This is the recommended setting for a booth without internet.');
    else if (key) add('assistant', 'AI explainer mode', 'info', 'ASSISTANT_LLM=auto with an API key: Claude phrases answers only while the internet works; otherwise grounded answers are served (every number is checked either way).', 'For a booth with no or flaky internet, start with: npm start -- --llm off');
    else add('assistant', 'AI explainer mode', 'info', 'ASSISTANT_LLM=auto without credentials: answers are grounded (no network use).', 'To make that explicit, start with: npm start -- --llm off');
  }

  // Docker, network (information only)
  {
    const d = await p.dockerVersion();
    add('docker', 'Docker', 'info', d ? `${d}. Not needed for the booth.` : 'Docker not found. Not needed for the booth.');
    add('network', 'Network', 'info', 'The booth needs no internet. For the final rehearsal turn Wi-Fi off and check that everything still works.');
  }

  const manual = [
    'Display: set the big screen to its native resolution (4K 3840x2160 or 1080p 1920x1080), scaling 100%, and open http://127.0.0.1:7072/#/stage full screen (F11).',
    'Touch screen: with the kiosk open (http://127.0.0.1:7072/#/kiosk), tap every button once and type in a field; the on-screen keyboard must appear.',
    'Power: laptop on mains, sleep and screen-off set to Never, notifications off (Do not disturb), screen saver off.',
    'Projector / second display: plug it in, confirm it extends (not mirrors) the desktop, then unplug and replug it once.',
    'Sound: muted, unless you plan to play audio.',
    'Browser: one window per screen, zoom 100%, pop-ups and password-save prompts off, bookmarks bar hidden.',
  ];

  const result: PreflightResult = { checks, ok: !checks.some((c) => c.status === 'fail'), manual };
  if (options.hotSpare) result.hotSpare = hotSpareCommands(root, dataDir, options.sparePath, p.platform());
  return result;
}

/** Exact commands to prepare a second laptop. Printed, never run. */
export function hotSpareCommands(root: string, dataDir: string, sparePath: string | undefined, platform: NodeJS.Platform): string[] {
  const rel = path.relative(root, dataDir) || '.data';
  const target = sparePath ?? '<DRIVE>:\\fintech-spare';
  const out: string[] = [
    'HOT SPARE: a second laptop that can take over within two minutes.',
    '',
    'Why: if this laptop dies, the spare must show the same booth. Prepare it the day before, while it has internet.',
    '',
    '1. On the spare laptop (needs internet once): install Node 24 and check "node -v".',
    '',
    '2. Copy the project WITHOUT node_modules and WITHOUT the data folder. Use a USB drive or SSD (the spare has no network at the booth).',
    '   Stop the Control Tower on this laptop first (Ctrl+C), so no file is half-written.',
    platform === 'win32' ? '   PowerShell on this laptop:' : '   Terminal on this laptop:',
    platform === 'win32'
      ? `     robocopy "${root}" "${target}" /MIR /XD node_modules .git ${rel.replace(/\//g, '\\')} /XF *.log /NFL /NDL`
      : `     rsync -a --delete --exclude node_modules --exclude .git --exclude ${rel} --exclude '*.log' "${root}/" "${target}/"`,
    '',
    '3. Copy the recorded backup runs (safe mode needs them):',
    platform === 'win32'
      ? `     robocopy "${path.join(dataDir, 'recordings')}" "${target}\\${rel.replace(/\//g, '\\')}\\recordings" /E`
      : `     rsync -a "${path.join(dataDir, 'recordings')}/" "${target}/${rel}/recordings/"`,
    '',
    '4. Visitor leads: do NOT copy them unless the team has decided the spare may hold personal data.',
    '   If you do want them on the spare, stop the Control Tower first (the lead database must not be open), then:',
    platform === 'win32'
      ? `     robocopy "${path.join(dataDir, 'booth')}" "${target}\\${rel.replace(/\//g, '\\')}\\booth" /E`
      : `     rsync -a "${path.join(dataDir, 'booth')}/" "${target}/${rel}/booth/"`,
    '   Then the spare is a second place where visitor data lives: export and erase it with the same routine (docs/booth/staff-lead-handling.md).',
    '',
    '5. On the spare laptop, in the copied folder (internet needed for this step only):',
    '     npm ci',
    '     npm run build:web',
    '',
    '6. Verify on the spare laptop (turn Wi-Fi off for the last two):',
    '     npm run booth:preflight',
    '     npm run verify:copy',
    '     npm start -- --llm off          then open http://127.0.0.1:7072/#/stage and /#/kiosk and send one test payment',
    '     (Ctrl+C) npm run booth:replay -- --name <recording name>     the recorded run must play; Ctrl+C to stop',
    '',
    '7. Label the spare "SPARE", keep it charged, and rehearse the swap once: stop the main laptop, move the display cable, npm start on the spare.',
  ];
  return out;
}

// ------------------------------------------------------------------------------------------------ CLI

const TAG: Record<CheckStatus, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', info: '[INFO]' };

export function formatPreflight(r: PreflightResult): string {
  const lines: string[] = ['Booth preflight for this laptop', ''];
  for (const c of r.checks) {
    lines.push(`${TAG[c.status]} ${c.title}: ${c.message}`);
    if (c.fix && c.status !== 'ok') lines.push(`       fix: ${c.fix}`);
  }
  const n = (s: CheckStatus) => r.checks.filter((c) => c.status === s).length;
  lines.push('', `${n('ok')} ok, ${n('warn')} warning(s), ${n('fail')} failure(s), ${n('info')} for information.`);
  lines.push(r.ok ? (n('warn') ? 'READY, but read the warnings above.' : 'READY.') : 'NOT READY: fix the failures above and run this check again.');
  lines.push('', 'Check by hand (a program cannot see these):');
  r.manual.forEach((m, i) => lines.push(`  ${i + 1}. [ ] ${m}`));
  if (r.hotSpare) lines.push('', ...r.hotSpare);
  return lines.join('\n');
}

export const PREFLIGHT_USAGE = `Usage: npm run booth:preflight [-- options]

Checks that this laptop is ready to run the booth: Node, installed dependencies, built screens, free ports,
disk, memory, clock, data folder, recorded backup run, staff PIN, AI mode. Starts nothing.
Exit code 1 when a check fails; warnings do not fail.

Options:
  --hot-spare           Also print the exact commands to prepare a second (spare) laptop
  --spare-path <dir>    Where the spare's copy will live (fills in the hot-spare commands)
  --ports <list>        Ports that must be free, e.g. 7070-7079 (default) or 7070,7072,7077
  --data-dir <dir>      Data folder (env DATA_DIR, default .data)
  --json                Print the result as JSON
  -h, --help            Show this help
`;

async function main(argv: readonly string[]): Promise<number> {
  const opts: PreflightOptions = {};
  let json = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const next = () => {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
        return v;
      };
      if (a === '-h' || a === '--help') {
        process.stdout.write(PREFLIGHT_USAGE);
        return 0;
      } else if (a === '--hot-spare') opts.hotSpare = true;
      else if (a === '--spare-path') opts.sparePath = next();
      else if (a === '--ports') opts.ports = parsePorts(next());
      else if (a === '--data-dir') opts.dataDir = next();
      else if (a === '--json') json = true;
      else throw new Error(`Unknown option "${a}". Run "npm run booth:preflight -- --help".`);
    }
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const r = await runPreflight(opts);
  console.log(json ? JSON.stringify(r, null, 2) : formatPreflight(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
