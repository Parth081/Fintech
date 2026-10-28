import { describe, expect, it } from 'vitest';
import type { Actor, AlertView, CaseView, Permission } from '@ct/contracts/browser';
import {
  alertQuery,
  alertSla,
  bulkAssignTargets,
  canApprove,
  canDecide,
  caseHistory,
  caseSla,
  EMPTY_ALERT_FILTER,
  filterAlerts,
  filterCases,
  requiresApproval,
  slaState,
  sortAlerts,
  validateReason,
} from './queue';
import { amlPattern, auditToHistory, compareNames, contributions, editDistance, enrichRelated, mergeHistory, nameSimilarity, networkLayout, parseRelatedPayments, parseSanctions, scoreBand } from './evidence';

const maya: Actor = { userId: 'u-maya', name: 'Maya', role: 'compliance_analyst' };
const omar: Actor = { userId: 'u-omar', name: 'Omar', role: 'compliance_manager' };
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function alert(over: Partial<AlertView> = {}): AlertView {
  return {
    alertId: 'AL-1',
    paymentId: 'p-1',
    kind: 'fraud',
    severity: 'medium',
    rule: 'FRAUD_MODEL_HIGH',
    score: 0.8,
    summary: 'Unusual amount for this sender',
    reasons: [],
    evidence: {},
    raisedAt: iso(T0),
    caseId: 'CASE-1',
    payment: { status: 'held', corridor: 'US-IN', amount: { amountMinor: 100_00, currency: 'USD' }, debtorName: 'Ada Lane', creditorName: 'Ravi Kumar' },
    ...over,
  };
}

function kase(over: Partial<CaseView> = {}): CaseView {
  return {
    caseId: 'CASE-1',
    paymentId: 'p-1',
    status: 'open',
    priority: 'high',
    alertIds: ['AL-1'],
    assignee: null,
    openedAt: iso(T0),
    slaDueAt: iso(T0 + 3600_000),
    notes: [],
    proposal: null,
    decision: null,
    ...over,
  };
}

const canAll = (_: Permission) => true;
const canOnly = (...ps: Permission[]) => (p: Permission) => ps.includes(p);

describe('SLA countdown', () => {
  it('formats remaining time and tones', () => {
    expect(slaState(iso(T0 + 3600_000), T0, 3600_000)).toMatchObject({ label: '1h 00m left', tone: 'ok', breached: false });
    expect(slaState(iso(T0 + 25 * 60_000), T0, 3600_000).tone).toBe('warn');
    expect(slaState(iso(T0 + 4 * 60_000 + 5_000), T0, 3600_000)).toMatchObject({ label: '4m 05s left', tone: 'bad' });
    expect(slaState(iso(T0 - 190_000), T0)).toMatchObject({ breached: true, label: 'Breached 3m 10s ago', tone: 'bad' });
    expect(slaState(iso(T0 + 2 * 86_400_000 + 3 * 3600_000), T0).label).toBe('2d 03h left');
    expect(slaState('nope', T0).label).toBe('—');
  });
  it('stops for closed cases and derives alert windows from severity', () => {
    expect(caseSla(kase({ status: 'closed' }), T0 + 10 ** 9).label).toBe('Closed');
    expect(caseSla(kase(), T0 + 30 * 60_000).label).toBe('30m 00s left');
    expect(alertSla(alert({ severity: 'critical' }), T0 + 10 * 60_000)).toMatchObject({ label: '5m 00s left', tone: 'warn' });
  });
});

describe('alert filters', () => {
  const list = [
    alert({ alertId: 'A', kind: 'sanctions', severity: 'critical', raisedAt: iso(T0 + 5) }),
    alert({ alertId: 'B', kind: 'fraud', severity: 'low' }),
    alert({ alertId: 'C', kind: 'aml', severity: 'critical', raisedAt: iso(T0) }),
    alert({ alertId: 'D', kind: 'aml', severity: 'high', payment: { ...alert().payment, status: 'reconciled', creditorName: 'Zed Holdings' } }),
  ];
  it('filters by kind, severity, status, search', () => {
    expect(filterAlerts(list, { ...EMPTY_ALERT_FILTER, kinds: ['aml'] }).map((a) => a.alertId)).toEqual(['C']);
    expect(filterAlerts(list, { ...EMPTY_ALERT_FILTER, status: 'all', kinds: ['aml'] }).map((a) => a.alertId)).toEqual(['C', 'D']);
    expect(filterAlerts(list, { ...EMPTY_ALERT_FILTER, status: 'closed' }).map((a) => a.alertId)).toEqual(['D']);
    expect(filterAlerts(list, { ...EMPTY_ALERT_FILTER, severities: ['critical'] }).map((a) => a.alertId)).toEqual(['A', 'C']);
    expect(filterAlerts(list, { ...EMPTY_ALERT_FILTER, status: 'all', q: 'zed hold' }).map((a) => a.alertId)).toEqual(['D']);
  });
  it('uses the case status when known', () => {
    expect(filterAlerts([list[0]!], EMPTY_ALERT_FILTER, new Map([['CASE-1', 'closed' as const]]))).toEqual([]);
  });
  it('sorts worst then oldest', () => {
    expect(sortAlerts(list).map((a) => a.alertId)).toEqual(['C', 'A', 'D', 'B']);
  });
  it('builds a server query', () => {
    expect(alertQuery({ kinds: ['aml', 'fraud'], severities: [], status: 'open', q: ' x ' })).toBe('status=open&kind=aml%2Cfraud&q=x&limit=200&offset=0');
  });
  it('bulk assign skips closed, mine and case-less alerts', () => {
    const cases = new Map([
      ['C1', { assignee: null, status: 'open' as const }],
      ['C2', { assignee: maya, status: 'in_review' as const }],
      ['C3', { assignee: omar, status: 'in_review' as const }],
      ['C4', { assignee: null, status: 'closed' as const }],
    ]);
    const sel = ['C1', 'C1', 'C2', 'C3', 'C4', null].map((c, i) => alert({ alertId: `X${i}`, caseId: c }));
    expect(bulkAssignTargets(sel, cases, maya.userId)).toEqual(['C1', 'C3']);
  });
});

describe('case queues and workflow', () => {
  const cases = [
    kase({ caseId: 'C-mine', assignee: maya, priority: 'low' }),
    kase({ caseId: 'C-free', priority: 'critical' }),
    kase({ caseId: 'C-pend', status: 'pending_approval', assignee: maya, proposal: { decision: 'release', reason: 'ok', by: maya, at: iso(T0) } }),
    kase({ caseId: 'C-closed', status: 'closed', assignee: maya }),
  ];
  it('splits queues', () => {
    expect(filterCases(cases, 'mine', maya.userId).map((c) => c.caseId)).toEqual(['C-pend', 'C-mine']);
    expect(filterCases(cases, 'unassigned', maya.userId).map((c) => c.caseId)).toEqual(['C-free']);
    expect(filterCases(cases, 'approval', maya.userId)).toEqual([]);
    expect(filterCases(cases, 'approval', omar.userId).map((c) => c.caseId)).toEqual(['C-pend']);
    expect(filterCases(cases, 'all', maya.userId).map((c) => c.caseId).at(-1)).toBe('C-closed');
  });
  it('enforces four-eyes in the UI', () => {
    const pend = cases[2]!;
    expect(canApprove(pend, canAll, maya)).toMatchObject({ allowed: false });
    expect(canApprove(pend, canAll, maya).reason).toMatch(/Four-eyes/);
    expect(canApprove(pend, canAll, omar).allowed).toBe(true);
    expect(canApprove(pend, canOnly('cases.decide'), omar).reason).toBe('Requires permission cases.approve');
    expect(canDecide(pend, canAll, maya).allowed).toBe(false);
    expect(canDecide(cases[1]!, canOnly('alerts.read'), maya).reason).toBe('Requires permission cases.decide');
    expect(canDecide(cases[0]!, canAll, omar).reason).toMatch(/Assigned to Maya/);
    expect(canDecide(cases[0]!, canAll, maya).allowed).toBe(true);
    expect(requiresApproval('high')).toBe(true);
    expect(requiresApproval('medium')).toBe(false);
  });
  it('validates reasons', () => {
    expect(validateReason('  ')).toBe('A reason is required');
    expect(validateReason('short')).toMatch(/at least/);
    expect(validateReason('Customer documents verified')).toBeNull();
  });
  it('builds history oldest first', () => {
    const c = kase({ notes: [{ at: iso(T0 + 2000), actor: maya, text: 'Called bank' }], proposal: { decision: 'reject', reason: 'match', by: maya, at: iso(T0 + 3000) } });
    const h = caseHistory(c, [{ alertId: 'A', raisedAt: iso(T0 - 1000), kind: 'sanctions', severity: 'high', summary: 's' }]);
    expect(h.map((x) => x.title)).toEqual(['Sanctions alert raised (high)', 'Case opened', 'Note added', 'Proposed: reject']);
    const audit = auditToHistory([{ id: '1', at: iso(T0 + 2000), actor: maya, action: 'case.assigned', target: { type: 'case', id: 'C' }, details: { assignee: { name: 'Maya' } }, eventId: 'e1' }]);
    expect(audit[0]).toMatchObject({ title: 'Assigned', detail: 'to Maya · event e1' });
    expect(mergeHistory(h, [...audit, h[2]!]).length).toBe(5);
  });
});

describe('sanctions evidence', () => {
  it('reads list entry and score from evidence', () => {
    const m = parseSanctions(alert({ evidence: { listEntry: { name: 'Ravy Kumaar', id: 'FSL-17', list: 'Fictional Sanctions List', aliases: ['R. Kumar'] }, matchScore: 91, partyRole: 'creditor', algorithm: 'jaro-winkler', note: 'x' } }));
    expect(m).toMatchObject({ screenedName: 'Ravi Kumar', listName: 'Ravy Kumaar', listId: 'FSL-17', listSource: 'Fictional Sanctions List', score: 0.91, aliases: ['R. Kumar'], algorithm: 'jaro-winkler' });
    expect(m.extra).toEqual([['note', 'x']]);
  });
  it('degrades gracefully', () => {
    const m = parseSanctions(alert({ evidence: {}, score: 0.5 }));
    expect(m).toMatchObject({ listName: 'Not provided', score: 0.5, partyRole: 'creditor' });
  });
  it('compares names token by token', () => {
    const c = compareNames('Ravi Kumar', 'Ravy Kumar Singh');
    expect(c.left).toEqual([{ token: 'ravi', match: 'fuzzy' }, { token: 'kumar', match: 'exact' }]);
    expect(c.right.map((t) => t.match)).toEqual(['fuzzy', 'exact', 'none']);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(nameSimilarity('abc', 'abc')).toBe(1);
  });
});

describe('fraud contributions', () => {
  it('scales by max |weight| and sorts', () => {
    const c = contributions([
      { code: 'AMOUNT', text: 'Amount 8x usual', weight: 0.4 },
      { code: 'NEW_BEN', text: 'New beneficiary', weight: 0.2 },
      { code: 'TENURE', text: 'Long tenure', weight: -0.1 },
    ]);
    expect(c.map((x) => x.code)).toEqual(['AMOUNT', 'NEW_BEN', 'TENURE']);
    expect(c[0]).toMatchObject({ scaled: 1 });
    expect(c[1]!.scaled).toBeCloseTo(0.5);
    expect(c[0]!.share).toBeCloseTo(2 / 3);
    expect(c[2]!.share).toBe(0);
  });
  it('spreads the score when weights are missing', () => {
    const c = contributions([{ code: 'A', text: 'a' }, { code: 'B', text: 'b' }], 0.8);
    expect(c.map((x) => x.weight)).toEqual([0.4, 0.4]);
    expect(contributions([])).toEqual([]);
  });
  it('bands scores', () => {
    expect(scoreBand(0.95).tone).toBe('bad');
    expect(scoreBand(0.75).tone).toBe('warn');
    expect(scoreBand(0.1).tone).toBe('ok');
    expect(scoreBand(undefined).tone).toBe('neutral');
  });
});

describe('AML network', () => {
  const a = alert({
    kind: 'aml',
    rule: 'AML_FAN_IN',
    paymentId: 'p-1',
    evidence: {
      relatedPayments: [
        { paymentId: 'p-2', debtor: { name: 'S2' }, creditor: { name: 'Ravi Kumar' }, amount: { amountMinor: 900_00, currency: 'USD' } },
        { paymentId: 'p-3', debtorName: 'S3', creditorName: 'Ravi Kumar', amount: 95000, currency: 'USD' },
        { paymentId: 'p-4', debtorName: 'S3', creditorName: 'Ravi Kumar' },
        'p-5',
        42,
      ],
    },
  });
  it('parses related payments and adds the current one', () => {
    const r = parseRelatedPayments(a);
    expect(r.map((x) => x.paymentId)).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
    expect(r[0]!.current).toBe(true);
    expect(r[2]!.amount).toEqual({ amountMinor: 95000, currency: 'USD' });
    expect(amlPattern(r.slice(0, 4), 'AML_FAN_IN')).toMatch(/^Fan-in: 3 senders/);
  });
  it('lays out a bipartite graph deterministically', () => {
    const r = parseRelatedPayments(a).slice(0, 4);
    const l = networkLayout(r, { width: 500, rowH: 40, pad: 20 });
    expect(l.nodes.filter((n) => n.side === 'sender').map((n) => n.label).sort()).toEqual(['Ada Lane', 'S2', 'S3']);
    expect(l.nodes.filter((n) => n.side === 'beneficiary')).toHaveLength(1);
    expect(l.height).toBe(20 * 2 + 2 * 40);
    const ben = l.nodes.find((n) => n.side === 'beneficiary')!;
    expect(ben.y).toBe(20 + 40); // centred
    expect(l.edges.find((e) => e.from === 's:S3')!.count).toBe(2);
    expect(l.edges.filter((e) => e.focus)).toHaveLength(1);
    expect(networkLayout(r, { width: 500 })).toEqual(networkLayout(r, { width: 500 }));
  });
});

describe('alert query params and assignable users', () => {
  it('builds server filters, omitting empties', async () => {
    const { alertQueryParams } = await import('./queue');
    expect(alertQueryParams(EMPTY_ALERT_FILTER)).toEqual({ limit: 200, offset: 0, status: 'open' });
    expect(alertQueryParams({ kinds: ['aml', 'fraud'], severities: ['high'], status: 'all', q: ' acme ' }, 50, 50)).toEqual({ limit: 50, offset: 50, kind: 'aml,fraud', severity: 'high', q: 'acme' });
  });
  it('filters users by role permission', async () => {
    const { usersWith } = await import('./queue');
    const { ROLE_PERMISSIONS } = await import('@ct/contracts/browser');
    const users = [
      { id: 'a', role: 'compliance_analyst' },
      { id: 'b', role: 'treasury' },
      { id: 'c', role: 'compliance_manager' },
    ];
    expect(usersWith(users, 'cases.work', ROLE_PERMISSIONS).map((u) => u.id)).toEqual(['a', 'c']);
    expect(usersWith(users, 'cases.approve', ROLE_PERMISSIONS).map((u) => u.id)).toEqual(['c']);
  });
});

describe('risk engine evidence shape (M4 integration)', () => {
  it('reads relatedPaymentIds and fills names from payment details', () => {
    const alert = {
      paymentId: 'p-4',
      evidence: { relatedPaymentIds: ['p-1', 'p-2', 'p-3'], rulesVersion: 'aml-typologies-v1' },
      payment: { status: 'held', corridor: 'US-IN', amount: { amountMinor: 990_000, currency: 'USD' }, debtorName: 'Mule 4', creditorName: 'Collector Ltd' },
    } as unknown as AlertView;
    const parsed = parseRelatedPayments(alert);
    expect(parsed.map((r) => r.paymentId)).toEqual(['p-4', 'p-1', 'p-2', 'p-3']);
    expect(parsed.find((r) => r.paymentId === 'p-1')?.debtorName).toBe('—');
    const details = new Map([['p-1', { debtorName: 'Mule 1', creditorName: 'Collector Ltd', amount: { amountMinor: 980_000, currency: 'USD' } }]]);
    const enriched = enrichRelated(parsed, details);
    expect(enriched.find((r) => r.paymentId === 'p-1')).toMatchObject({ debtorName: 'Mule 1', creditorName: 'Collector Ltd' });
    expect(enriched.find((r) => r.paymentId === 'p-4')?.debtorName).toBe('Mule 4'); // untouched
    expect(networkLayout(enriched).nodes.some((n) => n.label === 'Collector Ltd')).toBe(true);
  });

  it('reads the sanctions evidence as the screening stage emits it', () => {
    const alert = {
      paymentId: 'p-9', kind: 'sanctions', score: 0.98, reasons: [],
      evidence: { listName: 'FICTIONAL CONSOLIDATED LIST', field: 'creditor', score: 0.98, matchedName: 'Volkhov Maritime Holding', entry: { id: 'FCL-0001', name: 'VOLKOV MARITIME HOLDINGS', type: 'entity', program: 'X', countries: ['XR'], listedOn: '2024-01-01' } },
      payment: { status: 'held', corridor: 'US-IN', amount: { amountMinor: 1, currency: 'USD' }, debtorName: 'A', creditorName: 'Volkhov Maritime Holding' },
    } as unknown as AlertView;
    const s = parseSanctions(alert);
    expect(JSON.stringify(s)).toContain('VOLKOV MARITIME HOLDINGS');
    expect(JSON.stringify(s)).toContain('0.98');
  });
});
