// `npm run booth:clear-leads` - deliberately delete the booth's visitor leads and anonymous analytics
// (DATA_DIR/booth). A demo reset never touches them (control.ts PRESERVED_DATA_ENTRIES), so this is the
// only way to clear them short of deleting the folder by hand. Asks for confirmation unless --yes.
// Refuses while the booth service is running (its database files are open).
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { serviceConfig } from '@ct/contracts';
import { assertSafeToDelete } from './control';
import { DEFAULT_ROOT_DIR } from './launch';
import { isPortFree } from './ports';

export const CLEAR_LEADS_USAGE = `Usage: npm run booth:clear-leads [-- options]

Deletes every visitor lead and the anonymous booth analytics stored on this machine (DATA_DIR/booth).
This cannot be undone. Export the leads first if you need them (presenter console, or
GET /api/booth/leads/export.csv with header X-Booth-Staff: <PIN>). Stop the Control Tower first.

Options:
  --data-dir <dir>   Data directory (env DATA_DIR, default .data)
  --booth-port <n>   Port checked to make sure the booth is stopped (env BOOTH_PORT, default 7077)
  --yes              Do not ask for confirmation
  -h, --help         Show this help
`;

export interface ClearLeadsArgs {
  help: boolean;
  yes: boolean;
  dataDir: string;
  boothPort: number;
}

export function parseClearLeadsArgs(argv: readonly string[], defaults = serviceConfig()): ClearLeadsArgs {
  const args: ClearLeadsArgs = { help: false, yes: false, dataDir: defaults.dataDir, boothPort: defaults.boothPort ?? 7077 };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const next = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--data-dir': {
        const v = next();
        if (!v || v.startsWith('--')) throw new Error('--data-dir needs a value');
        args.dataDir = v;
        break;
      }
      case '--booth-port': {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--booth-port must be a port, got "${v ?? ''}"`);
        args.boothPort = n;
        break;
      }
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run booth:clear-leads -- --help" for usage.`);
    }
  }
  return args;
}

/** The directory that would be deleted (DATA_DIR/booth), checked against the repo-root safety rule. */
export function boothDataDir(dataDir: string, rootDir = DEFAULT_ROOT_DIR): string {
  const dir = path.resolve(rootDir, dataDir, 'booth');
  assertSafeToDelete(dir, rootDir);
  return dir;
}

/** Delete the booth data directory. Returns false when there was nothing to delete. */
export function clearBoothData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  return true;
}

async function main(): Promise<number> {
  let args: ClearLeadsArgs;
  try {
    args = parseClearLeadsArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(CLEAR_LEADS_USAGE);
    return 0;
  }
  const dir = boothDataDir(args.dataDir);
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    console.log(`No booth data at ${dir} - nothing to clear.`);
    return 0;
  }
  if (!(await isPortFree(args.boothPort))) {
    console.error(
      `The booth service still answers on port ${args.boothPort}: stop the Control Tower (Ctrl+C in its window) first, ` +
        'then run npm run booth:clear-leads again.',
    );
    return 1;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error('Refusing to delete visitor leads without confirmation: run it in a terminal, or pass --yes.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `This permanently deletes ALL visitor leads and booth analytics in\n  ${dir}\nExport them first if you need them. Type DELETE to confirm: `,
    );
    rl.close();
    if (answer.trim() !== 'DELETE') {
      console.log('Not confirmed - nothing was deleted.');
      return 1;
    }
  }
  clearBoothData(dir);
  console.log(`Deleted ${dir}. Visitor leads and booth analytics are gone.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
