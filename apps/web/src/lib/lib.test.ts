import { describe, expect, it } from 'vitest';
import { applyEvent, project, type AnyEvent, type PaymentState } from '@ct/contracts';
import { happyPath, makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { summarize } from '../../../../services/gateway/src/projection';
import {
  corridorLabel,
  elapsedMs,
  formatClock,
  formatDuration,
  providerName,
  shortId,
  stageLabel,
  statusForEvent,
} from './format';
import { progressDots, progressFraction } from './progress';
import { applyMessage, applyMessages, applyPoll, initialFeed, MAX_ROWS, upsert } from './feed';
import { formatInput, keyFacts, ledgerCheck, ledgerRows, timelineRows } from './detail';
import { backoffMs, parseFrame } from './api';
import type { EventMessage, PaymentSummary, Stats } from './types';

function stateOf(events: AnyEvent[]): PaymentState {
  let s: PaymentState | undefined;
  for (const e of events) s = applyEvent(s, e);
  return s!;
}

const stats = (over: Partial<Stats> = {}): Stats => ({
  total: 1,
  byStatus: { initiated: 1, screened: 0, scored: 0, quoted: 0, routed: 0, sent: 0, settled: 0, reconciled: 0, held: 0, rejected: 0 },
  reconciled: 0,
  inFlight: 1,
  held: 0,
  rejected: 0,
  avgEndToEndMs: null,
  rejectedEvents: 0,
  ...over,
});

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4210)).toBe('4.2 s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
  it('labels stages and events', () => {
    expect(stageLabel('screened')).toBe('Screened (KYC / sanctions)');
    expect(stageLabel('sent')).toBe('Sent (pacs.008)');
    expect(statusForEvent('payment.settled')).toBe('settled');
    expect(statusForEvent('payment.held')).toBe('held');
    expect(statusForEvent('ledger.posted')).toBeNull();
  });
  it('formats small things', () => {
    expect(corridorLabel('US-IN')).toBe('US → IN');
    expect(providerName('orion')).toBe('Provider Orion');
    expect(providerName(undefined)).toBe('—');
    expect(shortId('0123456789abcdef')).toBe('01234567…');
    expect(formatClock('nope')).toBe('—');
    expect(formatClock(new Date(2026, 0, 1, 9, 5, 7, 12).toISOString())).toBe('09:05:07.012');
  });
  it('stops the elapsed clock for terminal payments', () => {
    const p = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:09.000Z' };
    const now = Date.parse('2026-01-01T00:01:00.000Z');
    expect(elapsedMs({ ...p, status: 'reconciled' }, now)).toBe(9000);
    expect(elapsedMs({ ...p, status: 'held' }, now)).toBe(9000);
    expect(elapsedMs({ ...p, status: 'sent' }, now)).toBe(60_000);
  });
});

describe('progress', () => {
  it('tracks an in-flight payment', () => {
    const s = summarize(stateOf(happyPath('p').slice(0, 4))); // quoted
    expect(s.stepIndex).toBe(3);
    expect(progressDots(s)).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo', 'todo', 'todo']);
    expect(progressFraction(s)).toBeCloseTo(3 / 7);
  });
  it('completes a reconciled payment', () => {
    const s = summarize(stateOf(happyPath('p')));
    expect(progressDots(s).every((d) => d === 'done')).toBe(true);
    expect(progressFraction(s)).toBe(1);
  });
  it('marks where a held payment stopped', () => {
    const id = 'h';
    const s = summarize(
      stateOf([
        makeEvent('payment.initiated', id, sampleInitiatedPayload()),
        makeEvent('payment.screened', id, { result: 'clear', listVersion: 'v' }),
        makeEvent('payment.held', id, { reason: 'review', atStage: 'risk' }),
      ] as AnyEvent[]),
    );
    expect(s.stepIndex).toBe(-1);
    expect(progressDots(s)).toEqual(['done', 'done', 'stopped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });
});

describe('feed reducer', () => {
  const events = happyPath('pay-1');
  const msg = (n: number): EventMessage => ({
    kind: 'event',
    event: events[n]!,
    payment: summarize(stateOf(events.slice(0, n + 1))),
    stats: stats(),
  });

  it('applies snapshot then events, pulsing the entered stage', () => {
    let s = applyMessage(initialFeed, { kind: 'snapshot', payments: [], stats: stats({ total: 0 }) });
    expect(s.payments).toEqual([]);
    s = applyMessage(s, msg(0));
    expect(s.payments).toHaveLength(1);
    expect(s.pulses.initiated).toBe(1);
    expect(s.lastChanged).toEqual({ paymentId: 'pay-1', seq: 1 });
    s = applyMessages(s, [msg(1), msg(2), msg(7)]); // ledger.posted: no stage pulse
    expect(s.payments).toHaveLength(1);
    expect(s.payments[0]!.status).toBe('settled');
    expect(s.pulses).toEqual({ initiated: 1, screened: 1, scored: 1 });
    expect(s.seq).toBe(4);
  });

  it('keeps newest first and caps rows', () => {
    const base: PaymentSummary = summarize(stateOf(happyPath('x').slice(0, 1)));
    let list: PaymentSummary[] = [];
    for (let i = 0; i < MAX_ROWS + 5; i++) {
      list = upsert(list, { ...base, paymentId: `p${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }
    expect(list).toHaveLength(MAX_ROWS);
    expect(list[0]!.paymentId).toBe(`p${MAX_ROWS + 4}`);
    const updated = upsert(list, { ...list[3]!, status: 'screened' });
    expect(updated[3]!.status).toBe('screened');
  });

  it('polling pulses only what changed', () => {
    const a = summarize(stateOf(events.slice(0, 1)));
    let s = applyPoll(initialFeed, [a], stats());
    expect(s.pulses).toEqual({});
    s = applyPoll(s, [a], stats());
    expect(s.pulses).toEqual({});
    const a2 = summarize(stateOf(events.slice(0, 3)));
    s = applyPoll(s, [a2], stats());
    expect(s.pulses).toEqual({ scored: 1 });
    expect(s.lastChanged?.paymentId).toBe('pay-1');
  });
});

describe('detail helpers', () => {
  const events = happyPath('pay-d');
  const state = project(events).states.get('pay-d')!;

  it('builds timeline rows with latencies', () => {
    const withTrace = events.map((e, i) =>
      i === 1 ? { ...e, trace: { stage: 'screening' as const, decision: 'clear', reasonCodes: ['NO_MATCH'], inputs: {}, ruleVersion: 'r1', latencyMs: 12 } } : e,
    ) as AnyEvent[];
    const rows = timelineRows(withTrace);
    expect(rows).toHaveLength(9);
    expect(rows[0]!.sincePrevMs).toBeNull();
    expect(rows[1]!.sincePrevMs).toBe(1000);
    expect(rows[1]!.stageLatencyMs).toBe(12);
    expect(rows[0]!.stageLatencyMs).toBeNull();
    expect(rows.at(-1)!.sinceStartMs).toBeGreaterThan(0);
  });

  it('extracts key facts', () => {
    const facts = Object.fromEntries(keyFacts(state).map((f) => [f.label, f.value]));
    expect(facts['FX rate']).toBe('83.2500 USD→INR');
    expect(facts['FX spread']).toBe('0 bps');
    expect(facts['Fee']).toBe('USD 1.50');
    expect(facts['Provider']).toBe('Provider Orion');
    expect(facts['Rail']).toBe('Rail-A (instant)');
    expect(facts['pacs.008 message id']).toBe('m-1');
    expect(facts['pacs.002 settlement ref']).toBe('s-1');
    expect(facts['Target amount']).toBe('INR 104,062.50');
  });

  it('renders and checks the ledger', () => {
    const entries = state.facts['ledger.posted']!.entries;
    expect(ledgerCheck(entries)).toEqual({ present: true, balanced: true });
    expect(ledgerCheck(undefined)).toEqual({ present: false, balanced: false });
    const bad = [entries[0]!, { ...entries[1]!, amount: { amountMinor: 1, currency: 'USD' } }];
    expect(ledgerCheck(bad).balanced).toBe(false);
    const rows = ledgerRows(entries);
    expect(rows[0]).toEqual({ account: 'customer:ACC-US-0001', debit: 'USD 1,250.00', credit: '' });
    expect(rows[1]!.credit).toBe('USD 1,250.00');
  });

  it('formats trace inputs', () => {
    expect(formatInput({ amountMinor: 150, currency: 'USD' })).toBe('USD 1.50');
    expect(formatInput([1, 2])).toBe('[1,2]');
    expect(formatInput(0.04)).toBe('0.04');
    expect(formatInput(null)).toBe('null');
  });
});

describe('api helpers', () => {
  it('parses single and batched frames', () => {
    expect(parseFrame('{"kind":"snapshot","payments":[],"stats":{}}')).toHaveLength(1);
    expect(parseFrame('[{"kind":"event"},{"kind":"event"},{"kind":"other"}]')).toHaveLength(2);
    expect(parseFrame('not json')).toEqual([]);
  });
  it('backs off exponentially with a cap', () => {
    expect(backoffMs(0, 500, 10_000, () => 0)).toBe(250);
    expect(backoffMs(0, 500, 10_000, () => 1)).toBe(500);
    expect(backoffMs(3, 500, 10_000, () => 1)).toBe(4000);
    expect(backoffMs(20, 500, 10_000, () => 1)).toBe(10_000);
  });
});
