// M6: the dress rehearsal itself, quick path, run once as a child process (it launches its own system on
// ports 38070-38079, so it must not run in parallel with another verify:m6).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('M6 dress rehearsal (quick)', () => {
  it('verify:m6 --quick passes Gate 3 (software part)', async () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'ct-e2e-m6-'));
    try {
      const out: string[] = [];
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'tools/verify/m6.ts', '--quick', '--report-dir', reportDir], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => out.push(String(d)));
        child.stderr.on('data', (d: Buffer) => out.push(String(d)));
        child.on('exit', resolve);
      });
      const report = JSON.parse(readFileSync(join(reportDir, readdirSync(reportDir).find((f) => f.endsWith('.json'))!), 'utf8')) as { ok: boolean; checks: { id: string; ok: boolean; detail: string }[] };
      const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
      expect(failed, out.join('').slice(-3000)).toEqual([]);
      expect(code).toBe(0);
      expect(report.ok).toBe(true);
    } finally {
      rmSync(reportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 540_000);
});
