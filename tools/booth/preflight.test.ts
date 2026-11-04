import { describe, expect, it } from 'vitest';
import { formatPreflight, hotSpareCommands, parsePorts, runPreflight, type PreflightProbes } from './preflight';

const ROOT = '/repo';
/** Windows resolves '/repo' to 'C:\repo'; compare paths in one neutral form. */
const n = (p: string) => p.split(String.fromCharCode(92)).join('/').replace(/^[A-Za-z]:/, '');
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const GB = 1024 ** 3;

/** Probes describing a healthy laptop; each test overrides one thing. */
function healthy(over: Partial<PreflightProbes> = {}, files: Record<string, string | null> = {}): Partial<PreflightProbes> {
  const present = new Set<string>([
    '/repo/node_modules/@ct/contracts',
    '/repo/node_modules/@anthropic-ai/sdk/package.json',
    '/repo/node_modules/tsx/package.json',
    '/repo/node_modules/vite/package.json',
    '/repo/node_modules/react/package.json',
    '/repo/.data/recordings/backup.jsonl',
  ]);
  return {
    nodeVersion: () => 'v24.1.0',
    platform: () => 'linux',
    exists: (p) => present.has(n(p)),
    readText: (p) => (n(p) === '/repo/.nvmrc' ? '24' : n(p) === '/repo/packages/contracts/package.json' ? '{"name":"@ct/contracts"}' : (files[n(p)] ?? null)),
    listDir: (p) => (n(p) === '/repo/packages' ? ['contracts'] : n(p) === '/repo/.data/recordings' ? ['backup.meta.json', 'backup.jsonl'] : []),
    dirSize: () => 5 * 1024 ** 2,
    newestMtime: () => NOW - 86_400_000,
    mtime: () => NOW - 3_600_000,
    busyPorts: async () => [],
    diskFreeBytes: async () => 50 * GB,
    freeMemBytes: () => 6 * GB,
    totalMemBytes: () => 16 * GB,
    nowMs: () => NOW,
    canWrite: () => true,
    dockerVersion: async () => null,
    ...over,
  };
}
const run = (probes: Partial<PreflightProbes>, env: Record<string, string> = { BOOTH_STAFF_PIN: '7391' }, extra = {}) =>
  runPreflight({ rootDir: ROOT, dataDir: '.data', env, probes, ...extra });
const get = (r: Awaited<ReturnType<typeof run>>, id: string) => r.checks.find((c) => c.id === id)!;

describe('runPreflight', () => {
  it('passes on a healthy laptop with no warnings', async () => {
    const r = await run(healthy());
    expect(r.ok).toBe(true);
    expect(r.checks.filter((c) => c.status === 'warn' || c.status === 'fail')).toEqual([]);
    expect(r.manual.length).toBeGreaterThan(3);
    expect(formatPreflight(r)).toMatch(/READY\./);
  });

  it('fails on old Node, with a fix', async () => {
    const c = get(await run(healthy({ nodeVersion: () => 'v20.11.0' })), 'node');
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/Install Node/);
  });

  it('fails when workspace links or the Anthropic SDK are missing', async () => {
    const base = healthy();
    const r = await run({ ...base, exists: (p) => base.exists!(p) && !p.includes('@anthropic-ai') && !p.includes('@ct') });
    const c = get(r, 'deps');
    expect(c.status).toBe('fail');
    expect(c.message).toContain('@ct/contracts');
    expect(c.message).toContain('@anthropic-ai/sdk');
    expect(r.ok).toBe(false);
  });

  it('fails when the UI is not built, warns when it is older than the sources', async () => {
    expect(get(await run(healthy({ mtime: () => null })), 'web-dist').status).toBe('fail');
    const stale = get(await run(healthy({ mtime: () => NOW - 7_200_000, newestMtime: () => NOW - 60_000 })), 'web-dist');
    expect(stale.status).toBe('warn');
    expect(stale.fix).toMatch(/build:web/);
  });

  it('fails and names busy ports', async () => {
    const c = get(await run(healthy({ busyPorts: async (ports) => ports.filter((p) => p === 7072 || p === 7077) })), 'ports');
    expect(c).toMatchObject({ status: 'fail' });
    expect(c.message).toContain('7072, 7077');
  });

  it('checks only the ports it is given', async () => {
    let asked: number[] = [];
    await runPreflight({ rootDir: ROOT, env: {}, ports: parsePorts('7170-7172,7179'), probes: healthy({ busyPorts: async (p) => ((asked = p), []) }) });
    expect(asked).toEqual([7170, 7171, 7172, 7179]);
  });

  it('thresholds: disk below 2 GB fails; memory below 1 GB fails, below 2 GB warns', async () => {
    expect(get(await run(healthy({ diskFreeBytes: async () => 1.5 * GB })), 'disk').status).toBe('fail');
    expect(get(await run(healthy({ diskFreeBytes: async () => null })), 'disk').status).toBe('warn');
    expect(get(await run(healthy({ freeMemBytes: () => 0.5 * GB })), 'memory').status).toBe('fail');
    expect(get(await run(healthy({ freeMemBytes: () => 1.5 * GB })), 'memory').status).toBe('warn');
  });

  it('warns about a clock far from the project files', async () => {
    expect(get(await run(healthy({ newestMtime: () => NOW + 30 * 86_400_000 })), 'clock').status).toBe('warn');
    expect(get(await run(healthy({ newestMtime: () => NOW - 6 * 365 * 86_400_000 })), 'clock').status).toBe('warn');
  });

  it('fails when the data folder is not writable', async () => {
    expect(get(await run(healthy({ canWrite: () => false })), 'data-dir').status).toBe('fail');
  });

  it('warns about leftover leads and about missing recordings', async () => {
    const base = healthy();
    const leads = get(await run({ ...base, exists: (p) => n(p) === '/repo/.data/booth' || base.exists!(p) }), 'leads');
    expect(leads.status).toBe('warn');
    expect(leads.fix).toMatch(/export-leads/);
    const none = get(await run(healthy({ listDir: () => [] })), 'recordings');
    expect(none.status).toBe('warn');
    expect(none.fix).toMatch(/booth:record/);
  });

  it('warns about the default or missing staff PIN and never prints a custom one', async () => {
    expect(get(await run(healthy(), {}), 'pin').status).toBe('warn');
    expect(get(await run(healthy(), { BOOTH_STAFF_PIN: '2468' }), 'pin').status).toBe('warn');
    const r = await run(healthy(), { BOOTH_STAFF_PIN: '7391' });
    expect(get(r, 'pin').status).toBe('ok');
    expect(JSON.stringify(r)).not.toContain('7391');
  });

  it('shows the AI mode and Docker as information only', async () => {
    expect(get(await run(healthy(), { ASSISTANT_LLM: 'off', BOOTH_STAFF_PIN: '7391' }), 'assistant').message).toMatch(/offline/);
    const r = await run(healthy({ dockerVersion: async () => 'Docker version 29' }));
    expect(get(r, 'docker').status).toBe('info');
    expect(get(r, 'network').status).toBe('info');
  });

  it('prints hot-spare commands only when asked, with the real paths', async () => {
    expect((await run(healthy())).hotSpare).toBeUndefined();
    const r = await run(healthy(), undefined, { hotSpare: true, sparePath: 'E:\\spare' });
    const text = r.hotSpare!.join('\n');
    expect(text).toContain('rsync');
    expect(n(text)).toContain('/repo/.data/recordings');
    expect(text).toContain('npm ci');
    expect(text).toContain('booth:replay');
    expect(formatPreflight(r)).toContain('HOT SPARE');
  });
});

describe('helpers', () => {
  it('parses port lists', () => {
    expect(parsePorts('7070-7072,7077')).toEqual([7070, 7071, 7072, 7077]);
    expect(() => parsePorts('abc')).toThrow(/not a port/);
    expect(() => parsePorts('9-1')).toThrow();
  });
  it('uses robocopy on Windows', () => {
    const t = hotSpareCommands('C:\\fintech', 'C:\\fintech\\.data', 'E:\\spare', 'win32').join('\n');
    expect(t).toMatch(/robocopy "C:\\fintech" "E:\\spare" \/MIR/);
    expect(t).toContain('recordings');
  });
});
