// `npm run booth:export-leads` - the staff routine at the end of every booth day.
//
//   npm run booth:export-leads -- [--out leads-<date>.csv] [--pin <PIN> | env BOOTH_STAFF_PIN]
//                                 [--url http://127.0.0.1:7072] [--force] [--erase]
//
// Downloads the visitor leads as CSV from the running booth (through the gateway, /api/booth/leads/export.csv),
// saves them with user-only permissions where the OS supports it, prints how many there are and the anonymous
// booth summary, and - only with --erase and a typed confirmation - deletes exactly the exported leads from the booth.
// Never prints the PIN or any lead field. Refuses to write anything when the booth cannot be reached or the PIN is wrong.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import type { BoothSummary } from '@ct/contracts';

export const EXPORT_USAGE = `Usage: npm run booth:export-leads -- [options]

End-of-day routine: saves the visitor leads from the running booth to a CSV file and shows the booth summary.
The booth must be running (npm start). The CSV contains personal data: keep it off shared drives and out of git.

Options:
  --out <file>     Where to write the CSV (default leads-<YYYY-MM-DD>.csv in the current folder)
  --pin <PIN>      Staff PIN (better: set env BOOTH_STAFF_PIN, so the PIN is not in your shell history)
  --url <url>      Gateway address (default http://127.0.0.1:7072)
  --force          Overwrite the output file if it already exists
  --erase          After saving, delete the exported leads from the booth (asks you to type DELETE)
  -h, --help       Show this help

Exit codes: 0 done, 1 refused or failed (nothing was written, or nothing was erased), 2 bad options.
`;

export interface ExportArgs {
  help: boolean;
  out: string | null;
  pin: string | null;
  url: string;
  force: boolean;
  erase: boolean;
}

export const DEFAULT_URL = 'http://127.0.0.1:7072';

export function parseExportArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): ExportArgs {
  const args: ExportArgs = { help: false, out: null, pin: env.BOOTH_STAFF_PIN ? env.BOOTH_STAFF_PIN : null, url: env.GATEWAY_URL || DEFAULT_URL, force: false, erase: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v === '' || (inline === undefined && v.startsWith('--'))) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--out':
        args.out = value();
        break;
      case '--pin':
        args.pin = value();
        break;
      case '--url':
        args.url = value();
        break;
      case '--force':
        args.force = true;
        break;
      case '--erase':
        args.erase = true;
        break;
      default:
        throw new Error(`Unknown option "${raw}". Run "npm run booth:export-leads -- --help" for usage.`);
    }
  }
  if (!/^https?:\/\//i.test(args.url)) throw new Error(`--url must start with http:// or https://, got "${args.url}"`);
  return args;
}

// ------------------------------------------------------------------------------------------------ CSV helpers

/** Minimal RFC 4180 reader (quotes, doubled quotes, CRLF inside quoted cells, leading BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Lead ids (header column "id") in an export. Throws when the file is not a lead export. */
export function leadIdsFromCsv(csv: string): string[] {
  const rows = parseCsv(csv);
  const header = rows[0];
  const idCol = header?.indexOf('id') ?? -1;
  if (!header || idCol < 0 || !header.includes('email')) throw new Error('the booth answered, but not with a lead export (no "id" and "email" columns)');
  return rows.slice(1).map((r) => r[idCol] ?? '').filter((id) => id !== '');
}

// ------------------------------------------------------------------------------------------------ export

export interface ExportOptions {
  url?: string;
  pin?: string | null;
  /** Output file; default leads-<date>.csv in `cwd`. */
  out?: string | null;
  force?: boolean;
  erase?: boolean;
  /** Typed confirmation for --erase. Must resolve to the text the user typed. Default: ask in the terminal (refuses without a TTY). */
  confirm?: (question: string) => Promise<string>;
  /** Progress and result lines. Default console.log. Never receives the PIN or lead fields. */
  log?: (line: string) => void;
  now?: () => Date;
  cwd?: string;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
}

export interface ExportResult {
  ok: boolean;
  exitCode: 0 | 1;
  /** Number of leads in the saved file. */
  count: number;
  file: string | null;
  erased: number;
  summary: BoothSummary | null;
  /** The same lines that were logged. */
  messages: string[];
}

class Refusal extends Error {}

export function defaultOutName(now: Date): string {
  return `leads-${now.toISOString().slice(0, 10)}.csv`;
}

async function call(base: string, method: string, route: string, pin: string, timeoutMs: number): Promise<Response> {
  const target = `${base.replace(/\/+$/, '')}/api/booth${route}`;
  try {
    return await fetch(target, { method, headers: { 'X-Booth-Staff': pin }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if ((err as Error).name === 'TimeoutError') throw new Refusal(`The booth did not answer within ${Math.round(timeoutMs / 1000)} s at ${base}. Nothing was written.`);
    throw new Refusal(
      `Cannot reach the booth at ${base}${code ? ` (${code})` : ''}. Is the Control Tower running (npm start) and is the address right? Nothing was written.`,
    );
  }
}

/** Turns a bad HTTP status into a plain-English refusal. Never includes the PIN. */
function refuseOnStatus(res: Response, what: string): void {
  if (res.ok) return;
  if (res.status === 401) throw new Refusal('The staff PIN was not accepted. Check BOOTH_STAFF_PIN for this event (the demo default 2468 should have been changed). Nothing was written.');
  if (res.status === 403) throw new Refusal('The booth has staff access switched off (it was started without a staff PIN). Nothing was written.');
  if (res.status === 429) throw new Refusal('Too many wrong PINs were tried. Wait one minute and try again. Nothing was written.');
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Refusal(`The booth service is down or restarting (the gateway answered ${res.status}). Wait a few seconds, check the system is running, and try again. Nothing was written.`);
  if (res.status === 404) throw new Refusal(`The booth does not know ${what} - is --url the gateway (http://127.0.0.1:7072)? Nothing was written.`);
  throw new Refusal(`The booth refused ${what} (HTTP ${res.status}). Nothing was written.`);
}

function repoWarning(file: string, cwd: string): string | null {
  // The export is personal data. If it lands inside this repository, make sure git cannot pick it up by accident.
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, '.git'))) {
      const ignored = existsSync(path.join(dir, '.gitignore')) && /csv/i.test(readFileSync(path.join(dir, '.gitignore'), 'utf8'));
      if (ignored) return null;
      return `WARNING: ${path.relative(cwd, file) || file} is inside a git repository. It contains personal data: do not commit it. Move it to your user folder or an encrypted drive.`;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export async function exportLeads(opts: ExportOptions = {}): Promise<ExportResult> {
  const messages: string[] = [];
  const out = opts.log ?? ((l: string) => console.log(l));
  const say = (l: string) => {
    messages.push(l);
    out(l);
  };
  const result: ExportResult = { ok: false, exitCode: 1, count: 0, file: null, erased: 0, summary: null, messages };
  const base = opts.url ?? DEFAULT_URL;
  const now = opts.now ?? (() => new Date());
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const pin = opts.pin ?? '';
    if (!pin) throw new Refusal('No staff PIN. Set the environment variable BOOTH_STAFF_PIN (best) or pass --pin <PIN>. Nothing was written.');
    const file = path.resolve(cwd, opts.out ?? defaultOutName(now()));
    if (existsSync(file) && !opts.force) {
      throw new Refusal(`${file} already exists. Choose another name with --out, or add --force to overwrite it. Nothing was written.`);
    }
    if (existsSync(file) && statSync(file).isDirectory()) throw new Refusal(`${file} is a folder. Choose a file name with --out.`);

    // 1. The CSV. Nothing is written before the booth has answered with a real export.
    const csvRes = await call(base, 'GET', '/leads/export.csv', pin, timeoutMs);
    refuseOnStatus(csvRes, 'the lead export');
    const buf = Buffer.from(await csvRes.arrayBuffer());
    const ids = leadIdsFromCsv(buf.toString('utf8'));

    // 2. Write it, readable by this user only (POSIX; Windows ignores modes and uses the folder's permissions).
    writeFileSync(file, buf, { mode: 0o600, flag: opts.force ? 'w' : 'wx' });
    let modeNote = '';
    try {
      chmodSync(file, 0o600);
      if (process.platform === 'win32') modeNote = ' (Windows: access follows the folder permissions - keep it in your user folder)';
    } catch {
      modeNote = ' (could not restrict file permissions on this system)';
    }
    result.file = file;
    result.count = ids.length;
    say(`Saved ${ids.length} lead${ids.length === 1 ? '' : 's'} to ${file}${modeNote}`);
    const warn = repoWarning(file, cwd);
    if (warn) say(warn);

    // 3. The anonymous summary. Failing here does not undo the export.
    try {
      const sres = await call(base, 'GET', '/summary', pin, timeoutMs);
      if (sres.ok) {
        const s = (await sres.json()) as BoothSummary;
        result.summary = s;
        say(`Booth summary: ${s.visits} visits, ${s.leads} leads, average ${Math.round(s.avgDwellSeconds)} s at the kiosk.`);
        if (s.topScenarios.length) say(`  Top scenarios: ${s.topScenarios.slice(0, 5).map((x) => `${x.scenarioId} (${x.views})`).join(', ')}`);
        if (s.topQuestions.length) say(`  Top questions: ${s.topQuestions.slice(0, 5).map((x) => `"${x.text}" (${x.count})`).join('; ')}`);
      } else say(`(The booth summary was not available: HTTP ${sres.status}. The export itself is complete.)`);
    } catch {
      say('(The booth summary was not available. The export itself is complete.)');
    }

    // 4. Erase exactly what was exported, after a typed confirmation.
    if (opts.erase) {
      if (ids.length === 0) say('Nothing to erase.');
      else {
        const confirm =
          opts.confirm ??
          (process.stdin.isTTY
            ? async (q: string) => {
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                try {
                  return await rl.question(q);
                } finally {
                  rl.close();
                }
              }
            : null);
        if (!confirm) {
          say('Not erased: --erase needs you to type a confirmation, so run it in a terminal. The export is saved.');
          result.exitCode = 1;
          return result;
        }
        const answer = await confirm(
          `The ${ids.length} exported lead${ids.length === 1 ? '' : 's'} will be PERMANENTLY deleted from the booth.\n` +
            `Check that ${file} opens and has all your leads first. Type DELETE to confirm: `,
        );
        if (answer.trim() !== 'DELETE') {
          say('Not confirmed - nothing was deleted. The export is saved.');
          result.exitCode = 1;
          return result;
        }
        let failed = 0;
        for (const id of ids) {
          const r = await call(base, 'DELETE', `/leads/${encodeURIComponent(id)}`, pin, timeoutMs);
          if (r.ok || r.status === 404) result.erased++; // 404: already gone
          else failed++;
        }
        say(`Erased ${result.erased} of ${ids.length} lead${ids.length === 1 ? '' : 's'} from the booth.`);
        if (failed > 0) {
          say(`${failed} could not be erased. Run the command again, or use npm run booth:clear-leads with the system stopped.`);
          result.exitCode = 1;
          return result;
        }
      }
    } else if (ids.length > 0) {
      say('The leads are still on the booth laptop. After you have checked the file, run again with --erase to delete them.');
    }
    result.ok = true;
    result.exitCode = 0;
    return result;
  } catch (err) {
    say(err instanceof Refusal ? err.message : `Export failed: ${(err as Error).message}`);
    return result;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let args: ExportArgs;
  try {
    args = parseExportArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    process.stdout.write(EXPORT_USAGE);
    return 0;
  }
  const r = await exportLeads({ url: args.url, pin: args.pin, out: args.out, force: args.force, erase: args.erase });
  return r.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error((err as Error).message);
      process.exit(1);
    },
  );
}
