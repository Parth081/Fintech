import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boothDataDir, clearBoothData, parseClearLeadsArgs } from './clear-leads';

const defaults = { dataDir: '.data', boothPort: 7077 } as unknown as Parameters<typeof parseClearLeadsArgs>[1];
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('booth:clear-leads', () => {
  it('parses its options and asks for confirmation by default', () => {
    expect(parseClearLeadsArgs([], defaults)).toEqual({ help: false, yes: false, dataDir: '.data', boothPort: 7077 });
    expect(parseClearLeadsArgs(['--yes', '--data-dir=x', '--booth-port', '9077'], defaults)).toEqual({ help: false, yes: true, dataDir: 'x', boothPort: 9077 });
    expect(() => parseClearLeadsArgs(['--nope'], defaults)).toThrow(/Unknown option/);
    expect(() => parseClearLeadsArgs(['--booth-port', 'x'], defaults)).toThrow(/port/);
  });

  it('deletes only DATA_DIR/booth', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ct-clear-leads-'));
    tmp.push(root);
    mkdirSync(path.join(root, '.data', 'booth'), { recursive: true });
    mkdirSync(path.join(root, '.data', 'ledger'), { recursive: true });
    writeFileSync(path.join(root, '.data', 'booth', 'pg'), 'x');
    const dir = boothDataDir('.data', root);
    expect(dir).toBe(path.join(root, '.data', 'booth'));
    expect(clearBoothData(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(root, '.data', 'ledger'))).toBe(true);
    expect(clearBoothData(dir)).toBe(false);
  });
});
