import { describe, expect, it } from 'vitest';
import type { AnalyticsEvent, AnyEvent } from '@ct/contracts/browser';
import { AnalyticsBatcher, newSessionId } from './analytics';
import {
  citationValue,
  explainEvent,
  explainEvents,
  isTerminal,
  ledgerBalanced,
  outcomeOf,
  rankSuggestions,
  revealNext,
  visibleAnswer,
} from './explain';
import { flowReducer, initialFlow, visitActive, type FlowAction, type FlowState } from './flow';
import { IdleTimer } from './idle';
import { applyKey, finalQuestion, QUESTION_MAX } from './keyboard';
import { CONSENT_TEXT, emptyLeadForm, leadFormErrors, toLeadInput } from './lead';
import { amountChips, buildPaymentRequest, chipLabel, CORRIDOR_CARDS, PROVIDER_FAIL_SCENARIO } from './payment';

describe('IdleTimer', () => {
  it('goes active -> warning -> expired after 60 s without a touch', () => {
    const t = new IdleTimer(0);
    expect(t.status(0)).toEqual({ phase: 'active', remainingMs: 60_000, secondsLeft: 60 });
    expect(t.status(44_999).phase).toBe('active');
    expect(t.status(45_000)).toMatchObject({ phase: 'warning', secondsLeft: 15 });
    expect(t.status(59_001)).toMatchObject({ phase: 'warning', secondsLeft: 1 });
    expect(t.status(60_000)).toEqual({ phase: 'expired', remainingMs: 0, secondsLeft: 0 });
    expect(t.status(99_000).phase).toBe('expired');
  });

  it('a touch restarts the countdown; old timestamps are ignored', () => {
    const t = new IdleTimer(0);
    t.touch(50_000);
    expect(t.status(60_000).phase).toBe('active');
    t.touch(10_000);
    expect(t.lastActivity).toBe(50_000);
    expect(t.status(110_000).phase).toBe('expired');
  });

  it('validates its settings', () => {
    expect(() => new IdleTimer(0, 0)).toThrow();
    expect(() => new IdleTimer(0, 1000, 2000)).toThrow();
  });
});

const run = (actions: FlowAction[], s: FlowState = initialFlow()) => actions.reduce(flowReducer, s);

describe('flow', () => {
  it('walks a full visit', () => {
    let s = initialFlow();
    expect(visitActive(s)).toBe(false);
    s = run([{ type: 'start', mode: 'send' }], s);
    expect(s.screen).toBe('choose');
    expect(visitActive(s)).toBe(true);
    s = run([{ type: 'pickCorridor', corridorId: 'DE-BR' }, { type: 'pickAmount', amountMajor: 2000 }], s);
    expect(s).toMatchObject({ corridorId: 'DE-BR', amountMajor: 2000 });
    s = run([{ type: 'sendStarted' }, { type: 'sent', paymentId: 'p1' }], s);
    expect(s).toMatchObject({ screen: 'tracking', paymentId: 'p1', sending: false });
    s = run([{ type: 'askOpen', stepId: 'e1' }], s);
    expect(s.askStepId).toBe('e1');
    s = run([{ type: 'finished', outcome: 'delivered' }], s);
    expect(s).toMatchObject({ screen: 'done', outcome: 'delivered', completed: ['send'] });
    s = run([{ type: 'openLead' }], s);
    expect(s).toMatchObject({ screen: 'lead', askStepId: null });
    s = run([{ type: 'leadSubmitted' }], s);
    expect(s).toMatchObject({ screen: 'thanks', leadSubmitted: true });
    const r = run([{ type: 'reset' }], s);
    expect(r).toEqual(initialFlow(1));
  });

  it('never offers the lead form before the value moment', () => {
    for (const before of [[], [{ type: 'start', mode: 'send' }], [{ type: 'start', mode: 'fail' }, { type: 'sendStarted' }, { type: 'sent', paymentId: 'p' }]] as FlowAction[][]) {
      const s = run(before);
      expect(run([{ type: 'openLead' }], s).screen).not.toBe('lead');
    }
  });

  it('a lead can be submitted once per visit; skip goes to thanks', () => {
    const done = run([{ type: 'start', mode: 'send' }, { type: 'sendStarted' }, { type: 'sent', paymentId: 'p' }, { type: 'finished', outcome: 'delivered' }]);
    expect(run([{ type: 'skipLead' }], done).screen).toBe('thanks');
    const thanks = run([{ type: 'openLead' }, { type: 'leadSubmitted' }], done);
    const again = run([{ type: 'again', mode: 'fail' }, { type: 'sendStarted' }, { type: 'sent', paymentId: 'q' }, { type: 'finished', outcome: 'delivered' }], thanks);
    expect(again.completed).toEqual(['send', 'fail']);
    expect(run([{ type: 'openLead' }], again).screen).toBe('done');
  });

  it('ignores invalid picks and double sends', () => {
    const s = run([{ type: 'start', mode: 'send' }]);
    expect(run([{ type: 'pickCorridor', corridorId: 'XX-YY' }], s)).toBe(s);
    expect(run([{ type: 'pickAmount', amountMajor: 7 }], s)).toBe(s);
    const sending = run([{ type: 'sendStarted' }], s);
    expect(run([{ type: 'sendStarted' }], sending)).toBe(sending);
    expect(run([{ type: 'pickCorridor', corridorId: 'GB-PH' }], sending)).toBe(sending);
    const failed = run([{ type: 'sendFailed', error: 'down' }], sending);
    expect(failed).toMatchObject({ sending: false, error: 'down', screen: 'choose' });
  });

  it('reset clears everything and bumps the visit key', () => {
    const s = run([{ type: 'start', mode: 'fail' }, { type: 'pickCorridor', corridorId: 'GB-PH' }]);
    const r = flowReducer(s, { type: 'reset' });
    expect(r.screen).toBe('welcome');
    expect(r.visit).toBe(s.visit + 1);
    expect(r.corridorId).toBe(initialFlow().corridorId);
  });
});

describe('payment request', () => {
  it('builds a valid body for every corridor and chip', () => {
    expect(CORRIDOR_CARDS.map((c) => c.id)).toEqual(['US-IN', 'DE-BR', 'GB-PH']);
    for (const card of CORRIDOR_CARDS) {
      for (const amt of amountChips(card.id)) {
        const r = buildPaymentRequest(card.id, amt, 'send', () => 0.5);
        expect(r.amount).toEqual({ amountMinor: amt * 100, currency: card.sourceCurrency });
        expect(r.targetCurrency).toBe(card.targetCurrency);
        expect(r.debtor.country).toBe(card.fromCode);
        expect(r.creditor.country).toBe(card.toCode);
        expect(r.debtor.accountId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
        expect(r.scenario).toBeUndefined();
      }
    }
  });

  it('provider-fail mode asks the pipeline to make the first provider refuse', () => {
    expect(buildPaymentRequest('US-IN', 250, 'fail').scenario).toBe(PROVIDER_FAIL_SCENARIO);
    expect(PROVIDER_FAIL_SCENARIO).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it('rejects unknown corridors and bad amounts', () => {
    expect(() => buildPaymentRequest('XX-YY', 10, 'send')).toThrow();
    expect(() => buildPaymentRequest('US-IN', 0, 'send')).toThrow();
  });

  it('labels chips', () => {
    expect(chipLabel(1000, 'USD')).toBe('$1,000');
    expect(chipLabel(500, 'EUR')).toBe('€500');
    expect(chipLabel(5, 'JPY')).toBe('JPY 5');
  });
});

let seq = 0;
const evt = <T extends AnyEvent['type']>(type: T, payload: Extract<AnyEvent, { type: T }>['payload'], trace?: Partial<NonNullable<AnyEvent['trace']>>): AnyEvent =>
  ({
    eventId: `e${++seq}`,
    type,
    schemaVersion: 1,
    paymentId: 'p1',
    occurredAt: new Date(Date.UTC(2026, 9, 26, 10, 0, seq)).toISOString(),
    correlationId: 'p1',
    causationId: null,
    producer: 'routing',
    payload,
    ...(trace ? { trace: { stage: 'routing', decision: 'x', reasonCodes: [], inputs: {}, ruleVersion: 'v', latencyMs: 1, ...trace } } : {}),
  }) as AnyEvent;

const usd = (n: number) => ({ amountMinor: n, currency: 'USD' });
const inr = (n: number) => ({ amountMinor: n, currency: 'INR' });

function failedThenDelivered(): AnyEvent[] {
  return [
    evt('payment.initiated', { amount: usd(25000), targetCurrency: 'INR', corridor: 'US-IN', debtor: { name: 'Northwind Marketplace', country: 'US', accountId: 'A' }, creditor: { name: 'Asha Textiles', country: 'IN', accountId: 'B' }, idempotencyKey: 'k', scenario: 'provider-reject' }),
    evt('payment.screened', { result: 'clear', listVersion: 'L-7' }),
    evt('payment.scored', { fraudScore: 0.123, amlAlerts: [], decision: 'approve' }),
    evt('payment.quoted', { quoteId: 'q', rate: '83.0000', midRate: '83.2500', spreadBps: 30, sourceAmount: usd(25000), targetAmount: inr(2075000), expiresAt: 'x' }),
    evt(
      'payment.routed',
      {
        providerId: 'orion', rail: 'Rail-A', estimatedFee: usd(150), alternatives: [{ providerId: 'lyra', score: 1 }, { providerId: 'vega', score: 1 }], attempt: 1,
        scoring: [
          { providerId: 'orion', eligible: true, fee: usd(150), successRate: 0.985, latencyMs: 900, score: 0.9 },
          { providerId: 'lyra', eligible: true, fee: usd(200), successRate: 0.97, latencyMs: 1500, score: 0.8 },
          { providerId: 'vega', eligible: true, fee: usd(300), successRate: 0.95, latencyMs: 3000, score: 0.7 },
        ],
      },
      { reasonCodes: ['BEST_SCORE', 'LOWEST_FEE', 'FASTEST'] },
    ),
    evt('payment.sent', { providerId: 'orion', messageType: 'pacs.008', messageId: 'm1', attempt: 1 }),
    evt('payment.send_failed', { providerId: 'orion', attempt: 1, reasonCode: 'NARR', reason: 'Simulated rejection', statusMessage: 'pacs.002' }),
    evt('payment.routed', { providerId: 'lyra', rail: 'Rail-B', estimatedFee: usd(200), alternatives: [], attempt: 2, excludedProviders: ['orion'] }, { reasonCodes: ['RETRY_AFTER_FAILURE'] }),
    evt('payment.sent', { providerId: 'lyra', messageType: 'pacs.008', messageId: 'm2', attempt: 2 }),
    evt('payment.settled', { providerId: 'lyra', settlementRef: 's', statusMessage: 'pacs.002', settledAmount: inr(2075000), valueDate: '2026-10-26' }),
    evt('ledger.posted', { journalId: 'j', entries: [{ account: 'a', direction: 'debit', amount: usd(25000) }, { account: 'b', direction: 'credit', amount: usd(25000) }] }),
    evt('payment.reconciled', { statementRef: 'st', matched: true }),
  ];
}

describe('step explanations', () => {
  it('explains every step of a re-routed payment in plain English', () => {
    const steps = explainEvents(failedThenDelivered());
    expect(steps.map((s) => s.title)).toEqual([
      'Payment created',
      'Sanctions check passed',
      'Fraud check passed',
      'Exchange rate locked',
      'Provider Orion chosen',
      'Instruction sent',
      'Provider Orion refused it',
      'Re-routed to Provider Lyra',
      'Instruction sent',
      'Delivered',
      'Ledger balanced',
      'Reconciled',
    ]);
    expect(steps[0]!.body).toContain('Northwind Marketplace sends USD 250.00 to Asha Textiles');
    expect(steps[2]!.body).toContain('12 out of 100');
    expect(steps[3]!.body).toContain('USD 250.00 becomes INR 20,750.00 at 83.0000');
    expect(steps[3]!.body).toContain('0.30%');
    expect(steps[4]!.body).toContain('Out of 3 partners, Provider Orion won on the lowest fee and the fastest delivery');
    expect(steps[4]!.body).toContain('success rate 98.5%');
    expect(steps[6]).toMatchObject({ tone: 'warn', intent: 'outage_story' });
    expect(steps[6]!.body).toContain('NARR');
    expect(steps[7]!.body).toContain('Provider Orion refused it');
    expect(steps[10]).toMatchObject({ tone: 'ok', intent: 'ledger_proof' });
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
  });

  it('dedupes events and skips internal ones', () => {
    const list = failedThenDelivered();
    expect(explainEvents([...list, list[0]!])).toHaveLength(12);
    expect(explainEvent(evt('risk.alert_raised', { alertId: 'a', kind: 'fraud', severity: 'low', rule: 'r', summary: 's', reasons: [], evidence: {} }))).toBeNull();
  });

  it('flags unbalanced ledgers and failures', () => {
    const bad = evt('ledger.posted', { journalId: 'j', entries: [{ account: 'a', direction: 'debit', amount: usd(1) }, { account: 'b', direction: 'credit', amount: usd(2) }] });
    expect(explainEvent(bad)).toMatchObject({ title: 'Ledger posting', tone: 'warn' });
    expect(ledgerBalanced([bad])).toBe(false);
    expect(ledgerBalanced(failedThenDelivered())).toBe(true);
    expect(ledgerBalanced([])).toBe(false);
    expect(explainEvent(evt('payment.failed', { reason: 'Every provider refused', atStage: 'routing' }))).toMatchObject({ tone: 'bad' });
  });

  it('terminal states and outcomes', () => {
    expect(isTerminal('reconciled')).toBe(true);
    expect(isTerminal('settled')).toBe(false);
    expect(isTerminal('retrying')).toBe(false);
    expect(outcomeOf('reconciled')).toBe('delivered');
    expect(outcomeOf('failed')).toBe('failed');
    expect(outcomeOf('held')).toBe('held');
    expect(outcomeOf('sent')).toBe('unknown');
  });

  it('reveals at most one step per gap', () => {
    let r = revealNext(5, 0, 0, 1000, 1200);
    expect(r).toEqual({ shown: 1, lastRevealAt: 1000 });
    r = revealNext(5, r.shown, r.lastRevealAt, 1500, 1200);
    expect(r.shown).toBe(1);
    r = revealNext(5, r.shown, r.lastRevealAt, 2200, 1200);
    expect(r).toEqual({ shown: 2, lastRevealAt: 2200 });
    expect(revealNext(2, 2, 2200, 9999, 1200).shown).toBe(2);
    expect(revealNext(1, 3, 0, 0, 1200).shown).toBe(1);
  });

  it('ranks suggestions by the step topic', () => {
    const s = [
      { id: '1', text: 'What did FX cost?', intent: 'fx_cost' },
      { id: '2', text: 'Why this provider?', intent: 'why_route' },
      { id: '3', text: 'Is the ledger balanced?', intent: 'ledger_proof' },
      { id: '4', text: 'Why this provider?', intent: 'why_route' },
      { id: '5', text: 'What happened?', intent: 'overview' },
    ];
    expect(rankSuggestions(s, 'why_route').map((x) => x.id)).toEqual(['2', '1', '3', '5']);
    expect(rankSuggestions(s, undefined, 2).map((x) => x.id)).toEqual(['1', '2']);
  });

  it('formats citations and only shows verified answers', () => {
    expect(citationValue(usd(25000))).toBe('USD 250.00');
    expect(citationValue(0.123)).toBe('0.123');
    expect(citationValue(null)).toBe('—');
    expect(citationValue('x'.repeat(60))).toHaveLength(40);
    expect(visibleAnswer({ answer: ' Because. ', verified: true })).toBe('Because.');
    expect(visibleAnswer({ answer: 'Because 42.', verified: false })).toBeNull();
    expect(visibleAnswer(null)).toBeNull();
  });
});

describe('analytics batching', () => {
  const setup = (send: (e: AnalyticsEvent[]) => Promise<boolean> = async () => true) => {
    let t = Date.parse('2026-10-26T10:00:00Z');
    const sent: AnalyticsEvent[][] = [];
    let n = 0;
    const b = new AnalyticsBatcher({
      send: async (e) => {
        sent.push(e);
        return send(e);
      },
      now: () => t,
      batchSize: 3,
      maxQueue: 5,
      newId: () => `session_${++n}xxxxxx`,
    });
    return { b, sent, tick: (ms: number) => (t += ms) };
  };

  it('flushes when a batch is full and on demand', async () => {
    const { b, sent } = setup();
    b.startVisit();
    b.track('scenario.viewed', { scenarioId: 'send-payment' });
    expect(sent).toHaveLength(0);
    b.track('payment.sent', { corridor: 'US-IN' });
    await b.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((e) => e.type)).toEqual(['visit.start', 'scenario.viewed', 'payment.sent']);
    expect(sent[0]!.every((e) => e.sessionId === 'session_1xxxxxx')).toBe(true);
    b.track('cta.shown');
    await b.flush();
    expect(sent).toHaveLength(2);
    expect(b.pending).toHaveLength(0);
  });

  it('ends a visit with dwell time and a fresh session id', async () => {
    const { b, sent, tick } = setup();
    b.startVisit();
    b.startVisit(); // idempotent
    tick(95_400);
    await b.endVisit('idle');
    const all = sent.flat();
    expect(all.map((e) => e.type)).toEqual(['visit.start', 'visit.end']);
    expect(all[1]!.data).toEqual({ reason: 'idle', seconds: 95 });
    expect(b.sessionId).toBe('session_2xxxxxx');
    expect(b.visitOpen).toBe(false);
    b.track('visit.start');
    await b.flush();
    expect(sent.flat().at(-1)!.sessionId).toBe('session_2xxxxxx');
  });

  it('drops events when the booth is down (bounded, no retries)', async () => {
    const { b, sent } = setup(async () => false);
    for (let i = 0; i < 10; i++) b.track('cta.shown');
    await b.flush();
    expect(b.pending).toHaveLength(0);
    expect(b.dropped).toBe(10); // every event either failed to send or overflowed the queue
    expect(sent.flat().length).toBeLessThanOrEqual(10);
  });

  it('a disabled batcher records nothing', async () => {
    const { b, sent } = setup();
    b.enabled = false;
    b.track('cta.shown');
    await b.flush();
    expect(sent).toHaveLength(0);
  });

  it('session ids are random and match the booth format', () => {
    const a = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newSessionId()).not.toBe(a);
  });
});

describe('on-screen keyboard', () => {
  it('types, capitalises, deletes and limits to 300 characters', () => {
    let s = { text: '', shift: false };
    for (const k of ['w', 'h', 'y', 'space', 'space', 'shift', 'o', '?']) s = applyKey(s, k);
    expect(s.text).toBe('Why O?');
    s = applyKey(s, 'back');
    expect(s.text).toBe('Why O');
    expect(applyKey(s, 'clear')).toEqual({ text: '', shift: false });
    let long = { text: 'x'.repeat(QUESTION_MAX), shift: false };
    long = applyKey(long, 'a');
    expect(long.text).toHaveLength(QUESTION_MAX);
    expect(applyKey({ text: '', shift: false }, 'space').text).toBe('');
    expect(finalQuestion('  why   so  slow ')).toBe('why so slow');
  });
});

describe('lead form', () => {
  it('requires name, company, email, interest and consent', () => {
    const e = leadFormErrors(emptyLeadForm());
    expect(Object.keys(e).sort()).toEqual(['company', 'consent', 'email', 'interest', 'name']);
    expect(toLeadInput(emptyLeadForm(), 'k_abcdefgh')).toBeNull();
  });

  it('builds the booth body with literal consent and the exact consent sentence', () => {
    const f = { name: ' Ada ', company: 'Fictional Bank', email: 'ada@example.com ', role: '', interest: 'ai' as const, consent: true };
    expect(leadFormErrors(f)).toEqual({});
    expect(toLeadInput(f, 'k_abcdefgh')).toEqual({
      name: 'Ada', company: 'Fictional Bank', email: 'ada@example.com', interest: 'ai', consent: true, consentText: CONSENT_TEXT, sessionId: 'k_abcdefgh',
    });
    expect(toLeadInput({ ...f, consent: false }, undefined)).toBeNull();
    expect(leadFormErrors({ ...f, email: 'ada@example' }).email).toBeDefined();
    expect(CONSENT_TEXT).toContain('delete them after the event');
  });
});
