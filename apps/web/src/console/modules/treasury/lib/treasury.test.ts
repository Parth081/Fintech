import { describe, expect, it } from 'vitest';
import type { AccountBalance, Actor, ReconBreak } from '@ct/contracts/browser';
import { ageLabel, breakDifference, breakReasonText, filterBreaks, fxPositions, matchRate, providerBalances, toUsd, validateResolution, volumesToday } from './treasury';

const acct = (accountId: string, debits: number, credits: number, currency = 'USD'): AccountBalance => ({ accountId, type: 'asset', currency, debits, credits, balance: debits - credits, entryCount: 2 });
const ana: Actor = { userId: 'u-ana', name: 'Ana', role: 'treasury' };

describe('positions and balances', () => {
  const accounts = [
    acct('fx-position:USD', 0, 1000_00),
    acct('fx-position:INR', 83250_00, 0, 'INR'),
    acct('fx-position:EUR', 500, 500, 'EUR'),
    acct('provider:orion:payable:INR', 0, 83250_00, 'INR'),
    acct('provider:vega:payable:BRL', 100, 600, 'BRL'),
    acct('customer:ACC-US-0001:USD', 1000_00, 0),
  ];
  it('reads fx-position accounts as long/short with indicative USD', () => {
    const p = fxPositions(accounts);
    expect(p.map((x) => [x.currency, x.direction])).toEqual([['INR', 'long'], ['USD', 'short'], ['EUR', 'flat']]);
    expect(p[0]!.usd).toBeCloseTo(1000, 6);
    expect(p[1]!.usd).toBeCloseTo(-1000, 6);
  });
  it('reads provider payables (credit balance owed)', () => {
    expect(providerBalances(accounts).map((b) => [b.providerId, b.currency, b.payableMinor])).toEqual([['orion', 'INR', 83250_00], ['vega', 'BRL', 500]]);
  });
  it('converts unknown currencies to null', () => {
    expect(toUsd({ amountMinor: 1, currency: 'XXX' })).toBeNull();
    expect(toUsd({ amountMinor: 1000, currency: 'JPY' })).toBeCloseTo(1000 / 150);
  });
});

describe('volumes and match rate', () => {
  const now = new Date(2026, 9, 23, 15, 0, 0).getTime();
  const today = new Date(2026, 9, 23, 9, 0, 0).toISOString();
  const yesterday = new Date(2026, 9, 22, 9, 0, 0).toISOString();
  const pays = [
    { corridor: 'US-IN', providerId: 'orion', amount: { amountMinor: 100_00, currency: 'USD' }, createdAt: today, status: 'reconciled' },
    { corridor: 'US-IN', providerId: 'lyra', amount: { amountMinor: 50_00, currency: 'USD' }, createdAt: today, status: 'held' },
    { corridor: 'GB-PH', amount: { amountMinor: 1000_00, currency: 'GBP' }, createdAt: today, status: 'initiated' },
    { corridor: 'US-IN', providerId: 'orion', amount: { amountMinor: 999_00, currency: 'USD' }, createdAt: yesterday, status: 'reconciled' },
  ];
  it('groups today by corridor and provider', () => {
    const c = volumesToday(pays, 'corridor', now);
    expect(c.map((r) => [r.key, r.count, r.settled])).toEqual([['GB-PH', 1, 0], ['US-IN', 2, 1]]);
    expect(c[1]!.bySource).toEqual({ USD: 150_00 });
    expect(volumesToday(pays, 'provider', now).map((r) => r.key)).toEqual(['unrouted', 'orion', 'lyra']);
  });
  it('computes match rate', () => {
    expect(matchRate(9, 1)).toBe(0.9);
    expect(matchRate(0, 0)).toBeNull();
  });
});

describe('breaks', () => {
  const b = (id: string, over: Partial<ReconBreak> = {}): ReconBreak => ({
    breakId: id,
    paymentId: `p-${id}`,
    providerId: 'orion',
    detectedAt: '2026-10-23T10:00:00.000Z',
    breaks: ['AMOUNT_MISMATCH'],
    expected: { amountMinor: 1000, currency: 'INR' },
    reported: { amountMinor: 990, currency: 'INR' },
    status: 'open',
    assignee: null,
    ...over,
  });
  const list = [b('3', { status: 'resolved' }), b('2', { assignee: ana, status: 'investigating' }), b('1', { detectedAt: '2026-10-23T09:00:00.000Z' })];
  it('filters and orders the queue', () => {
    expect(filterBreaks(list, 'open', ana.userId).map((x) => x.breakId)).toEqual(['1', '2']);
    expect(filterBreaks(list, 'mine', ana.userId).map((x) => x.breakId)).toEqual(['2']);
    expect(filterBreaks(list, 'resolved', ana.userId).map((x) => x.breakId)).toEqual(['3']);
    expect(filterBreaks(list, 'all', ana.userId, 'p-3').map((x) => x.breakId)).toEqual(['3']);
  });
  it('computes the difference only in the same currency', () => {
    expect(breakDifference(list[0]!)).toBe(-10);
    expect(breakDifference(b('x', { reported: null }))).toBeNull();
    expect(breakDifference(b('x', { reported: { amountMinor: 1, currency: 'USD' } }))).toBeNull();
  });
  it('explains and validates', () => {
    expect(breakReasonText('AMOUNT_MISMATCH')).toMatch(/Amount/);
    expect(breakReasonText('VALUE_DATE_SHIFT')).toBe('Value date shift');
    expect(validateResolution('', 'long enough note')).toMatch(/code/);
    expect(validateResolution('WRITE_OFF', 'short')).toMatch(/at least/);
    expect(validateResolution('WRITE_OFF', 'Rounding below tolerance')).toBeNull();
    expect(ageLabel('2026-10-23T10:00:00.000Z', Date.parse('2026-10-23T13:05:00.000Z'))).toBe('3h 05m');
    expect(ageLabel('2026-10-20T10:00:00.000Z', Date.parse('2026-10-23T13:05:00.000Z'))).toBe('3d');
  });
});
