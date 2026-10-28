import { describe, expect, it } from 'vitest';
import type { Actor, ChangeRequest, ProviderScore } from '@ct/contracts/browser';
import { DEFAULT_CONFIG } from '@ct/contracts/browser';
import { canReview, diffValues, filterChanges, previewRouting, providerProposals, rescore, samplesFromEvents, summarizeChange, validateChangeReason, validateProposal, weightPercents } from './config';

const ada: Actor = { userId: 'u-ada', name: 'Ada', role: 'admin' };
const ben: Actor = { userId: 'u-ben', name: 'Ben', role: 'admin' };

describe('diff', () => {
  it('diffs nested values field by field', () => {
    expect(diffValues({ success: 0.5, cost: 0.3, speed: 0.2 }, { success: 0.6, cost: 0.3, speed: 0.1 })).toEqual([
      { path: 'speed', before: 0.2, after: 0.1, kind: 'changed' },
      { path: 'success', before: 0.5, after: 0.6, kind: 'changed' },
    ]);
    expect(diffValues({}, { orion: 'open' })).toEqual([{ path: 'orion', before: undefined, after: 'open', kind: 'added' }]);
    expect(diffValues({ orion: 'open' }, { orion: null })).toEqual([{ path: 'orion', before: 'open', after: null, kind: 'removed' }]);
    expect(diffValues(25000, 10000)).toEqual([{ path: '', before: 25000, after: 10000, kind: 'changed' }]);
    expect(diffValues({ a: 1 }, { a: 1 }, true)).toEqual([{ path: 'a', before: 1, after: 1, kind: 'same' }]);
  });
  it('summarises in plain words', () => {
    expect(summarizeChange('provider.enabled', { orion: true, lyra: true }, { orion: false, lyra: true })).toBe('orion: enabled → disabled');
    expect(summarizeChange('provider.forcedBreaker', {}, { vega: 'open' })).toBe('vega: automatic → forced open');
    expect(summarizeChange('risk.manualReviewAboveUsd', 25000, 0)).toBe('USD 25,000 → off');
    expect(summarizeChange('risk.manualReviewAboveUsd', 1, 1)).toBe('No change');
  });
});

describe('validation', () => {
  it('validates per key', () => {
    expect(validateProposal('risk.thresholds', { hold: 0.9, reject: 0.8 }, DEFAULT_CONFIG['risk.thresholds'])).toMatch(/below/);
    expect(validateProposal('risk.thresholds', { hold: 0.6, reject: 0.9 }, DEFAULT_CONFIG['risk.thresholds'])).toBeNull();
    expect(validateProposal('risk.thresholds', DEFAULT_CONFIG['risk.thresholds'], DEFAULT_CONFIG['risk.thresholds'])).toMatch(/same/);
    expect(validateProposal('risk.manualReviewAboveUsd', -5, 25000)).toMatch(/whole/);
    expect(validateProposal('routing.weights', { success: 0, cost: 0, speed: 0 }, DEFAULT_CONFIG['routing.weights'])).toMatch(/above 0/);
    expect(validateProposal('provider.enabled', { orion: false, lyra: false, vega: false }, DEFAULT_CONFIG['provider.enabled'])).toMatch(/one provider/);
    expect(validateProposal('provider.enabled', { orion: false, lyra: true, vega: false }, DEFAULT_CONFIG['provider.enabled'])).toMatch(/DE-BR/);
    expect(validateProposal('provider.forcedBreaker', { orion: 'open' }, {}, { ...DEFAULT_CONFIG, 'provider.enabled': { orion: true, lyra: true, vega: false } })).toMatch(/DE-BR/);
    expect(validateProposal('provider.forcedBreaker', { orion: 'open' }, {}, DEFAULT_CONFIG)).toBeNull();
    expect(validateChangeReason('')).toMatch(/required/);
    expect(validateChangeReason('Orion maintenance window tonight')).toBeNull();
  });
});

describe('change requests', () => {
  const cr = (id: string, over: Partial<ChangeRequest> = {}): ChangeRequest => ({
    id,
    key: 'routing.weights',
    currentValue: {},
    proposedValue: {},
    reason: 'r',
    requestedBy: ada,
    requestedAt: `2026-10-23T10:0${id}:00.000Z`,
    status: 'pending',
    ...over,
  });
  it('orders pending first then newest', () => {
    const list = [cr('1', { status: 'approved' }), cr('2'), cr('3', { status: 'rejected' }), cr('4', { key: 'risk.thresholds' })];
    expect(filterChanges(list, 'all').map((c) => c.id)).toEqual(['4', '2', '3', '1']);
    expect(filterChanges(list, 'pending', 'routing.weights').map((c) => c.id)).toEqual(['2']);
  });
  it('enforces four-eyes', () => {
    const yes = () => true;
    expect(canReview(cr('1'), yes, ada.userId).reason).toMatch(/Four-eyes/);
    expect(canReview(cr('1'), yes, ben.userId).allowed).toBe(true);
    expect(canReview(cr('1'), () => false, ben.userId).reason).toBe('Requires permission config.approve');
    expect(canReview(cr('1', { status: 'approved' }), yes, ben.userId).reason).toBe('Already approved');
  });
});

describe('routing preview', () => {
  const s = (providerId: string, successRate: number, fee: number, latencyMs: number, eligible = true): ProviderScore => ({ providerId, eligible, successRate, fee: { amountMinor: fee, currency: 'USD' }, latencyMs, score: 0 });
  // orion: reliable, pricey, fast; vega: cheap, slow, slightly less reliable
  const scoring = [s('orion', 0.99, 300, 1000), s('vega', 0.97, 100, 4000), s('lyra', 0.9, 200, 2000, false)];
  it('re-scores like the router', () => {
    const r = rescore(scoring, { success: 0.5, cost: 0.3, speed: 0.2 });
    // orion: success 1, cost 1/3, speed 1 -> 0.5 + 0.1 + 0.2 = 0.8; vega: success 0.8, cost 1, speed .25 -> .4+.3+.05 = .75
    expect(r.map((x) => [x.providerId, x.score])).toEqual([['orion', 0.8], ['vega', 0.75], ['lyra', 0]]);
    expect(rescore(scoring, { success: 0, cost: 1, speed: 0 })[0]!.providerId).toBe('vega');
    const off = rescore(scoring, { success: 1, cost: 0, speed: 0 }, { disabled: new Set(['orion']) });
    expect(off[0]!.providerId).toBe('vega');
    expect(off.find((x) => x.providerId === 'orion')!.excludedReason).toBe('PROVIDER_DISABLED');
  });
  it('summarises the effect on recent payments', () => {
    const samples = [
      { paymentId: 'p1', corridor: 'US-IN', chosen: 'orion', scoring },
      { paymentId: 'p2', corridor: 'US-IN', chosen: 'orion', scoring: [s('orion', 0.99, 300, 1000)] },
    ];
    const p = previewRouting(samples, { success: 0.1, cost: 0.9, speed: 0 });
    expect(p.changed).toBe(1);
    expect(p.rows[0]).toMatchObject({ before: 'orion', after: 'vega', changed: true });
    expect(p.shareBefore).toEqual({ orion: 1 });
    expect(p.shareAfter).toEqual({ vega: 0.5, orion: 0.5 });
    const none = previewRouting(samples, { success: 1, cost: 0, speed: 0 }, { forcedOpen: new Set(['orion']) });
    expect(none.unroutable).toBe(1);
  });
  it('turns weights into percentages that sum to 100', () => {
    expect(weightPercents({ success: 1, cost: 1, speed: 1 })).toEqual({ success: 34, cost: 33, speed: 33 });
    expect(weightPercents({ success: 0.5, cost: 0.3, speed: 0.2 })).toEqual({ success: 50, cost: 30, speed: 20 });
    expect(weightPercents({ success: 0, cost: 0, speed: 0 })).toEqual({ success: 0, cost: 0, speed: 0 });
  });
});

describe('routing samples and provider proposals', () => {
  const score = (providerId: string): ProviderScore => ({ providerId, eligible: true, fee: { amountMinor: 100, currency: 'USD' }, successRate: 0.98, latencyMs: 900, score: 0.5 });
  it('takes the first-attempt routing decision that recorded scoring', () => {
    const s = samplesFromEvents([
      { paymentId: 'p1', corridor: 'US-IN', events: [{ type: 'payment.routed', payload: { providerId: 'orion', attempt: 1, scoring: [score('orion'), score('lyra')] } }, { type: 'payment.routed', payload: { providerId: 'lyra', attempt: 2, scoring: [score('lyra')] } }] },
      { paymentId: 'p2', corridor: 'US-IN', events: [{ type: 'payment.routed', payload: { providerId: 'orion' } }] },
      { paymentId: 'p3', corridor: 'US-IN', events: [{ type: 'payment.initiated', payload: {} }] },
    ]);
    expect(s.map((x) => [x.paymentId, x.chosen, x.scoring.length])).toEqual([['p1', 'orion', 2]]);
  });
  it('splits a providers edit into per-key change requests and validates coverage', () => {
    const cur = { 'provider.enabled': { orion: true, lyra: true, vega: true }, 'provider.forcedBreaker': {} };
    expect(providerProposals(cur, cur)).toEqual({ changes: [], errors: [] });
    const r = providerProposals(cur, { 'provider.enabled': { orion: false, lyra: true, vega: true }, 'provider.forcedBreaker': { vega: 'open', lyra: null } });
    expect(r.changes).toEqual([
      { key: 'provider.enabled', value: { orion: false, lyra: true, vega: true } },
      { key: 'provider.forcedBreaker', value: { vega: 'open' } },
    ]);
    const none = providerProposals(cur, { 'provider.enabled': { orion: false, lyra: false, vega: false }, 'provider.forcedBreaker': {} });
    expect(none.errors[0]).toBe('At least one provider must stay enabled');
    expect(none.errors.length).toBeGreaterThan(1);
  });
});
