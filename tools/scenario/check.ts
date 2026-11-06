// `npm run scenario:check [-- <pack files...>] [--trace]`
// Validates scenario packs (structure, copy policy ADR 0018, no TODO markers, orchestrator script rules) and dry-runs
// each one twice to prove the result is deterministic. With no files it checks the active and example packs folders.
// Exit code 1 when any pack has a problem or a machine-checkable expectation fails.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dryRun, formatDryRun, validatePack, packFiles, ACTIVE_PACKS_DIR, EXAMPLE_PACKS_DIR, PACK_FILE_SUFFIX, type DryRunReport } from '../../services/orchestrator/src/packs';

export interface CheckResult {
  file: string;
  ok: boolean;
  errors: string[];
  report?: DryRunReport;
}

export function checkPackFile(file: string): CheckResult {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, ok: false, errors: [`cannot read pack: ${(e as Error).message}`] };
  }
  const v = validatePack(json);
  const errors = [...v.errors];
  if (v.pack && path.basename(file) !== `${v.pack.name}${PACK_FILE_SUFFIX}`) errors.push(`pack.name "${v.pack.name}" must match the file name "${path.basename(file)}"`);
  if (!v.pack || !v.script) return { file, ok: false, errors };

  const first = dryRun(v.pack, v.script);
  // Determinism: rebuild everything from the file again and compare digests.
  const again = validatePack(JSON.parse(readFileSync(file, 'utf8')));
  const second = again.pack && again.script ? dryRun(again.pack, again.script) : undefined;
  if (!second || second.digest !== first.digest) errors.push('dry run is not deterministic: two runs of the same pack gave different results');
  for (const x of first.expectations) if (x.status === 'fail') errors.push(`expected outcome "${x.id}" fails in the dry run: ${x.detail}`);
  return { file, ok: errors.length === 0, errors, report: first };
}

export function formatCheck(r: CheckResult, trace: boolean): string {
  const name = path.basename(r.file);
  const lines: string[] = [];
  if (r.ok) {
    const t = r.report!.totals;
    const manual = r.report!.expectations.filter((x) => x.status === 'manual').length;
    lines.push(`PASS ${name}  ${t.steps} steps, ${t.payments} crafted payments, digest ${r.report!.digest}; ${r.report!.expectations.length - manual} expectation(s) checked, ${manual} for a person to confirm in rehearsal`);
  } else {
    lines.push(`FAIL ${name}`);
    for (const e of r.errors) lines.push(`  - ${e}`);
  }
  if (trace && r.report) lines.push(formatDryRun(r.report));
  return lines.join('\n');
}

export const CHECK_USAGE = `Usage: npm run scenario:check [-- <pack files...>] [--trace]

  With no files, checks every *.pack.json in the active packs folder and the examples folder.
  --trace   print the full dry run (every step, control event and crafted payment)
`;

export function runCheck(argv: readonly string[], out: (line: string) => void = console.log): number {
  const files: string[] = [];
  let trace = false;
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      out(CHECK_USAGE);
      return 0;
    }
    if (a === '--trace') trace = true;
    else if (a.startsWith('-')) {
      out(`Unknown option "${a}".\n${CHECK_USAGE}`);
      return 2;
    } else files.push(path.resolve(a));
  }
  const targets = files.length ? files : [...packFiles(ACTIVE_PACKS_DIR), ...packFiles(EXAMPLE_PACKS_DIR)];
  for (const f of targets) {
    if (!existsSync(f)) {
      out(`FAIL ${f}\n  - file not found`);
      return 1;
    }
  }
  let failed = 0;
  for (const f of targets) {
    const r = checkPackFile(f);
    if (!r.ok) failed++;
    out(formatCheck(r, trace));
  }
  out(targets.length === 0 ? 'No scenario packs found.' : `${targets.length - failed} of ${targets.length} pack(s) passed.`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(runCheck(process.argv.slice(2)));
}
