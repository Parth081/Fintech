import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Lead } from '@ct/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leadsToCsv } from '../../services/booth/src/csv';
import { exportLeads, leadIdsFromCsv, parseCsv, parseExportArgs } from './export-leads';

const PIN = 'secret-4821';
const lead = (n: number, over: Partial<Lead> = {}): Lead => ({
  id: `lead_${n}`,
  createdAt: '2026-10-30T10:00:00.000Z',
  name: `Visitor ${n}, "the" Third`,
  company: `Fictional Bank ${n}`,
  email: `visitor${n}@example.com`,
  interest: 'ai',
  consentText: 'We store your details on this booth laptop only, and delete them. Contact: yes',
  consentAt: '2026-10-30T10:00:00.000Z',
  engagement: { scenarios: ['provider-outage'], questions: ['Was any payment lost?'], dwellSeconds: 90 },
  ...over,
});

interface Fake {
  server: Server;
  url: string;
  leads: Lead[];
  calls: string[];
  failDelete: Set<string>;
}

async function fakeBooth(initial: Lead[], opts: { summary?: boolean } = {}): Promise<Fake> {
  const state: Fake = { server: undefined as never, url: '', leads: [...initial], calls: [], failDelete: new Set() };
  state.server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers['x-booth-staff'] !== PIN) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'staff PIN required' }));
      return;
    }
    if (url.pathname === '/api/booth/leads/export.csv') {
      res.writeHead(200, { 'content-type': 'text/csv' }).end(leadsToCsv(state.leads));
    } else if (url.pathname === '/api/booth/summary') {
      if (opts.summary === false) return void res.writeHead(500).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          visits: 12,
          avgDwellSeconds: 95.4,
          leads: state.leads.length,
          topScenarios: [{ scenarioId: 'provider-outage', views: 9 }],
          topQuestions: [{ text: 'Was any payment lost?', count: 4 }],
          byHour: [],
        }),
      );
    } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/booth/leads/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      if (state.failDelete.has(id)) return void res.writeHead(500).end('{}');
      const before = state.leads.length;
      state.leads = state.leads.filter((l) => l.id !== id);
      res.writeHead(before === state.leads.length ? 404 : 200, { 'content-type': 'application/json' }).end('{}');
    } else res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => state.server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

let dir: string;
let fakes: Fake[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ct-export-'));
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await new Promise<void>((r) => f.server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
const booth = async (leads: Lead[], o?: { summary?: boolean }) => {
  const f = await fakeBooth(leads, o);
  fakes.push(f);
  return f;
};
const base = (f: Fake) => ({ url: f.url, pin: PIN, cwd: dir, log: () => {}, now: () => new Date('2026-10-30T18:00:00Z') });

describe('parseExportArgs', () => {
  it('reads options and the PIN from the environment', () => {
    expect(parseExportArgs([], { BOOTH_STAFF_PIN: '1111' })).toMatchObject({ pin: '1111', url: 'http://127.0.0.1:7072', erase: false, out: null });
    expect(parseExportArgs(['--out=a.csv', '--pin', '9', '--url', 'http://127.0.0.1:8000', '--erase', '--force'], {})).toMatchObject({
      out: 'a.csv', pin: '9', url: 'http://127.0.0.1:8000', erase: true, force: true,
    });
    expect(() => parseExportArgs(['--nope'], {})).toThrow(/Unknown option/);
    expect(() => parseExportArgs(['--out'], {})).toThrow(/needs a value/);
    expect(() => parseExportArgs(['--url', 'ftp://x'], {})).toThrow(/http/);
  });
});

describe('csv helpers', () => {
  it('reads quoted cells, doubled quotes, embedded newlines and the BOM', () => {
    const csv = leadsToCsv([lead(1, { name: 'Line\nBreak, "Q"' }), lead(2)]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rows[1]![2]).toBe('Line\nBreak, "Q"');
    expect(leadIdsFromCsv(csv)).toEqual(['lead_1', 'lead_2']);
  });
  it('rejects a body that is not a lead export', () => {
    expect(() => leadIdsFromCsv('<html>nope</html>')).toThrow(/not with a lead export/);
  });
});

describe('exportLeads', () => {
  it('saves the CSV, prints count and summary, and never prints the PIN or lead data', async () => {
    const f = await booth([lead(1), lead(2), lead(3)]);
    const r = await exportLeads({ ...base(f), out: null });
    expect(r).toMatchObject({ ok: true, exitCode: 0, count: 3, erased: 0 });
    const file = path.join(dir, 'leads-2026-10-30.csv');
    expect(r.file).toBe(file);
    expect(readFileSync(file, 'utf8')).toContain('visitor2@example.com');
    expect(r.summary?.visits).toBe(12);
    const printed = r.messages.join('\n');
    expect(printed).toMatch(/Saved 3 leads/);
    expect(printed).toMatch(/12 visits, 3 leads/);
    expect(printed).toMatch(/provider-outage \(9\)/);
    expect(printed).toMatch(/still on the booth laptop/);
    expect(printed).not.toContain(PIN);
    expect(printed).not.toContain('visitor1@example.com');
    expect(printed).not.toContain('Fictional Bank');
    expect(f.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('refuses without writing when the PIN is wrong, and does not echo either PIN', async () => {
    const f = await booth([lead(1)]);
    const r = await exportLeads({ ...base(f), pin: 'wrong-0000', out: 'x.csv' });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(existsSync(path.join(dir, 'x.csv'))).toBe(false);
    expect(r.messages.join('\n')).toMatch(/PIN was not accepted/);
    expect(r.messages.join('\n')).not.toContain('wrong-0000');
    expect(r.messages.join('\n')).not.toContain(PIN);
  });

  it('refuses without writing when the booth is unreachable', async () => {
    const f = await booth([]);
    const url = f.url;
    await new Promise<void>((r) => f.server.close(() => r()));
    fakes = [];
    const r = await exportLeads({ ...base(f), url, out: 'x.csv', timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(dir, 'x.csv'))).toBe(false);
    expect(r.messages.join('\n')).toMatch(/Cannot reach the booth/);
  });

  it('refuses without a PIN, and refuses to overwrite unless --force', async () => {
    const f = await booth([lead(1)]);
    expect((await exportLeads({ ...base(f), pin: '' })).messages.join('')).toMatch(/No staff PIN/);
    writeFileSync(path.join(dir, 'x.csv'), 'old');
    const refused = await exportLeads({ ...base(f), out: 'x.csv' });
    expect(refused.ok).toBe(false);
    expect(readFileSync(path.join(dir, 'x.csv'), 'utf8')).toBe('old');
    const forced = await exportLeads({ ...base(f), out: 'x.csv', force: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(path.join(dir, 'x.csv'), 'utf8')).toContain('lead_1');
  });

  it('still succeeds when only the summary is unavailable', async () => {
    const f = await booth([lead(1)], { summary: false });
    const r = await exportLeads({ ...base(f), out: 'x.csv' });
    expect(r).toMatchObject({ ok: true, count: 1, summary: null });
    expect(r.messages.join('\n')).toMatch(/summary was not available/);
  });

  it('--erase deletes exactly the exported leads, only after the typed confirmation', async () => {
    const f = await booth([lead(1), lead(2)]);
    const asked: string[] = [];
    const r = await exportLeads({ ...base(f), out: 'x.csv', erase: true, confirm: async (q) => (asked.push(q), 'DELETE') });
    expect(r).toMatchObject({ ok: true, count: 2, erased: 2 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Type DELETE/);
    expect(f.leads).toHaveLength(0);
    expect(existsSync(path.join(dir, 'x.csv'))).toBe(true);
    // the file is written before anything is deleted
    expect(f.calls.findIndex((c) => c.startsWith('DELETE'))).toBeGreaterThan(f.calls.indexOf('GET /api/booth/leads/export.csv'));
  });

  it('--erase does nothing unless DELETE is typed (the export stays saved)', async () => {
    const f = await booth([lead(1)]);
    for (const answer of ['', 'yes', 'delete', 'DELETE ME']) {
      const r = await exportLeads({ ...base(f), out: `x-${answer.length}.csv`, erase: true, confirm: async () => answer });
      expect(r.ok).toBe(false);
      expect(r.erased).toBe(0);
    }
    expect(f.leads).toHaveLength(1);
    expect(f.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('--erase leaves a lead that arrived after the export, and reports partial failures', async () => {
    const f = await booth([lead(1), lead(2)]);
    const confirm = async () => {
      f.leads.push(lead(3)); // a visitor submitted while the staff member was typing
      return 'DELETE';
    };
    const r = await exportLeads({ ...base(f), out: 'x.csv', erase: true, confirm });
    expect(r.erased).toBe(2);
    expect(f.leads.map((l) => l.id)).toEqual(['lead_3']);

    const g = await booth([lead(1), lead(2)]);
    g.failDelete.add('lead_2');
    const r2 = await exportLeads({ ...base(g), out: 'y.csv', erase: true, confirm: async () => 'DELETE' });
    expect(r2).toMatchObject({ ok: false, exitCode: 1, erased: 1 });
    expect(r2.messages.join('\n')).toMatch(/1 could not be erased/);
  });

  it('--erase with no terminal and no confirm callback refuses to delete', async () => {
    const f = await booth([lead(1)]);
    const r = await exportLeads({ ...base(f), out: 'x.csv', erase: true });
    // under vitest stdin is not a TTY
    if (!process.stdin.isTTY) {
      expect(r.ok).toBe(false);
      expect(f.leads).toHaveLength(1);
    }
  });

  it('exports an empty booth as a header-only file with count 0', async () => {
    const f = await booth([]);
    const r = await exportLeads({ ...base(f), out: 'x.csv', erase: true, confirm: async () => 'DELETE' });
    expect(r).toMatchObject({ ok: true, count: 0 });
    expect(r.messages.join('\n')).toMatch(/Nothing to erase/);
  });
});
