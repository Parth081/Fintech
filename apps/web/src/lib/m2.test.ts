import { describe, expect, it } from 'vitest';
import { applyEvent, type AccountBalance, type AnyEvent, type JournalView, type PaymentState } from '@ct/contracts';
import { summarize } from '../../../../services/gateway/src/projection';
import { m2Payment } from '../../../../services/gateway/src/testing/m2-events';
import { highlightXmlLine, prettyXml, xmlValue } from './xml';
import { attemptsFrom } from './attempts';
import { filterAccounts, inferAccountType, journalBalanced, journalRows } from './ledger';
import { changeRatio, sparkGeometry } from './sparkline';
import { hashFor, parseHash } from './route';
import { applyMessage, applyMessages, initialFeed, MAX_ROWS, mergePayments } from './feed';
import { progressDots, progressFraction } from './progress';
import { quoteView, reconView } from './detail';
import { paymentQueryString } from './api';
import { formatCount, formatMinor, formatPct, STAGE_LABELS, statusForEvent } from './format';
import type { PaymentSummary, Stats, UpdateMessage } from './types';

const stateOf = (events: AnyEvent[]): PaymentState => {
  let s: PaymentState | undefined;
  for (const e of events) s = applyEvent(s, e);
  return s!;
};

describe('xml', () => {
  const raw = '<?xml version="1.0"?><Document xmlns="urn:x"><Hdr><MsgId>M-1</MsgId><Empty/></Hdr><Sts>RJCT</Sts></Document>';

  it('pretty-prints with leaf elements on one line', () => {
    expect(prettyXml(raw).split('\n')).toEqual([
      '<?xml version="1.0"?>',
      '<Document xmlns="urn:x">',
      '  <Hdr>',
      '    <MsgId>M-1</MsgId>',
      '    <Empty/>',
      '  </Hdr>',
      '  <Sts>RJCT</Sts>',
      '</Document>',
    ]);
  });

  it('keeps empty elements and is idempotent', () => {
    expect(prettyXml('<a><b></b></a>')).toBe('<a>\n  <b></b>\n</a>');
    const once = prettyXml(raw);
    expect(prettyXml(once)).toBe(once);
  });

  it('tokenises lines losslessly for highlighting', () => {
    for (const line of prettyXml(raw).split('\n')) {
      expect(highlightXmlLine(line).map((t) => t.text).join('')).toBe(line);
    }
    const toks = highlightXmlLine('  <Document xmlns="urn:x">');
    expect(toks.filter((t) => t.kind === 'tag').map((t) => t.text)).toEqual(['Document']);
    expect(toks.find((t) => t.kind === 'attr')?.text).toBe('xmlns');
    expect(toks.find((t) => t.kind === 'value')?.text).toBe('"urn:x"');
    expect(highlightXmlLine('<?xml version="1.0"?>')[0]!.kind).toBe('decl');
  });

  it('reads element values', () => {
    expect(xmlValue(raw, 'Sts')).toBe('RJCT');
    expect(xmlValue('<p:TxSts>ACSC</p:TxSts>', 'TxSts')).toBe('ACSC');
    expect(xmlValue(raw, 'Nope')).toBeNull();
  });
});

describe('attempts timeline', () => {
  it('pairs each routing decision with the provider outcome', () => {
    const { attempts, failed } = attemptsFrom(m2Payment('p', { outcome: 'retry' }));
    expect(failed).toBeUndefined();
    expect(attempts.map((a) => [a.attempt, a.providerId, a.outcome, a.reasonCode ?? null])).toEqual([
      [1, 'orion', 'rejected', 'AC04'],
      [2, 'lyra', 'settled', null],
    ]);
    const second = attempts[1]!;
    expect(second.fullScoring).toBe(true);
    expect(second.excludedProviders).toEqual(['orion']);
    expect(second.scoring[0]).toMatchObject({ providerId: 'lyra', chosen: true });
    expect(second.scoring.at(-1)).toMatchObject({ providerId: 'orion', eligible: false, excludedReason: 'FAILED_THIS_PAYMENT' });
  });

  it('reports terminal failure', () => {
    const r = attemptsFrom(m2Payment('f', { outcome: 'failed', corridorIndex: 1 }));
    expect(r.attempts.every((a) => a.outcome === 'rejected')).toBe(true);
    expect(r.attempts).toHaveLength(2); // DE-BR: orion + vega
    expect(r.failed).toMatchObject({ attempts: 2 });
  });

  it('falls back to M1 alternatives without a scoring table', () => {
    const ev = m2Payment('m1').find((e) => e.type === 'payment.routed')!;
    const m1 = { ...ev, payload: { ...ev.payload, scoring: undefined, attempt: undefined } } as AnyEvent;
    const [a] = attemptsFrom([m1]).attempts;
    expect(a!.fullScoring).toBe(false);
    expect(a!.attempt).toBe(1);
    expect(a!.scoring[0]!.chosen).toBe(true);
    expect(a!.outcome).toBe('routed');
  });
});

describe('ledger helpers', () => {
  const j: JournalView = {
    journalId: 'J-1', paymentId: 'p', kind: 'settlement', postedAt: 'x', causationEventId: 'e',
    entries: [
      { accountId: 'customer:ACC-US-0001', direction: 'debit', amount: { amountMinor: 1000, currency: 'USD' } },
      { accountId: 'fx-position:USD', direction: 'credit', amount: { amountMinor: 1000, currency: 'USD' } },
    ],
  };
  it('renders journal rows with account types and checks balance', () => {
    const rows = journalRows(j, new Map([['fx-position:USD', 'asset' as const]]));
    expect(rows).toEqual([
      { accountId: 'customer:ACC-US-0001', type: 'liability', debit: 'USD 10.00', credit: '' },
      { accountId: 'fx-position:USD', type: 'asset', debit: '', credit: 'USD 10.00' },
    ]);
    expect(journalBalanced(j)).toBe(true);
    expect(journalBalanced({ ...j, entries: [j.entries[0]!] })).toBe(false);
    expect(inferAccountType('provider:orion:payable')).toBe('liability');
    expect(inferAccountType('mystery')).toBeNull();
  });

  it('searches and caps accounts', () => {
    const acc = (accountId: string, type: AccountBalance['type'], currency: string): AccountBalance => ({
      accountId, type, currency, debits: 0, credits: 0, balance: 0, entryCount: 0,
    });
    const list = [acc('fx-position:USD', 'asset', 'USD'), acc('customer:ACC-US-1', 'liability', 'USD'), acc('fx-position:INR', 'asset', 'INR')];
    expect(filterAccounts(list, '').rows.map((a) => a.accountId)).toEqual(['fx-position:INR', 'fx-position:USD', 'customer:ACC-US-1']);
    expect(filterAccounts(list, 'asset usd').rows.map((a) => a.accountId)).toEqual(['fx-position:USD']);
    expect(filterAccounts(list, 'FX', 1)).toMatchObject({ total: 2, rows: [{ accountId: 'fx-position:INR' }] });
  });
});

describe('sparkline', () => {
  it('maps values into the box, min at the bottom and max at the top', () => {
    const g = sparkGeometry([1, 3, 2], 100, 20, 0);
    expect(g.line).toBe('M0 20 L50 0 L100 10');
    expect(g.area).toBe('M0 20 L50 0 L100 10 L100 20 L0 20 Z');
    expect(g).toMatchObject({ min: 1, max: 3, first: 1, last: 2, end: { x: 100, y: 10 } });
  });
  it('handles empty, single and flat series', () => {
    expect(sparkGeometry([], 100, 20).line).toBe('');
    expect(sparkGeometry([5], 100, 20, 0).line).toBe('M50 10');
    expect(sparkGeometry([5, 5], 100, 20, 0).line).toBe('M0 10 L100 10');
    expect(changeRatio(100, 101)).toBeCloseTo(0.01);
    expect(changeRatio(null, 1)).toBeNull();
  });
});

describe('routing and formatting', () => {
  it('parses hash routes', () => {
    expect(parseHash('')).toBe('live');
    expect(parseHash('#/ledger')).toBe('ledger');
    expect(parseHash('#providers')).toBe('providers');
    expect(parseHash('#/fx?x=1')).toBe('fx');
    expect(parseHash('#/nope')).toBe('live');
    expect(hashFor('fx')).toBe('#/fx');
  });
  it('labels M2 statuses and events', () => {
    expect(STAGE_LABELS.retrying.title).toBe('Retrying');
    expect(STAGE_LABELS.failed.title).toBe('Failed');
    expect(statusForEvent('payment.send_failed')).toBe('retrying');
    expect(statusForEvent('payment.failed')).toBe('failed');
    expect(formatCount(12345)).toBe('12,345');
    expect(formatPct(0.9734)).toBe('97.3%');
    expect(formatPct(null)).toBe('—');
    expect(formatMinor(123456, 'USD')).toBe('1,234.56');
    expect(formatMinor(1234, 'JPY')).toBe('1,234');
  });
  it('builds payment queries', () => {
    expect(paymentQueryString({})).toBe('limit=50');
    expect(paymentQueryString({ status: 'failed,retrying', corridor: 'US-IN', provider: 'vega', offset: 50, limit: 25 })).toBe(
      'limit=25&offset=50&status=failed%2Cretrying&corridor=US-IN&provider=vega',
    );
  });
});

describe('progress for retrying and failed', () => {
  it('shows a retry dot at routing while retrying', () => {
    const evs = m2Payment('r', { outcome: 'retry' });
    const s = summarize(stateOf(evs.slice(0, evs.findIndex((e) => e.type === 'payment.send_failed') + 1)));
    expect(s.status).toBe('retrying');
    expect(progressDots(s)).toEqual(['done', 'done', 'done', 'done', 'retry', 'todo', 'todo', 'todo']);
    expect(progressFraction(s)).toBeCloseTo(4 / 7);
  });
  it('marks where a failed payment stopped', () => {
    const s = summarize(stateOf(m2Payment('f', { outcome: 'failed' })));
    expect(progressDots(s)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'stopped', 'skipped']);
  });
});

describe('drawer helpers', () => {
  it('describes the FX quote', () => {
    const evs = m2Payment('q');
    const q = quoteView(stateOf(evs))!;
    expect(q.mid).toBe('83.2500');
    expect(q.spreadBps).toBe(35);
    expect(q.effectiveSpreadBps).toBeCloseTo(35, 0);
    expect(q.validForMs).toBe(30_000);
    expect(q.target).toMatch(/^INR /);
    expect(quoteView(stateOf(evs.slice(0, 2)))).toBeNull();
  });
  it('describes reconciliation results', () => {
    expect(reconView(stateOf(m2Payment('ok')))).toMatchObject({ matched: true, breaks: [], journalId: 'J-ok' });
    expect(reconView(stateOf(m2Payment('b', { outcome: 'break' })))).toMatchObject({ matched: false, breaks: [expect.stringMatching(/AMOUNT_MISMATCH/)] });
  });
});

describe('coalesced feed', () => {
  const statsOf = (total: number) => ({ total }) as unknown as Stats;
  const sum = (id: string, sec: number, status: PaymentSummary['status'] = 'initiated') =>
    ({ ...summarize(stateOf(m2Payment(id).slice(0, 1))), paymentId: id, status, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() });
  const update = (payments: PaymentSummary[], counts: UpdateMessage['counts']): UpdateMessage => ({
    kind: 'update', payments, events: [], eventCount: 0, droppedEvents: 0, counts, stats: statsOf(payments.length),
  });

  it('merges a burst, keeps newest MAX_ROWS and pulses once per stage per frame', () => {
    const many = Array.from({ length: MAX_ROWS + 30 }, (_, i) => sum(`p${i}`, i));
    let s = applyMessage(initialFeed, { kind: 'snapshot', payments: [], stats: statsOf(0) });
    s = applyMessage(s, update(many, { 'payment.initiated': many.length, 'payment.send_failed': 3, 'ledger.posted': 2 }));
    expect(s.payments).toHaveLength(MAX_ROWS);
    expect(s.payments[0]!.paymentId).toBe(`p${MAX_ROWS + 29}`);
    expect(s.pulses).toEqual({ initiated: 1, retrying: 1 });
    expect(s.lastBatch).toHaveLength(many.length);
    expect(s.lastChanged?.paymentId).toBe(`p${MAX_ROWS + 29}`);
    // update of a visible row keeps order without re-sorting
    const changed = { ...s.payments[5]!, status: 'screened' as const };
    const before = s.payments.map((p) => p.paymentId);
    s = applyMessages(s, [update([changed], { 'payment.screened': 1 }), { kind: 'stats', stats: statsOf(999) }]);
    expect(s.payments.map((p) => p.paymentId)).toEqual(before);
    expect(s.payments[5]!.status).toBe('screened');
    expect(s.stats?.total).toBe(999);
    expect(s.pulses.screened).toBe(1);
  });

  it('ignores rows older than the visible window', () => {
    const list = Array.from({ length: 3 }, (_, i) => sum(`n${i}`, 100 + i));
    expect(mergePayments(list, [sum('old', 1)], 3).map((p) => p.paymentId)).toEqual(['n2', 'n1', 'n0']);
  });
});
