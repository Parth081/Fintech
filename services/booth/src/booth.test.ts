import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsEvent, BoothSummary, Lead } from '@ct/contracts';
import { csvCell, leadsToCsv } from './csv';
import { pinMatches, startBooth, type BoothHandle } from './server';
import { openBoothStore, StoreFullError, type BoothStore } from './store';
import { cleanText, isEmail, LIMITS, validateEvent, validateLead } from './validate';

const CONSENT =
  "We'd like to email you about this demo. We store your details on this booth laptop only and delete them after the event. You can ask us to delete them at any time.";
const SID = 'visit_abcdef123456';
const lead = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Ada Example',
  company: 'Fictional Bank',
  email: 'ada@example.com',
  interest: 'cross-border',
  consent: true,
  consentText: CONSENT,
  ...over,
});
const ev = (type: AnalyticsEvent['type'], at: string, data?: AnalyticsEvent['data'], sessionId = SID): AnalyticsEvent => ({
  sessionId,
  type,
  at,
  ...(data ? { data } : {}),
});

describe('validateLead', () => {
  it('accepts a complete lead and cleans text', () => {
    const r = validateLead(lead({ name: '  Ada\u0000 ‮Example\t ', role: ' CFO ', sessionId: SID, extra: 'ignored' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ ...lead({ name: 'Ada Example' }), role: 'CFO', sessionId: SID });
    expect('extra' in r.value).toBe(false);
  });

  it('requires name, company, email, interest', () => {
    const r = validateLead({ consent: true, consentText: CONSENT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/name is required/);
    expect(r.errors.join(' ')).toMatch(/company is required/);
    expect(r.errors.join(' ')).toMatch(/email is required/);
    expect(r.errors.join(' ')).toMatch(/interest must be one of/);
  });

  it.each([undefined, false, 'true', 1, 'yes', null])('rejects consent=%s (must be literally true)', (consent) => {
    const r = validateLead(lead({ consent }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/consent is required/);
  });

  it('requires the consent sentence', () => {
    expect(validateLead(lead({ consentText: '' })).ok).toBe(false);
    expect(validateLead(lead({ consentText: 'ok' })).ok).toBe(false);
  });

  it.each(['plainaddress', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b..com', 'a..b@c.com', '@example.com', 'x@-bad.com'])('rejects email %s', (email) => {
    expect(validateLead(lead({ email })).ok).toBe(false);
  });

  it('accepts ordinary emails', () => {
    for (const e of ['a.b+tag@sub.example.co.uk', 'x_y@example.io']) expect(isEmail(e)).toBe(true);
  });

  it('enforces max lengths', () => {
    expect(validateLead(lead({ name: 'x'.repeat(LIMITS.name + 1) })).ok).toBe(false);
    expect(validateLead(lead({ company: 'x'.repeat(LIMITS.company + 1) })).ok).toBe(false);
    expect(validateLead(lead({ role: 'x'.repeat(LIMITS.role + 1) })).ok).toBe(false);
    expect(validateLead(lead({ name: 'x'.repeat(LIMITS.name) })).ok).toBe(true);
  });

  it('rejects wrong types and bad session ids', () => {
    expect(validateLead(lead({ name: 42 })).ok).toBe(false);
    expect(validateLead(lead({ interest: 'crypto' })).ok).toBe(false);
    expect(validateLead(lead({ sessionId: 'short' })).ok).toBe(false);
    expect(validateLead(lead({ sessionId: 'bad id with spaces!' })).ok).toBe(false);
    expect(validateLead([]).ok).toBe(false);
    expect(validateLead(null).ok).toBe(false);
  });

  it('cleanText strips control, bidi and zero-width characters', () => {
    expect(cleanText('a\u0007b​c‮d﻿  e\r\n')).toBe('a b c d e');
  });
});

describe('validateEvent', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const at = '2026-10-26T11:59:00.000Z';

  it('accepts documented types with small anonymous data', () => {
    const r = validateEvent(ev('scenario.viewed', at, { scenarioId: 'send-payment', corridor: 'US-IN', step: 3, ok: true }), now);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown types, bad session ids, bad times and unknown fields', () => {
    expect(validateEvent({ ...ev('visit.start', at), type: 'page.view' }, now).ok).toBe(false);
    expect(validateEvent({ ...ev('visit.start', at), sessionId: 'x' }, now).ok).toBe(false);
    expect(validateEvent({ ...ev('visit.start', at), at: 'yesterday' }, now).ok).toBe(false);
    expect(validateEvent(ev('visit.start', '2020-01-01T00:00:00Z'), now).ok).toBe(false);
    expect(validateEvent({ ...ev('visit.start', at), email: 'a@b.com' }, now).ok).toBe(false);
  });

  it.each(['name', 'email', 'Full_Name', 'company', 'phone', 'consentText', 'role'])('rejects personal data key %s', (key) => {
    expect(validateEvent(ev('question.asked', at, { [key]: 'x' }), now).ok).toBe(false);
  });

  it('rejects emails and phone numbers inside values', () => {
    expect(validateEvent(ev('question.asked', at, { text: 'mail me at ada@example.com' }), now).ok).toBe(false);
    expect(validateEvent(ev('question.asked', at, { text: 'call +44 20 7946 0958' }), now).ok).toBe(false);
  });

  it('limits payload size, key count and value types', () => {
    expect(validateEvent(ev('question.asked', at, { text: 'x'.repeat(LIMITS.dataString + 1) }), now).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: LIMITS.dataKeys + 1 }, (_, i) => [`k${i}`, i]));
    expect(validateEvent(ev('cta.shown', at, many), now).ok).toBe(false);
    expect(validateEvent({ ...ev('cta.shown', at), data: { nested: { a: 1 } } }, now).ok).toBe(false);
    expect(validateEvent({ ...ev('cta.shown', at), data: { n: Number.POSITIVE_INFINITY } }, now).ok).toBe(false);
    expect(validateEvent({ ...ev('cta.shown', at), data: { 'bad key': 1 } }, now).ok).toBe(false);
  });
});

describe('csv', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(undefined)).toBe('');
  });

  it('exports one row per lead with a header and BOM', () => {
    const l: Lead = {
      id: 'L1', createdAt: '2026-10-26T10:00:00.000Z', consentAt: '2026-10-26T10:00:00.000Z', name: '=cmd|calc', company: 'Co, Ltd',
      email: 'a@b.com', interest: 'ai', consentText: CONSENT, engagement: { scenarios: ['send-payment'], questions: ['Why?'], dwellSeconds: 90 },
    };
    const csv = leadsToCsv([l]);
    expect(csv.startsWith('﻿id,createdAt,name')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("'=cmd|calc");
    expect(lines[1]).toContain('"Co, Ltd"');
  });
});

describe('pinMatches', () => {
  it('compares exactly', () => {
    expect(pinMatches('2468', '2468')).toBe(true);
    expect(pinMatches('2469', '2468')).toBe(false);
    expect(pinMatches('24680', '2468')).toBe(false);
    expect(pinMatches('', '2468')).toBe(false);
    expect(pinMatches(undefined, '2468')).toBe(false);
    expect(pinMatches('', '')).toBe(false);
  });
});

describe('BoothStore (in-memory PGlite)', () => {
  let store: BoothStore;
  beforeEach(async () => {
    store = await openBoothStore({ maxLeads: 3, maxEvents: 20 });
  });

  it('links engagement from the visit to the lead', async () => {
    await store.addEvents([
      ev('visit.start', '2026-10-26T10:00:00.000Z'),
      ev('scenario.viewed', '2026-10-26T10:00:10.000Z', { scenarioId: 'send-payment' }),
      ev('question.asked', '2026-10-26T10:01:00.000Z', { text: 'Why was Orion chosen?' }),
      ev('scenario.viewed', '2026-10-26T10:01:30.000Z', { scenarioId: 'send-payment' }),
      ev('lead.submitted', '2026-10-26T10:02:00.000Z'),
    ]);
    const input = validateLead(lead({ sessionId: SID, role: 'Head of Payments' }));
    if (!input.ok) throw new Error('bad fixture');
    const l = await store.addLead(input.value, new Date('2026-10-26T10:02:00Z'));
    expect(l).toMatchObject({ name: 'Ada Example', role: 'Head of Payments', consentText: CONSENT, consentAt: '2026-10-26T10:02:00.000Z', sessionId: SID });
    expect(l.engagement).toEqual({ scenarios: ['send-payment'], questions: ['Why was Orion chosen?'], dwellSeconds: 120 });
    expect('consent' in l).toBe(false);
    expect(await store.leads()).toHaveLength(1);
    await store.close();
  });

  it('erasure deletes the lead and unlinks its analytics (free text removed, counts kept)', async () => {
    await store.addEvents([
      ev('visit.start', '2026-10-26T10:00:00.000Z'),
      ev('question.asked', '2026-10-26T10:01:00.000Z', { text: 'Can you explain FX?', intent: 'fx_cost' }),
    ]);
    const input = validateLead(lead({ sessionId: SID }));
    if (!input.ok) throw new Error('bad fixture');
    const l = await store.addLead(input.value);
    expect(await store.deleteLead(l.id)).toBe(true);
    expect(await store.deleteLead(l.id)).toBe(false);
    expect(await store.lead(l.id)).toBeNull();
    const s = await store.summary();
    expect(s.leads).toBe(0);
    expect(s.visits).toBe(1);
    expect(s.topQuestions).toEqual([]);
    // the old session id no longer finds anything
    const again = await store.addLead({ ...input.value });
    expect(again.engagement).toEqual({ scenarios: [], questions: [], dwellSeconds: 0 });
    await store.close();
  });

  it('summarises visits, dwell, leads, scenarios, questions and hours', async () => {
    const other = 'visit_zzzzzzzz9999';
    await store.addEvents([
      ev('visit.start', '2026-10-26T10:00:00.000Z'),
      ev('scenario.viewed', '2026-10-26T10:00:05.000Z', { scenarioId: 'provider-fails' }),
      ev('question.asked', '2026-10-26T10:00:30.000Z', { text: 'Why?' }),
      ev('visit.end', '2026-10-26T10:01:00.000Z'),
      ev('visit.start', '2026-10-26T11:00:00.000Z', undefined, other),
      ev('scenario.viewed', '2026-10-26T11:00:05.000Z', { scenarioId: 'provider-fails' }, other),
      ev('scenario.viewed', '2026-10-26T11:00:10.000Z', { scenarioId: 'send-payment' }, other),
      ev('question.asked', '2026-10-26T11:00:20.000Z', { text: 'Why?' }, other),
      ev('visit.end', '2026-10-26T11:02:00.000Z', undefined, other),
    ]);
    const input = validateLead(lead());
    if (!input.ok) throw new Error('bad fixture');
    await store.addLead(input.value, new Date('2026-10-26T11:03:00Z'));
    const s: BoothSummary = await store.summary();
    expect(s.visits).toBe(2);
    expect(s.avgDwellSeconds).toBe(90);
    expect(s.leads).toBe(1);
    expect(s.topScenarios).toEqual([
      { scenarioId: 'provider-fails', views: 2 },
      { scenarioId: 'send-payment', views: 1 },
    ]);
    expect(s.topQuestions).toEqual([{ text: 'Why?', count: 2 }]);
    expect(s.byHour).toEqual([
      { hour: '2026-10-26T10:00Z', visits: 1, leads: 0 },
      { hour: '2026-10-26T11:00Z', visits: 1, leads: 1 },
    ]);
    await store.close();
  });

  it('enforces hard caps', async () => {
    const input = validateLead(lead());
    if (!input.ok) throw new Error('bad fixture');
    for (let i = 0; i < 3; i++) await store.addLead(input.value);
    await expect(store.addLead(input.value)).rejects.toBeInstanceOf(StoreFullError);
    const many = Array.from({ length: 21 }, () => ev('cta.shown', '2026-10-26T10:00:00.000Z'));
    await expect(store.addEvents(many)).rejects.toBeInstanceOf(StoreFullError);
    await store.close();
  });
});

describe('booth HTTP API', () => {
  const PIN = '7391';
  const PORT = 37091;
  let store: BoothStore;
  let booth: BoothHandle;
  let base: string;
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const staff = { 'x-booth-staff': PIN };

  beforeAll(async () => {
    store = await openBoothStore();
    booth = await startBooth({ store, staffPin: PIN, host: '127.0.0.1', port: PORT, maxPinFailures: 5 });
    base = `http://127.0.0.1:${booth.port}`;
  });
  afterAll(async () => {
    await booth.close();
    await store.close();
  });

  it('GET /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('POST /analytics accepts valid events and drops invalid ones', async () => {
    const at = new Date().toISOString();
    const res = await fetch(`${base}/analytics`, json({ events: [ev('visit.start', at), ev('scenario.viewed', at, { scenarioId: 'send-payment' }), { ...ev('visit.start', at), type: 'nope' }] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 2, rejected: 1 });
    const bad = await fetch(`${base}/analytics`, json({ events: [ev('question.asked', at, { email: 'a@b.com' })] }));
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/analytics`, json({ nope: 1 }))).status).toBe(400);
    const tooMany = Array.from({ length: LIMITS.eventsPerBatch + 1 }, () => ev('cta.shown', at));
    expect((await fetch(`${base}/analytics`, json({ events: tooMany }))).status).toBe(413);
  });

  it('refuses non-JSON bodies and oversized bodies', async () => {
    const form = await fetch(`${base}/leads`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
    expect(form.status).toBe(415);
    const big = await fetch(`${base}/leads`, json(lead({ junk: 'x'.repeat(20_000) })));
    expect(big.status).toBe(413);
    const broken = await fetch(`${base}/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(broken.status).toBe(400);
  });

  it('POST /leads: 400 without consent or with a bad email, 201 with consent', async () => {
    const noConsent = await fetch(`${base}/leads`, json(lead({ consent: false })));
    expect(noConsent.status).toBe(400);
    expect(((await noConsent.json()) as { details: string[] }).details.join(' ')).toMatch(/consent/);
    expect((await fetch(`${base}/leads`, json(lead({ email: 'nope' })))).status).toBe(400);
    const ok = await fetch(`${base}/leads`, json(lead({ sessionId: SID })));
    expect(ok.status).toBe(201);
    const l = (await ok.json()) as Lead;
    expect(l).toMatchObject({ name: 'Ada Example', consentText: CONSENT, sessionId: SID });
    expect(l.engagement.scenarios).toEqual(['send-payment']);
  });

  it('staff routes need the PIN', async () => {
    for (const [method, path] of [['GET', '/leads'], ['GET', '/leads/export.csv'], ['GET', '/summary'], ['DELETE', '/leads/x']] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    const leads = await fetch(`${base}/leads`, { headers: staff });
    expect(leads.status).toBe(200);
    expect(((await leads.json()) as Lead[]).length).toBeGreaterThan(0);
    const summary = await fetch(`${base}/summary`, { headers: staff });
    expect(((await summary.json()) as BoothSummary).leads).toBeGreaterThan(0);
  });

  it('CSV export is an attachment with protected cells', async () => {
    await fetch(`${base}/leads`, json(lead({ name: '=1+2', company: '@evil' })));
    const res = await fetch(`${base}/leads/export.csv`, { headers: staff });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="booth-leads-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await res.text();
    expect(text).toContain("'=1+2");
    expect(text).toContain("'@evil");
    expect(text).not.toMatch(/,=1\+2/);
  });

  it('DELETE /leads/:id erases the lead', async () => {
    const created = (await (await fetch(`${base}/leads`, json(lead({ email: 'erase.me@example.com' })))).json()) as Lead;
    const del = await fetch(`${base}/leads/${encodeURIComponent(created.id)}`, { method: 'DELETE', headers: staff });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect((await fetch(`${base}/leads/${created.id}`, { method: 'DELETE', headers: staff })).status).toBe(404);
    const all = (await (await fetch(`${base}/leads`, { headers: staff })).json()) as Lead[];
    expect(all.some((l) => l.email === 'erase.me@example.com')).toBe(false);
  });

  it('unknown routes 404, wrong methods 405', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/summary`, { method: 'POST', headers: staff })).status).toBe(405);
  });

  it('locks staff routes after repeated wrong PINs', async () => {
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/summary`, { headers: { 'x-booth-staff': '0000' } })).status).toBe(401);
    expect((await fetch(`${base}/summary`, { headers: staff })).status).toBe(429);
  });
});

describe('no outbound network', () => {
  it('booth sources never open outbound connections', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\s*\(|https?\.request|https?\.get\(|net\.connect|createConnection|WebSocket/);
      expect(src, f).not.toMatch(/^import (?!type )[^;]*from 'node:(https|net|dgram|tls)'/m);
    }
  });
});

