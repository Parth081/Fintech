import { describe, expect, it } from 'vitest';
import type { AnyEvent, TrialBalance } from '@ct/contracts';
import { happyPath, makeEvent } from '@ct/contracts/testing';
import { breakdown, evaluate, LogAnalyzer, MAX_ATTEMPTS } from './analyze';
import { brokerHttpUrl, parseVerifyArgs } from './args';

const balanced: TrialBalance = {
  asOf: '2026-10-22T00:00:00.000Z',
  journals: 1,
  entries: 4,
  byCurrency: [{ currency: 'USD', debits: 100, credits: 100, balanced: true }],
  balanced: true,
};

function feed(log: LogAnalyzer, events: AnyEvent[]): void {
  for (const e of events) log.apply(log.nextOffset, e);
}

function goodInput(log: LogAnalyzer, sent: string[]) {
  return {
    log,
    sent,
    trafficErrors: 0,
    trialBalance: balanced,
    invariants: { ok: true, violations: [] },
    journals: { byPayment: new Map(sent.map((id) => [id, log.payments.get(id)?.state.status === 'reconciled' ? 1 : 0])), totalJournals: 1 },
    gatewayRejectedEvents: 0,
    ownSystem: true,
  };
}

describe('LogAnalyzer + evaluate', () => {
  it('passes a clean reconciled payment and a held one', () => {
    const log = new LogAnalyzer();
    const ok = happyPath('p-ok');
    const held = happyPath('p-held').slice(0, 2);
    held.push(makeEvent('payment.held', 'p-held', { reason: 'test', atStage: 'risk' }, { producer: 'risk' }));
    feed(log, [...ok, ...held]);
    const checks = evaluate(goodInput(log, ['p-ok', 'p-held']));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const b = breakdown(log, ['p-ok', 'p-held']);
    expect(b.byStatus).toEqual({ reconciled: 1, held: 1 });
    expect(b.byCorridor['US-IN']).toMatchObject({ total: 2, reconciled: 1, held: 1 });
    expect(b.latencyMs.p50).not.toBeNull();
  });

  it('flags duplicate eventIds, invalid transitions and stuck payments', () => {
    const log = new LogAnalyzer();
    const evs = happyPath('p-1');
    feed(log, [...evs.slice(0, 4), evs[3]!]); // duplicate quoted
    // An invalid transition: reconciled straight after quoted.
    log.apply(log.nextOffset, evs[8]!);
    const checks = evaluate({ ...goodInput(log, ['p-1']), journals: { byPayment: new Map(), totalJournals: 0 } });
    const failed = Object.fromEntries(checks.map((c) => [c.id, c.ok]));
    expect(failed['c.no-duplicate-events']).toBe(false);
    expect(failed['c.state-machine']).toBe(false);
    expect(failed['d.all-terminal']).toBe(false);
    expect(log.duplicates).toHaveLength(1);
  });

  it('flags a missing or extra journal and an unbalanced ledger', () => {
    const log = new LogAnalyzer();
    feed(log, happyPath('p-2'));
    const input = goodInput(log, ['p-2']);
    input.journals.byPayment.set('p-2', 2);
    input.trialBalance = { ...balanced, balanced: false, byCurrency: [{ currency: 'USD', debits: 100, credits: 90, balanced: false }] };
    const checks = evaluate(input);
    expect(checks.find((c) => c.id === 'b.journals')!.ok).toBe(false);
    expect(checks.find((c) => c.id === 'a.trial-balance')!.ok).toBe(false);
    expect(evaluate({ ...goodInput(log, ['p-2']), gatewayRejectedEvents: 3 }).find((c) => c.id === 'e.gateway-rejected-events')!.ok).toBe(false);
  });

  it('enforces the retry bound', () => {
    const log = new LogAnalyzer();
    const p = 'p-r';
    const evs = happyPath(p).slice(0, 4);
    for (let a = 1; a <= MAX_ATTEMPTS + 1; a++) {
      evs.push(makeEvent('payment.routed', p, { providerId: 'orion', rail: 'x', estimatedFee: { amountMinor: 1, currency: 'USD' }, alternatives: [], attempt: a }, { producer: 'routing' }));
      evs.push(makeEvent('payment.sent', p, { providerId: 'orion', messageType: 'pacs.008', messageId: `m${a}` }, { producer: 'settlement' }));
      evs.push(makeEvent('payment.send_failed', p, { providerId: 'orion', attempt: a, reasonCode: 'AC04', reason: 'x', statusMessage: 'pacs.002' }, { producer: 'settlement' }));
    }
    feed(log, evs);
    expect(evaluate(goodInput(log, [p])).find((c) => c.id === 'c.retry-bound')!.ok).toBe(false);
    expect(breakdown(log, [p]).retries.sendFailedEvents).toBe(MAX_ATTEMPTS + 1);
  });

  it('drops ISO 20022 XML from the stored state', () => {
    const log = new LogAnalyzer();
    const evs = happyPath('p-x');
    const sent = evs[5]!;
    (sent.payload as { message?: string }).message = '<Document/>';
    feed(log, evs);
    expect((log.payments.get('p-x')!.state.facts['payment.sent'] as { message?: string }).message).toBeUndefined();
  });
});

describe('verify args', () => {
  it('has sensible defaults and parses flags', () => {
    const d = parseVerifyArgs([]);
    expect(d).toMatchObject({ count: 10_000, rate: 300, concurrency: 32, chaos: false, basePort: 27070 });
    expect(d.mix).toEqual({ 'provider-reject': 0.02, 'recon-break': 0.01 });
    const a = parseVerifyArgs(['--count', '500', '--chaos', '--chaos-interval=1500', '--mix', 'none', '--seed', '7']);
    expect(a).toMatchObject({ count: 500, chaos: true, chaosIntervalMs: 1500, mix: {}, seed: 7 });
    expect(() => parseVerifyArgs(['--chaos', '--url', 'http://x'])).toThrow(/chaos/);
    expect(() => parseVerifyArgs(['--count', '0'])).toThrow();
    expect(() => parseVerifyArgs(['--nope'])).toThrow(/Unknown option/);
  });

  it('derives the broker HTTP URL from BROKER_URL', () => {
    expect(brokerHttpUrl('ws://127.0.0.1:7070')).toBe('http://127.0.0.1:7070');
    expect(brokerHttpUrl('wss://h:1/')).toBe('https://h:1');
  });
});
