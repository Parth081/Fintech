// Console shell + shared logic tests (pure modules only).
import { describe, expect, it } from 'vitest';
import type { CaseView, ChangeRequest, Permission, ReconBreak } from '@ct/contracts/browser';
import { csvField, stampedName, toCsv } from './csv';
import { dayBounds, formatMoney, formatPercent, formatRelative, formatUsdCompact, humanize, shortId } from './format';
import { buildQuery, errorFromResponse, pageInfo, parseTotal } from './http';
import { navSections, resolveEntry, type NavEntry } from './nav';
import { buildNotices, unseenCount } from './notifications';
import { activeFilterCount, apiQuery, filtersFromQuery, filtersToQuery, paymentActions, eventTone } from './payments';
import { reasonError } from './reason';
import { consoleHref, isConsoleHash, links, matchPattern, parseConsoleHash, targetHref } from './routing';
import { classify, directJumps, moveIndex, normalizeQuery, searchable } from './search';
import { statusStyle } from './status';
import { nextSort, removeView, sortRows, toggleHidden, upsertView, visibleColumns } from './table';
import { lastSum, trendGeometry } from './trend';

const canAll = (...ps: Permission[]) => (p: Permission) => ps.includes(p);

describe('routing', () => {
  it('treats empty and #/console hashes as the console, booth routes as not', () => {
    expect(isConsoleHash('')).toBe(true);
    expect(isConsoleHash('#/')).toBe(true);
    expect(isConsoleHash('#/console/payments/x')).toBe(true);
    expect(isConsoleHash('#/stage')).toBe(false);
    expect(isConsoleHash('#/presenter')).toBe(false);
  });
  it('parses path, segments and query; builds hrefs round-trip', () => {
    const loc = parseConsoleHash('#/console/payments/pay%201?tab=ledger&x=1');
    expect(loc).toEqual({ path: 'payments/pay 1', segments: ['payments', 'pay 1'], query: { tab: 'ledger', x: '1' } });
    expect(consoleHref('payments/pay 1', { tab: 'ledger', empty: '' })).toBe('#/console/payments/pay%201?tab=ledger');
    expect(parseConsoleHash(consoleHref('audit', { entry: 'a1' })).query.entry).toBe('a1');
  });
  it('matches patterns with params and wildcards', () => {
    expect(matchPattern('payments/:id', 'payments/p1')).toEqual({ id: 'p1' });
    expect(matchPattern('payments/:id', 'payments')).toBeNull();
    expect(matchPattern('risk/*', 'risk/cases/1')).toEqual({ '*': 'cases/1' });
  });
  it('links audit targets into the console', () => {
    expect(targetHref({ type: 'payment', id: 'p1' })).toBe(links.payment('p1'));
    expect(targetHref({ type: 'config', id: 'CR-000001' })).toBe(links.change('CR-000001'));
    expect(targetHref({ type: 'nope', id: 'x' })).toBeNull();
  });
});

describe('navigation', () => {
  const entries: NavEntry[] = [
    { id: 'overview', label: 'Overview', path: '', group: 'Operate', permission: null },
    { id: 'payments', label: 'Payments', path: 'payments', group: 'Operate', permission: 'payments.read' },
    { id: 'refunds', label: 'Refunds', path: 'payments/refunds', group: 'Operate', permission: ['payments.refund.request', 'payments.refund.approve'] },
    { id: 'audit', label: 'Audit', path: 'audit', group: 'Platform', permission: 'audit.read' },
    { id: 'hidden', label: 'Hidden', path: 'risk', group: 'Risk & Compliance', permission: null, hidden: true },
  ];
  it('filters by permission, drops empty groups and hidden entries', () => {
    const s = navSections(entries, canAll('payments.read', 'payments.refund.approve'));
    expect(s.map((x) => x.group)).toEqual(['Operate']);
    expect(s[0]!.items.map((i) => i.id)).toEqual(['overview', 'payments', 'refunds']);
  });
  it('resolves the longest matching base path', () => {
    expect(resolveEntry(entries, 'payments/refunds')?.id).toBe('refunds');
    expect(resolveEntry(entries, 'payments/abc')?.id).toBe('payments');
    expect(resolveEntry(entries, '')?.id).toBe('overview');
    expect(resolveEntry(entries, 'nothing')).toBeNull();
  });
});

describe('http helpers', () => {
  it('maps 403 to a permission message and 401 to a session message', () => {
    expect(errorFromResponse(403, { error: 'forbidden', permission: 'audit.read' }).message).toBe("You don't have permission: audit.read");
    expect(errorFromResponse(403, {}, 'payments.retry').message).toBe("You don't have permission: payments.retry");
    expect(errorFromResponse(401, {}).kind).toBe('unauthorized');
    expect(errorFromResponse(502, { error: 'ops service unavailable', detail: 'ECONNREFUSED' }).message).toBe('ops service unavailable (ECONNREFUSED)');
    expect(errorFromResponse(409, { error: 'payment is settled' }).message).toBe('payment is settled');
  });
  it('builds query strings and paging info', () => {
    expect(buildQuery({ a: 'x', b: '', c: null, d: ['p', 'q'], e: [], f: 0 })).toBe('?a=x&d=p%2Cq&f=0');
    expect(buildQuery({})).toBe('');
    expect(parseTotal('42', 3)).toBe(42);
    expect(parseTotal(null, 3)).toBe(3);
    expect(parseTotal('abc', 3)).toBe(3);
    expect(pageInfo(25, 25, 60)).toEqual({ page: 2, pages: 3, from: 26, to: 50, hasPrev: true, hasNext: true });
    expect(pageInfo(0, 25, 0)).toMatchObject({ from: 0, to: 0, pages: 1, hasNext: false });
  });
});

describe('formatting, status and CSV', () => {
  it('formats money, percentages, compact USD and relative time', () => {
    expect(formatMoney({ amountMinor: 125000, currency: 'USD' })).toContain('1,250.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatPercent(0.9734)).toBe('97.3%');
    expect(formatUsdCompact(1_234_567)).toBe('$1.23M');
    const now = Date.parse('2026-10-27T10:00:00Z');
    expect(formatRelative('2026-10-27T09:57:00Z', now)).toBe('3 min ago');
    expect(formatRelative('2026-10-27T10:12:00Z', now)).toBe('in 12 min');
    expect(humanize('pending_approval')).toBe('Pending approval');
    expect(shortId('0123456789abcdefghijklmnop', 12)).toBe('01234…lmnop');
    expect(dayBounds('2026-13-40')).toBeNull();
  });
  it('maps statuses to tones and falls back for unknown values', () => {
    expect(statusStyle('payment', 'failed')).toEqual({ label: 'Failed', tone: 'bad' });
    expect(statusStyle('severity', 'critical').tone).toBe('bad');
    expect(statusStyle('refund', 'withdrawn').tone).toBe('neutral');
    expect(statusStyle('case', 'weird_state')).toEqual({ label: 'Weird state', tone: 'neutral' });
  });
  it('writes RFC 4180 CSV with formula-injection guard', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('-12.5')).toBe('-12.5');
    expect(csvField(null)).toBe('');
    expect(toCsv([{ header: 'id', value: (r: { id: string }) => r.id }], [{ id: 'x' }])).toBe('id\r\nx\r\n');
    expect(stampedName('payments', 'csv', new Date(2026, 9, 23, 14, 5))).toBe('payments-2026-10-23-1405.csv');
  });
});

describe('tables and saved views', () => {
  it('sorts stably with blanks last in both directions', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 10 }, { v: 2 }];
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([2, 2, 10, null]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([10, 2, 2, null]);
    expect(sortRows([{ s: 'item10' }, { s: 'item9' }], (r) => r.s, 'asc').map((r) => r.s)).toEqual(['item9', 'item10']);
  });
  it('cycles sort direction and manages columns', () => {
    expect(nextSort(null, 'a', 'desc')).toEqual({ key: 'a', dir: 'desc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'a')).toEqual({ key: 'a', dir: 'asc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'b')).toEqual({ key: 'b', dir: 'asc' });
    expect(visibleColumns([{ id: 'id', required: true }, { id: 'x' }, { id: 'y' }], ['id', 'x'])).toEqual(['id', 'y']);
    expect(toggleHidden(['x'], 'x')).toEqual([]);
    expect(toggleHidden([], 'x')).toEqual(['x']);
  });
  it('upserts saved views by name (case-insensitive), newest first', () => {
    const t = new Date('2026-10-27T10:00:00Z');
    let v = upsertView<Record<string, string>>([], 'Failed USD', { status: 'failed' }, t);
    v = upsertView(v, 'Held', { status: 'held' }, t);
    v = upsertView(v, 'failed usd', { status: 'failed', currency: 'USD' }, t);
    expect(v.map((x) => x.name)).toEqual(['failed usd', 'Held']);
    expect(v[0]!.filters).toEqual({ status: 'failed', currency: 'USD' });
    expect(upsertView(v, '   ', {}, t)).toHaveLength(2);
    expect(removeView(v, v[0]!.id).map((x) => x.name)).toEqual(['Held']);
  });
});

describe('payments workspace', () => {
  it('round-trips filters through the URL and builds the API query', () => {
    const f = filtersFromQuery({ status: 'failed,bogus,held', corridor: 'US-IN', minAmount: '100', from: '2026-10-27', q: ' acme ' });
    expect(f.status).toEqual(['failed', 'held']);
    expect(activeFilterCount(f)).toBe(5);
    expect(filtersToQuery(f)).toEqual({ status: 'failed,held', corridor: 'US-IN', minAmount: '100', from: '2026-10-27', q: 'acme' });
    const q = apiQuery({ ...f, maxAmount: '-5', currency: 'usd' });
    expect(q).toMatchObject({ q: 'acme', status: ['failed', 'held'], corridor: 'US-IN', minAmount: 100 });
    expect(q.maxAmount).toBeUndefined();
    expect(q.currency).toBeUndefined();
    expect(typeof q.from).toBe('string');
  });
  it('gates actions by status and permission', () => {
    const ops = canAll('payments.read', 'payments.retry', 'payments.refund.request', 'alerts.read');
    const visible = (s: Parameters<typeof paymentActions>[0], can = ops, ctx = {}) => paymentActions(s, can, ctx).filter((a) => a.visible);
    expect(visible('failed').map((a) => [a.action, a.enabled])).toEqual([['retry', true]]);
    expect(visible('reconciled').map((a) => a.action)).toEqual(['refund']);
    expect(visible('reconciled', ops, { pendingRefund: true })[0]).toMatchObject({ enabled: false, reason: 'A refund request is already pending approval' });
    expect(visible('held', ops, { caseId: 'CASE-2026-000001' })[0]).toMatchObject({ action: 'case', enabled: true });
    expect(visible('held')[0]!.enabled).toBe(false);
    expect(visible('failed', canAll('payments.read'))[0]).toMatchObject({ enabled: false, reason: "You don't have permission: payments.retry" });
    expect(visible('settled')).toEqual([]);
    expect(eventTone({ type: 'payment.failed' })).toBe('bad');
    expect(eventTone({ type: 'payment.refunded' })).toBe('accent');
  });
});

describe('global search', () => {
  it('classifies ids and offers direct jumps', () => {
    expect(classify(' case-2026-000123 ')).toBe('case');
    expect(classify('CR-000042')).toBe('change');
    expect(classify('9f0b2c4e-1a2b-4c3d-8e9f-001122334455')).toBe('payment');
    expect(classify('Northwind')).toBe('text');
    expect(directJumps('case-2026-000123')[0]!.href).toBe(links.case('CASE-2026-000123'));
    expect(directJumps('Northwind')).toEqual([]);
    expect(normalizeQuery('  a   b ')).toBe('a b');
    expect(searchable('a')).toBe(false);
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});

describe('notifications', () => {
  const actor = (id: string) => ({ userId: id, name: id, role: 'x' });
  const kase = (id: string, priority: CaseView['priority'], extra: Partial<CaseView> = {}): CaseView => ({
    caseId: id, paymentId: 'p', status: 'open', priority, alertIds: [], assignee: null, openedAt: '2026-10-27T09:00:00Z', slaDueAt: '2026-10-27T09:15:00Z', notes: [], proposal: null, decision: null, ...extra,
  });
  it('lists urgent cases, approvals for my role (not my own) and open breaks', () => {
    const notices = buildNotices({
      userId: 'u-priya',
      can: canAll('alerts.read', 'cases.approve', 'payments.refund.approve', 'recon.read'),
      nowMs: Date.parse('2026-10-27T10:00:00Z'),
      urgentCases: [kase('C-HIGH', 'high'), kase('C-CRIT', 'critical'), kase('C-LOW', 'low')],
      pendingCases: [
        kase('C-P1', 'high', { status: 'pending_approval', proposal: { decision: 'release', reason: 'ok', by: actor('u-daniel'), at: '2026-10-27T09:30:00Z' } }),
        kase('C-P2', 'high', { status: 'pending_approval', proposal: { decision: 'reject', reason: 'no', by: actor('u-priya'), at: '2026-10-27T09:31:00Z' } }),
      ],
      pendingChanges: [{ id: 'CR-1', status: 'pending', requestedBy: actor('u-ken') } as ChangeRequest],
      pendingRefunds: [{ id: 'RF-1', paymentId: 'p1', requestedBy: { userId: 'u-maya', name: 'Maya' } }, { id: 'RF-2', paymentId: 'p2', requestedBy: { userId: 'u-priya', name: 'Priya' } }],
      openBreaks: [{ breakId: 'B1', providerId: 'orion', breaks: ['AMOUNT_MISMATCH'], status: 'open', detectedAt: '2026-10-27T09:00:00Z' } as ReconBreak, { breakId: 'B2', status: 'resolved', breaks: [], providerId: 'x', detectedAt: '' } as unknown as ReconBreak],
    });
    expect(notices.map((n) => n.id)).toEqual(['case:C-CRIT', 'case:C-HIGH', 'approve-case:C-P1', 'refund:RF-1', 'break:B1']);
    expect(notices[0]!.body).toContain('SLA breached');
    expect(unseenCount(notices, ['case:C-CRIT', 'gone'])).toBe(4);
  });
  it('shows nothing the role cannot act on', () => {
    expect(buildNotices({ userId: 'u', can: canAll('payments.read'), nowMs: 0, urgentCases: [kase('C', 'critical')], pendingChanges: [{ id: 'CR-1', status: 'pending', requestedBy: actor('x') } as ChangeRequest] })).toEqual([]);
  });
});

describe('trend chart and reasons', () => {
  it('builds SVG geometry scaled to the max and failure bars', () => {
    const g = trendGeometry([0, 5, 10], [0, 0, 2], 100, 50, 0);
    expect(g.max).toBe(10);
    expect(g.line).toBe('M0.0,50.0 L50.0,25.0 L100.0,0.0');
    expect(g.area.endsWith('Z')).toBe(true);
    expect(g.bars).toHaveLength(1);
    expect(g.bars[0]!.h).toBeCloseTo(10);
    expect(trendGeometry([], [], 100, 50).line).toBe('');
    expect(lastSum([1, 2, 3, 4], 2)).toBe(7);
  });
  it('requires a meaningful reason', () => {
    expect(reasonError('')).toBe('A reason is required');
    expect(reasonError('  ab ')).toContain('at least 5');
    expect(reasonError('Provider back online')).toBeNull();
  });
});
