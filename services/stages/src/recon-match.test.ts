import { describe, expect, it } from 'vitest';
import { project, type AnyEvent, type LedgerEntry, type PayloadMap } from '@ct/contracts';
import { INITIAL_CONTROL_STATE } from '@ct/contracts';
import { happyPath, makeEvent } from '@ct/contracts/testing';
import { buildEvent } from './runner';
import type { Outcome } from './steps/common';
import { reconciliationSteps } from './steps/reconciliation';

const step = reconciliationSteps[0]!;
const USD = { amountMinor: 125_000, currency: 'USD' };
const INR = { amountMinor: 10_406_250, currency: 'INR' };

function journal(payableMinor = INR.amountMinor): LedgerEntry[] {
  const inr = { amountMinor: payableMinor, currency: 'INR' };
  return [
    { account: 'customer:ACC-US-0001', direction: 'debit', amount: USD },
    { account: 'fx-position:USD', direction: 'credit', amount: USD },
    { account: 'fx-position:INR', direction: 'debit', amount: inr },
    { account: 'provider:orion:payable', direction: 'credit', amount: inr },
  ];
}

/** happyPath up to settled, with an M2 settled payload, then ledger.posted. */
function scenario(paymentId: string, settled: Partial<PayloadMap['payment.settled']> | null, entries = journal()) {
  const base = happyPath(paymentId).slice(0, 6); // initiated..sent
  const settledPayload: PayloadMap['payment.settled'] = { providerId: 'orion', settlementRef: 'STL-1', statusMessage: 'pacs.002', ...(settled ?? {}) };
  const events = [
    ...base,
    makeEvent('payment.settled', paymentId, settledPayload, { producer: 'settlement' }),
    makeEvent('ledger.posted', paymentId, { journalId: 'JRN-1', entries }, { producer: 'ledger' }),
  ] as AnyEvent[];
  const state = project(events).states.get(paymentId)!;
  return { events, state, posted: events[events.length - 1]! };
}

const entryFor = (paymentId: string, amountMinor = INR.amountMinor) => ({
  statementId: 'STMT-ORION-20261022', entryRef: 'NTRY-ABC', providerId: 'orion', amount: { amountMinor, currency: 'INR' }, bookingDate: '2026-10-22', endToEndId: paymentId,
});

async function reconcile(s: ReturnType<typeof scenario>) {
  const outcome = (await step.produce(s.posted, s.state, { now: '2026-10-22T10:00:05Z', services: {}, view: { states: new Map() }, control: INITIAL_CONTROL_STATE })) as Outcome;
  const ev = buildEvent('reconciliation', s.posted, outcome, '2026-10-22T10:00:05Z', 0);
  expect(project([...s.events, ev]).rejected).toEqual([]);
  if (ev.type !== 'payment.reconciled') throw new Error('expected reconciled');
  return ev;
}

describe('reconciliation', () => {
  it('matches when statement, ledger payable and quote agree', async () => {
    const ev = await reconcile(scenario('p1', { settledAmount: INR, statementEntry: entryFor('p1') }));
    expect(ev.payload).toEqual({ statementRef: 'STMT-ORION-20261022', matched: true, journalId: 'JRN-1', breaks: [] });
    expect(ev.trace).toMatchObject({ decision: 'matched', reasonCodes: ['STATEMENT_MATCHED'], ruleVersion: 'recon-v1' });
    expect(ev.trace!.inputs).toMatchObject({ statementMinor: '10406250 INR', ledgerMinor: '10406250 INR', quotedMinor: '10406250 INR', entryRef: 'NTRY-ABC' });
  });

  it('reads the M2 ledger chart account provider:<id>:payable:<CCY>', async () => {
    const entries = journal().map((e) => (e.account === 'provider:orion:payable' ? { ...e, account: 'provider:orion:payable:INR' } : e));
    const ev = await reconcile(scenario('p1b', { settledAmount: INR, statementEntry: entryFor('p1b') }, entries));
    expect(ev.payload).toMatchObject({ matched: true, breaks: [] });
  });

  it('breaks when the provider delivered 1 minor unit short (ledger = quote)', async () => {
    const ev = await reconcile(scenario('p2', { statementEntry: entryFor('p2', INR.amountMinor - 1) }));
    expect(ev.payload.matched).toBe(false);
    expect(ev.payload.breaks).toEqual(['AMOUNT_MISMATCH: statement 10406249 vs ledger 10406250 INR']);
    expect(ev.trace).toMatchObject({ decision: 'break', reasonCodes: ['RECON_BREAK', 'AMOUNT_MISMATCH'] });
  });

  it('breaks when the ledger booked the settled amount instead of the quote', async () => {
    const short = INR.amountMinor - 1;
    const ev = await reconcile(scenario('p3', { statementEntry: entryFor('p3', short) }, journal(short)));
    expect(ev.payload.breaks).toEqual(['LEDGER_QUOTE_MISMATCH: ledger 10406249 vs quote 10406250 INR']);
  });

  it('breaks on a wrong EndToEndId and on a missing provider payable', async () => {
    const entries = journal().map((e) => (e.account === 'provider:orion:payable' ? { ...e, account: 'provider:vega:payable' } : e));
    const ev = await reconcile(scenario('p4', { statementEntry: { ...entryFor('p4'), endToEndId: 'someone-else' } }, entries));
    expect(ev.payload.matched).toBe(false);
    expect(ev.payload.breaks).toEqual([
      'LEDGER_PAYABLE_MISSING: no credit to provider:orion:payable in INR',
      'END_TO_END_MISMATCH: statement someone-else vs payment p4',
    ]);
  });

  it('falls back to the M1 statementRef for settled events without a statement entry', async () => {
    const ev = await reconcile(scenario('p5', null));
    expect(ev.payload.matched).toBe(true);
    expect(ev.payload.statementRef).toMatch(/^camt\.053-\d{8}-[0-9A-F]{12}$/);
    expect(ev.trace!.reasonCodes).toEqual(['STATEMENT_MATCHED', 'NO_STATEMENT_ENTRY_M1']);
  });

  it('is deterministic for the same trigger', async () => {
    const s = scenario('p6', { statementEntry: entryFor('p6') });
    expect(await reconcile(s)).toEqual(await reconcile(s));
  });
});
