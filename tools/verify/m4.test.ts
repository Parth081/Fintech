import { describe, expect, it } from 'vitest';
import { makeControlEvent, type AnyEvent, type JournalView } from '@ct/contracts';
import { happyPath, makeEvent } from '@ct/contracts/testing';
import { evaluate, LogAnalyzer } from './analyze';
import { checkAuditCoverage, checkAuditEventLinks, checkAuditUnchanged, checkFxSpreads, checkNoRoutingTo, isMirrorReversal, journalBalanced, M4Log, type AuditRow } from './m4-analyze';
import { parseVerifyM4Args } from './m4-args';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });
const party = (n: string) => ({ name: n, country: 'US', accountId: `ACC-${n}` });

function initiated(paymentId: string, key: string): AnyEvent {
  return makeEvent('payment.initiated', paymentId, { amount: usd(100), targetCurrency: 'INR', corridor: 'US-IN', debtor: party('a'), creditor: party('b'), idempotencyKey: key }, { producer: 'payment-api' });
}
const quoted = (paymentId: string, spreadBps: number): AnyEvent =>
  makeEvent('payment.quoted', paymentId, { quoteId: `q-${paymentId}`, rate: '1', spreadBps, sourceAmount: usd(100), targetAmount: { amountMinor: 100, currency: 'INR' }, expiresAt: new Date().toISOString() }, { producer: 'fx' });
const routed = (paymentId: string, providerId: string, attempt: number): AnyEvent =>
  makeEvent('payment.routed', paymentId, { providerId, rail: 'x', estimatedFee: usd(1), alternatives: [], attempt }, { producer: 'routing' });

describe('verify:m4 args', () => {
  it('defaults and flags', () => {
    expect(parseVerifyM4Args([])).toMatchObject({ basePort: 28170, routingSample: 24, keep: false });
    expect(parseVerifyM4Args(['--url', 'http://x:1/', '--base-port=29000', '--keep'])).toMatchObject({ url: 'http://x:1', basePort: 29000, keep: true });
    expect(() => parseVerifyM4Args(['--nope'])).toThrow(/Unknown/);
    expect(() => parseVerifyM4Args(['--routing-sample', '0'])).toThrow();
  });
});

describe('M4Log + checks', () => {
  it('fx spreads: wider during the shock, narrower after', () => {
    const log = new M4Log();
    const evs: AnyEvent[] = [];
    const add = (e: AnyEvent) => evs.push(e);
    ['b1', 'b2', 'd1', 'd2', 'a1'].forEach((id, i) => add(initiated(id, `k-${i}`)));
    add(makeControlEvent('control.fx_shock.started', { shockId: 's@r', corridorId: 'GB-PH', driftBps: 250, noiseMultiplier: 4, rampMs: 0, reason: 'x', runId: 'r' }, { eventId: 'c1', occurredAt: new Date().toISOString(), producer: 'orchestrator' }) as unknown as AnyEvent);
    add(quoted('b1', 50));
    add(quoted('b2', 52));
    add(quoted('d1', 140));
    add(quoted('d2', 160));
    add(makeControlEvent('control.fx_shock.ended', { shockId: 's@r', runId: 'r' }, { eventId: 'c2', occurredAt: new Date().toISOString(), producer: 'orchestrator' }) as unknown as AnyEvent);
    add(quoted('a1', 51));
    evs.forEach((e, i) => log.apply(i, e));
    const checks = checkFxSpreads(log, 'r', { before: ['b1', 'b2'], during: ['d1', 'd2'], after: ['a1'] });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checkFxSpreads(log, 'r', { before: ['d1'], during: ['b1'], after: ['a1'] }).find((c) => c.id === 'h.spread-wider-during')!.ok).toBe(false);
    expect(log.paymentsWithKeyPrefix('k-')).toHaveLength(5);
  });

  it('no first-attempt routing to a disabled provider', () => {
    const log = new M4Log();
    [routed('p0', 'lyra', 1), routed('p1', 'orion', 1), routed('p2', 'lyra', 2), routed('p3', 'vega', 1)].forEach((e, i) => log.apply(i, e));
    expect(checkNoRoutingTo(log, 'lyra', 0, null, new Set(['p1', 'p3'])).ok).toBe(true);
    expect(checkNoRoutingTo(log, 'lyra', -1, null, new Set(['p1'])).ok).toBe(false);
  });

  it('reversal journal mirrors the original', () => {
    const j = (id: string, entries: JournalView['entries']): JournalView => ({ journalId: id, paymentId: 'p', kind: 'k', postedAt: '', causationEventId: '', entries });
    const orig = j('1', [{ accountId: 'a', direction: 'debit', amount: usd(10) }, { accountId: 'b', direction: 'credit', amount: usd(10) }]);
    const rev = j('2', [{ accountId: 'a', direction: 'credit', amount: usd(10) }, { accountId: 'b', direction: 'debit', amount: usd(10) }]);
    expect(isMirrorReversal(orig, rev).ok).toBe(true);
    expect(isMirrorReversal(orig, orig).ok).toBe(false);
    expect(journalBalanced(rev)).toBe(true);
  });

  it('audit coverage, append-only and event links', () => {
    const row = (id: string, userId: string, target: string, eventId?: string): AuditRow => ({ id, at: '', actor: { userId }, action: 'x', target: { type: 'payment', id: target }, ...(eventId ? { eventId } : {}) });
    const calls = [{ userId: 'u-a', method: 'POST', path: '/x', status: 200, targets: ['p1'], at: '' }, { userId: 'u-b', method: 'POST', path: '/y', status: 403, targets: ['p2'], at: '' }];
    expect(checkAuditCoverage(calls, [row('1', 'u-a', 'p1')]).ok).toBe(true);
    expect(checkAuditCoverage(calls, [row('1', 'u-b', 'p1')]).ok).toBe(false);
    expect(checkAuditUnchanged([row('1', 'u-a', 'p1')], [row('1', 'u-a', 'p1'), row('2', 'u-a', 'p1')]).ok).toBe(true);
    expect(checkAuditUnchanged([row('1', 'u-a', 'p1')], [row('1', 'u-a', 'p9')]).ok).toBe(false);
    const log = new M4Log();
    const ev = makeEvent('payment.retry_requested', 'p1', { actor: { userId: 'u-a', name: 'A', role: 'ops_analyst' }, reason: 'r' }, { producer: 'ops' });
    log.apply(0, ev);
    expect(checkAuditEventLinks([row('1', 'u-a', 'p1', ev.eventId)], log).ok).toBe(true);
    expect(checkAuditEventLinks([row('1', 'u-z', 'p1', ev.eventId)], log).ok).toBe(false);
  });

  it('journals check: a refunded payment has the original and the reversal journal', () => {
    const log = new LogAnalyzer();
    const id = 'p-r';
    const evs: AnyEvent[] = happyPath(id);
    evs.push(makeEvent('payment.refund_requested', id, { actor: { userId: 'u', name: 'U', role: 'ops_analyst' }, reason: 'r' }, { producer: 'ops' }));
    evs.push(makeEvent('payment.refunded', id, { journalId: 'j2', entries: [] }, { producer: 'ledger' as never }));
    evs.forEach((e, i) => log.apply(i, e));
    expect(log.invalid).toEqual([]);
    const input = { log, sent: [id], trafficErrors: 0, ownSystem: true, journals: { byPayment: new Map([[id, 2]]), totalJournals: 2 } };
    expect(evaluate(input).find((c) => c.id === 'b.journals')!.ok).toBe(true);
    expect(evaluate({ ...input, journals: { byPayment: new Map([[id, 1]]), totalJournals: 1 } }).find((c) => c.id === 'b.journals')!.ok).toBe(false);
  });
});
