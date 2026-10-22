// Child-process helpers: spawn a TypeScript entrypoint via the local tsx loader, stream its output
// line by line, and kill a whole process tree (Windows: taskkill /T /F, elsewhere: process group).
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const IS_WIN = process.platform === 'win32';

/** file:// URL of the local tsx ESM loader (node_modules/tsx), for `node --import <url> file.ts`. */
export function tsxLoaderUrl(rootDir: string): string {
  const req = createRequire(path.join(rootDir, 'package.json'));
  return pathToFileURL(req.resolve('tsx')).href;
}

export interface SpawnTsOptions {
  rootDir: string;
  script: string; // relative to rootDir
  args?: string[];
  env: NodeJS.ProcessEnv;
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Runs `node --import tsx <script>` directly with process.execPath: one node process per service,
 * no shell, so paths with spaces need no quoting and there is no intermediate tsx wrapper process.
 */
export function spawnTs(opts: SpawnTsOptions): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoaderUrl(opts.rootDir), path.join(opts.rootDir, opts.script), ...(opts.args ?? [])],
    {
      cwd: opts.rootDir,
      env: opts.env,
      // stdin is a pipe so the child exits when the launcher dies (see exitWithSupervisor)
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so we can signal the whole tree (and Ctrl+C reaches only us).
      detached: !IS_WIN,
    },
  );
  pipeLines(child, opts.onLine);
  return child;
}

/** Runs a shell command (used for `npm run build:web`; npm is a .cmd on Windows, so it needs a shell). */
export function spawnShell(
  command: string,
  rootDir: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): ChildProcess {
  const child = spawn(command, {
    cwd: rootDir,
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !IS_WIN,
  });
  pipeLines(child, onLine);
  return child;
}

function pipeLines(child: ChildProcess, onLine: (line: string, stream: 'stdout' | 'stderr') => void): void {
  if (child.stdout) createInterface({ input: child.stdout }).on('line', (l) => onLine(l, 'stdout'));
  if (child.stderr) createInterface({ input: child.stderr }).on('line', (l) => onLine(l, 'stderr'));
}

export function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Resolves when the child has exited (immediately if it already has). */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    tk.once('error', () => resolve());
    tk.once('exit', () => resolve());
  });
}

/**
 * Kill a child and all of its descendants. Windows: taskkill /T /F (tree, forced).
 * Elsewhere: SIGTERM to the process group, SIGKILL after `graceMs`.
 */
export async function killTree(child: ChildProcess, graceMs = 3000): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WIN) {
    // Even if the direct child already exited, run taskkill: grandchildren may still be alive.
    await runTaskkill(pid);
    if (!(await waitForExit(child, graceMs))) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      await waitForExit(child, 1000);
    }
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup('SIGTERM');
  if (!(await waitForExit(child, graceMs))) {
    signalGroup('SIGKILL');
    await waitForExit(child, 1000);
  } else {
    // Leader is gone; make sure nothing else in the group survives.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group already empty */
    }
  }
}
