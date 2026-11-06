// Scaffold and check CLIs: the starter packs for every audience are runnable drafts, the check command passes the
// examples, fails on a draft or a broken pack, and a finished scaffold passes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_PACKS_DIR, PACK_AUDIENCES, packFiles } from '../../services/orchestrator/src/packs';
import { checkPackFile, runCheck } from './check';
import { runNew } from './new';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'scn-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const capture = () => {
  const lines: string[] = [];
  return { lines, out: (l: string) => void lines.push(l) };
};

describe('scenario:new', () => {
  it.each(PACK_AUDIENCES)('scaffolds a %s pack that is valid except for its TODO markers', (audience) => {
    const dir = tmp();
    const c = capture();
    expect(runNew(['--name', `draft-${audience}`, '--audience', audience, '--dir', dir], c.out)).toBe(0);
    const file = path.join(dir, `draft-${audience}.pack.json`);
    const r = checkPackFile(file);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.every((e) => /TODO marker/.test(e))).toBe(true); // nothing else wrong: the draft dry-runs fine
    expect(r.report?.totals.payments).toBeGreaterThan(0);
    // Replace every TODO and it passes.
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('TODO:', 'Prospect story:'));
    expect(checkPackFile(file)).toMatchObject({ ok: true, errors: [] });
  });

  it('refuses bad names and audiences, and will not overwrite without --force', () => {
    const dir = tmp();
    const c = capture();
    expect(runNew(['--name', 'Bad Name', '--audience', 'psp', '--dir', dir], c.out)).toBe(2);
    expect(runNew(['--name', 'good-name', '--audience', 'retailer', '--dir', dir], c.out)).toBe(2);
    expect(runNew(['--name', 'good-name', '--audience', 'psp', '--dir', dir], c.out)).toBe(0);
    expect(runNew(['--name', 'good-name', '--audience', 'psp', '--dir', dir], c.out)).toBe(1);
    expect(runNew(['--name', 'good-name', '--audience', 'bank', '--dir', dir, '--force'], c.out)).toBe(0);
    expect(existsSync(path.join(dir, 'good-name.pack.json'))).toBe(true);
    expect(runNew(['--bogus'], c.out)).toBe(2);
  });
});

describe('scenario:check', () => {
  it('passes both example packs and says what was checked', () => {
    const c = capture();
    expect(runCheck(packFiles(EXAMPLE_PACKS_DIR), c.out)).toBe(0);
    const text = c.lines.join('\n');
    expect(text).toContain('PASS psp-acceptance-recovery.pack.json');
    expect(text).toContain('PASS bank-sanctions-backlog.pack.json');
    expect(text).toContain('2 of 2 pack(s) passed.');
  });

  it('fails a pack whose expected outcome does not hold, whose copy breaks policy, or whose name differs from the file', () => {
    const dir = tmp();
    const good = JSON.parse(readFileSync(path.join(EXAMPLE_PACKS_DIR, 'psp-acceptance-recovery.pack.json'), 'utf8'));
    const weak = { ...good, name: 'weak-pack', expected: [{ id: 'too-many', text: 'A hundred payments flow on US-IN.', check: { kind: 'payments', min: 100, corridor: 'US-IN' } }] };
    const brag = { ...good, name: 'brag-pack', description: 'A guaranteed, bank-grade platform.' };
    writeFileSync(path.join(dir, 'weak-pack.pack.json'), JSON.stringify(weak));
    writeFileSync(path.join(dir, 'brag-pack.pack.json'), JSON.stringify(brag));
    writeFileSync(path.join(dir, 'mismatch.pack.json'), JSON.stringify(good));
    expect(checkPackFile(path.join(dir, 'weak-pack.pack.json')).errors.join()).toMatch(/too-many/);
    expect(checkPackFile(path.join(dir, 'brag-pack.pack.json')).errors.join()).toMatch(/copy policy/);
    expect(checkPackFile(path.join(dir, 'mismatch.pack.json')).errors.join()).toMatch(/file name/);
    const c = capture();
    expect(runCheck([path.join(dir, 'weak-pack.pack.json')], c.out)).toBe(1);
    expect(runCheck([path.join(dir, 'missing.pack.json')], c.out)).toBe(1);
  });

  it('with no arguments checks the repository folders and passes; --trace prints the dry run', () => {
    const c = capture();
    expect(runCheck([], c.out)).toBe(0);
    const t = capture();
    expect(runCheck(['--trace', path.join(EXAMPLE_PACKS_DIR, 'bank-sanctions-backlog.pack.json')], t.out)).toBe(0);
    expect(t.lines.join('\n')).toMatch(/\[listed party\]/);
  });
});
