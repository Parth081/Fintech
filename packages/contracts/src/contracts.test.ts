import { describe, expect, it } from 'vitest';
import { applyEvent, InvalidTransitionError, PIPELINE, project } from './state-machine';
import { formatMoney, isBalanced } from './money';
import { deterministicId, unitHash } from './ids';
import { happyPath, makeEvent, sampleInitiatedPayload } from './testing';
import type { AnyEvent } from './events';

describe('payment state machine', () => {
  it('walks the happy path from initiated to reconciled', () => {
    const events = happyPath('p-1');
    const { states, rejected } = project(events);
    expect(rejected).toEqual([]);
    const s = states.get('p-1')!;
    expect(s.status).toBe('reconciled');
    expect(s.ledgerPosted).toBe(true);
    expect(s.history.map((h) => h.status)).toEqual([...PIPELINE.slice(0, 7), 'settled', 'reconciled']);
  });

  it('rejects skipping a step', () => {
    const [init, , scored] = happyPath('p-2') as [AnyEvent, AnyEvent, AnyEvent];
    const s = applyEvent(undefined, init);
    expect(() => applyEvent(s, scored)).toThrow(InvalidTransitionError);
  });

  it('is idempotent for a redelivered event', () => {
    const [init, screened] = happyPath('p-3') as [AnyEvent, AnyEvent];
    const s1 = applyEvent(applyEvent(undefined, init), screened);
    expect(applyEvent(s1, screened)).toBe(s1);
  });

  it('refuses reconciliation before the ledger is posted', () => {
    const events = happyPath('p-4');
    const withoutLedger = events.filter((e) => e.type !== 'ledger.posted');
    const { rejected } = project(withoutLedger);
    expect(rejected.map((r) => r.event.type)).toEqual(['payment.reconciled']);
  });

  it('refuses an unbalanced journal', () => {
    const events = happyPath('p-5').slice(0, 7);
    const s = project(events).states.get('p-5')!;
    const bad = makeEvent('ledger.posted', 'p-5', {
      journalId: 'j', entries: [
        { account: 'a', direction: 'debit', amount: { amountMinor: 100, currency: 'USD' } },
        { account: 'b', direction: 'credit', amount: { amountMinor: 99, currency: 'USD' } },
      ],
    });
    expect(() => applyEvent(s, bad)).toThrow(/not balanced/);
  });

  it('can hold a payment before approval but not after routing', () => {
    const events = happyPath('p-6');
    const screened = project(events.slice(0, 2)).states.get('p-6')!;
    const held = makeEvent('payment.held', 'p-6', { reason: 'review', atStage: 'risk' });
    expect(applyEvent(screened, held).status).toBe('held');
    const routed = project(events.slice(0, 5)).states.get('p-6')!;
    expect(() => applyEvent(routed, held)).toThrow(InvalidTransitionError);
  });

  it('does not mutate the previous state', () => {
    const [init, screened] = happyPath('p-7') as [AnyEvent, AnyEvent];
    const s1 = applyEvent(undefined, init);
    const copy = structuredClone(s1);
    applyEvent(s1, screened);
    expect(s1).toEqual(copy);
  });
});

describe('money', () => {
  it('checks balance per currency', () => {
    expect(isBalanced([
      { account: 'a', direction: 'debit', amount: { amountMinor: 5, currency: 'USD' } },
      { account: 'b', direction: 'credit', amount: { amountMinor: 5, currency: 'USD' } },
      { account: 'c', direction: 'debit', amount: { amountMinor: 7, currency: 'INR' } },
      { account: 'd', direction: 'credit', amount: { amountMinor: 7, currency: 'INR' } },
    ])).toBe(true);
    expect(isBalanced([
      { account: 'a', direction: 'debit', amount: { amountMinor: 5, currency: 'USD' } },
      { account: 'b', direction: 'credit', amount: { amountMinor: 5, currency: 'INR' } },
    ])).toBe(false);
  });

  it('formats minor units', () => {
    expect(formatMoney({ amountMinor: 123456789, currency: 'USD' })).toBe('USD 1,234,567.89');
  });
});

describe('ids', () => {
  it('derives stable ids and hashes', () => {
    expect(deterministicId('a', 'b')).toBe(deterministicId('a', 'b'));
    expect(deterministicId('a', 'b')).not.toBe(deterministicId('a', 'c'));
    expect(deterministicId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    const u = unitHash('p-1');
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
  });

  it('builds sample payloads', () => {
    expect(sampleInitiatedPayload().corridor).toBe('US-IN');
  });
});
