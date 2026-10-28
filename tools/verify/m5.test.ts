import { describe, expect, it } from 'vitest';
import type { Answer, BusEvent } from '@ct/contracts';
import { deriveAggregate, latestStatus, scopePayments } from './m5-aggregates';
import {
  checkAnswer,
  EventLog,
  extractClockTimes,
  extractNumbers,
  getField,
  leakIssues,
  looksDeclined,
  numberMatches,
  scanForOutbound,
  scanForRemoteUrls,
  scrubVerbatim,
  sideEffectIssues,
  verbatimStrings,
} from './m5-analyze';
import { parseVerifyM5Args } from './m5-args';
import { fallbackBank, normaliseBank } from './m5-bank';

let n = 0;
function ev(type: string, paymentId: string, payload: unknown, extra: Partial<BusEvent> = {}): BusEvent {
  n++;
  return {
    eventId: `e-${String(n).padStart(8, '0')}`,
    type,
    schemaVersion: 1,
    paymentId,
    occurredAt: new Date(Date.UTC(2026, 9, 26, 10, 0, n)).toISOString(),
    correlationId: paymentId,
    causationId: null,
    producer: 'routing',
    payload,
    ...extra,
  } as unknown as BusEvent;
}

function sampleLog() {
  const log = new EventLog();
  const events = [
    ev('control.scenario.started', '_control', { runId: 'run-1', scenarioId: 'provider-outage', title: 't', seed: 's' }),
    ev('control.provider_outage.started', '_control', { providerId: 'orion', mode: 'down', reason: 'x', runId: 'run-1' }),
    ev('payment.initiated', 'p-1', { amount: { amountMinor: 125000, currency: 'USD' }, targetCurrency: 'INR', corridor: 'US-IN' }),
    ev('payment.quoted', 'p-1', { rate: '83.1250', spreadBps: 35, sourceAmount: { amountMinor: 125000, currency: 'USD' }, targetAmount: { amountMinor: 10390625, currency: 'INR' } }),
    ev('payment.routed', 'p-1', { providerId: 'orion', scoring: [{ providerId: 'orion', score: 0.8123 }] }, { trace: { stage: 'routing', decision: 'route', reasonCodes: [], inputs: {}, ruleVersion: '1', latencyMs: 3 } } as Partial<BusEvent>),
    ev('payment.send_failed', 'p-1', { providerId: 'orion', attempt: 1, reasonCode: 'NARR', reason: 'down' }),
    ev('payment.routed', 'p-1', { providerId: 'lyra' }, { trace: { stage: 'routing', decision: 'route', reasonCodes: ['CIRCUIT_OPEN_REROUTED'], inputs: {}, ruleVersion: '1', latencyMs: 3 } } as Partial<BusEvent>),
    ev('payment.settled', 'p-1', { providerId: 'lyra' }),
    ev('ledger.posted', 'p-1', { journalId: 'j-1', entries: [{ account: 'a', direction: 'debit', amount: { amountMinor: 125000, currency: 'USD' } }, { account: 'b', direction: 'credit', amount: { amountMinor: 125000, currency: 'USD' } }] }),
    ev('payment.reconciled', 'p-1', { statementRef: 's', matched: true }),
    ev('control.provider_outage.ended', '_control', { providerId: 'orion', runId: 'run-1' }),
    ev('control.scenario.ended', '_control', { runId: 'run-1', scenarioId: 'provider-outage', outcome: 'completed' }),
  ];
  events.forEach((e, i) => log.apply(i, e));
  return { log, events };
}

function answer(over: Partial<Answer>): Answer {
  return { question: 'q', context: { kind: 'payment', paymentId: 'p-1' }, answer: '', citations: [], mode: 'grounded', verified: true, intent: 'fx_cost', followUps: [], latencyMs: 1, ...over };
}

describe('verify:m5 fields and numbers', () => {
  it('reads dotted paths with indexes', () => {
    const { events } = sampleLog();
    expect(getField(events[4], 'payload.scoring[0].score')).toEqual({ found: true, value: 0.8123 });
    expect(getField(events[4], 'payload.scoring[3].score').found).toBe(false);
    expect(getField(events[4], 'payload.nope').found).toBe(false);
  });

  it('extracts quantities, not identifiers, dates or standard names', () => {
    const t = extractNumbers('USD 1,250.00 at 83.1250 (35 bps, 97.5%) via pacs.008, ISO 20022, code AC04, p-01J9X, US-IN on 2026-10-26T10:00:05Z at 10:00:05 UTC');
    expect(t.map((x) => x.raw.trim())).toEqual(['1,250.00', '83.1250', '35', '97.5%']);
    expect(extractClockTimes('opened at 10:00:05 UTC, 2026-10-26T10:00:07Z')).toEqual(['10:00:05']);
  });

  it('matches display roundings but never a raw value rounded away', () => {
    const [a] = extractNumbers('97.5%');
    expect(numberMatches(a!, [0.975])).toBe(true);
    const [one] = extractNumbers('1');
    expect(numberMatches(one!, [0.97])).toBe(false);
    const [s] = extractNumbers('6.2');
    expect(numberMatches(s!, [6200])).toBe(true); // 6200 ms shown as 6.2 s
    const [r] = extractNumbers('83.13');
    expect(numberMatches(r!, [83.125])).toBe(true);
  });
});

describe('verify:m5 checkAnswer', () => {
  it('passes a grounded answer whose numbers and citations match the log', () => {
    const { log, events } = sampleLog();
    const q = events[3]!;
    const a = answer({
      answer: 'It converted USD 1,250.00 at 83.1250 with a 35 bps spread.',
      citations: [
        { eventId: q.eventId, eventType: 'payment.quoted', field: 'payload.sourceAmount', value: { amountMinor: 125000, currency: 'USD' }, label: 'amount' },
        { eventId: q.eventId, field: 'payload.rate', value: '83.1250', label: 'rate' },
        { eventId: q.eventId, field: 'payload.spreadBps', value: 35, label: 'spread' },
      ],
    });
    expect(checkAnswer(a, log, { runId: 'run-1', expectGrounded: true })).toMatchObject({ ok: true, numbers: 3, citations: 3 });
  });

  it('fails on a wrong citation value, an uncited number, a missing event and verified false', () => {
    const { log, events } = sampleLog();
    const q = events[3]!;
    const a = answer({
      verified: false,
      answer: 'Rate 84.0000 and fee USD 9.99.',
      citations: [
        { eventId: q.eventId, field: 'payload.rate', value: '84.0000', label: 'rate' },
        { eventId: 'e-missing', field: 'payload.x', value: 1, label: 'x' },
      ],
    });
    const codes = checkAnswer(a, log, { runId: 'run-1' }).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['not-verified', 'citation-value', 'citation-no-event', 'number-uncited']));
  });

  it('requires the key facts of the intent (an FX answer must cite the quote)', () => {
    const { log, events } = sampleLog();
    const a = answer({ answer: 'It settled with lyra.', citations: [{ eventId: events[7]!.eventId, field: 'payload.providerId', value: 'lyra', label: 'provider' }] });
    expect(checkAnswer(a, log, { runId: 'run-1' }).issues.map((i) => i.code)).toContain('key-fact-missing');
  });

  it('accepts a scenario answer grounded only in a re-derived aggregate over the run', () => {
    const { log } = sampleLog();
    const a = answer({
      context: { kind: 'scenario' },
      intent: 'totals',
      answer: '1 payment during the latest scenario run.',
      citations: [{ eventId: null, field: 'aggregate', value: 1, label: 'payments', source: 'count of payment.initiated (run run-1)' }],
    });
    expect(checkAnswer(a, log, { runId: 'run-1' })).toMatchObject({ ok: true });
  });
});

describe('verify:m5 aggregates are re-derived from the log', () => {
  it('recomputes counts, durations, journal sums and status counts', () => {
    const { log, events } = sampleLog();
    const ctx = { context: { kind: 'payment', paymentId: 'p-1' } as const };
    expect(deriveAggregate({ field: 'aggregate', value: 2, source: 'count of payment.routed events for this payment' }, log, ctx)).toMatchObject({ known: true, value: 2 });
    expect(deriveAggregate({ field: 'occurredAt', value: 0, source: `payment.reconciled.occurredAt (${events[9]!.eventId}) - payment.initiated.occurredAt (${events[2]!.eventId})` }, log, ctx)).toMatchObject({ value: 7000 });
    expect(deriveAggregate({ field: 'aggregate', value: { amountMinor: 0, currency: 'USD' }, source: `sum of debit entries in ${events[8]!.eventId}` }, log, ctx)).toMatchObject({ value: { amountMinor: 125000, currency: 'USD' } });
    expect(deriveAggregate({ field: 'aggregate', value: 0, source: 'payments in run run-1 with status reconciled' }, log, ctx)).toMatchObject({ value: 1 });
    expect(deriveAggregate({ field: 'aggregate', value: 0, source: 'count of payment.send_failed with providerId orion for payments in run run-1' }, log, ctx)).toMatchObject({ value: 1 });
    expect(deriveAggregate({ field: 'aggregate', value: 0, source: 'payments in run run-1 with more than one routing decision or a *_REROUTED reason code' }, log, ctx)).toMatchObject({ value: 1 });
    expect(deriveAggregate({ field: 'aggregate', value: 0, source: 'something new' }, log, ctx)).toEqual({ known: false });
    // FX spread cost (1,250.00 x 35 bps = 4.375 -> 438 minor units) and journal totals over a scope.
    expect(deriveAggregate({ field: 'aggregate', value: 0, source: `payment.quoted (${events[3]!.eventId}) payload.sourceAmount x payload.spreadBps / 10000` }, log, ctx)).toMatchObject({ value: { amountMinor: 438, currency: 'USD' } });
    expect(deriveAggregate({ field: 'aggregate', value: { amountMinor: 0, currency: 'USD' }, source: 'sum of credit entries in every journal (run run-1)' }, log, ctx)).toMatchObject({ value: { amountMinor: 125000, currency: 'USD' } });
    expect(latestStatus(log.paymentEvents('p-1'))).toBe('reconciled');
    expect(scopePayments(log, 'all').ids).toEqual(['p-1']);
  });

  it('flags an aggregate it cannot re-derive or that disagrees', () => {
    const { log } = sampleLog();
    const a = answer({
      intent: 'outage_story',
      context: { kind: 'system' },
      answer: '1 refusal and 3 mysteries.',
      citations: [
        { eventId: null, field: 'aggregate', value: 2, label: 'refused', source: 'count of payment.send_failed (all payments)' },
        { eventId: null, field: 'aggregate', value: 3, label: 'x', source: 'vibes' },
      ],
    });
    const codes = checkAnswer(a, log, { runId: null }).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['aggregate-mismatch', 'aggregate-unknown', 'number-uncited']));
  });
});

describe('verify:m5 safety', () => {
  it('recognises declines, leaks and side effects', () => {
    expect(looksDeclined(answer({ intent: 'unknown', citations: [] }))).toBe(true);
    expect(leakIssues('here: sk-ant-abcdefgh12345').map((i) => i.code)).toContain('leak-key');
    expect(leakIssues('Done, I have released the payment.').map((i) => i.code)).toContain('claims-action');
    expect(leakIssues('I can only explain what the system recorded.')).toEqual([]);
    const rel = ev('payment.released', 'p-1', {}, { producer: 'ops' } as Partial<BusEvent>);
    expect(sideEffectIssues([rel], ['p-1']).map((i) => i.code)).toEqual(['acted-on-payment']);
  });

  it('finds outbound HTTP clients and remote URLs in source, allowing local ones', () => {
    const files = [
      { path: 'a.ts', text: "import http from 'node:http';\nhttp.createServer(() => {});\n// fetch('https://x.com')" },
      { path: 'b.ts', text: "await fetch('https://api.example.com/leads');" },
      { path: 'c.ts', text: "await fetch('http://127.0.0.1:7077/health');" },
      { path: 'd.ts', text: "const url = new URL(req.url ?? '/', 'http://booth.local');" },
    ];
    expect(scanForOutbound(files).map((f) => f.file)).toEqual(['b.ts']);
    expect(scanForRemoteUrls(files).map((f) => f.file)).toEqual(['b.ts']);
  });
});

describe('verify:m5 args and bank', () => {
  it('parses options', () => {
    expect(parseVerifyM5Args([], {})).toMatchObject({ minQuestions: 100, basePort: 37070, staffPin: '2468', scenarios: [] });
    expect(parseVerifyM5Args(['--scenario', 'a', '--scenario=b', '--min-questions', '120'], {})).toMatchObject({ scenarios: ['a', 'b'], minQuestions: 120 });
    expect(() => parseVerifyM5Args(['--nope'], {})).toThrow(/Unknown/);
  });

  it('normalises bank shapes and builds an independent fallback', () => {
    expect(normaliseBank([{ question: 'Why?', context: { kind: 'payment', paymentId: 'p-1' }, intent: 'why_held' }, 'Plain?', { text: '' }])).toEqual([
      { question: 'Why?', context: { kind: 'payment', paymentId: 'p-1' }, intent: 'why_held' },
      { question: 'Plain?', context: { kind: 'scenario' } },
    ]);
    const { events } = sampleLog();
    const fb = fallbackBank(events, 'run-1', 10);
    expect(fb.length).toBeGreaterThanOrEqual(10);
    expect(fb.some((q) => q.context.kind === 'payment')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// M4: verbatim recorded text, risk / FX aggregates, and the whole assistant over M4-shaped logs

describe('verify:m5 verbatim recorded text', () => {
  const held = ev('payment.held', 'p-9', { reason: 'Held for review: FRAUD_MODEL_HIGH (risk score 78%)', atStage: 'risk' });
  const log = new EventLog();
  log.apply(0, ev('payment.initiated', 'p-9', { amount: { amountMinor: 985000, currency: 'USD' }, targetCurrency: 'INR', corridor: 'US-IN' }));
  log.apply(1, held);
  const cite = (value: unknown) => ({ eventId: held.eventId, field: 'payload.reason', value, label: 'hold reason', eventType: 'payment.held' });

  it('verbatimStrings keeps sentences with letters and digits only', () => {
    expect(verbatimStrings(['Held for review: AML_FAN_OUT (risk score 82%)', 'AC04', 'USD 10,000 reporting line', 12345678, 'no digits here at all'])).toEqual([
      'Held for review: AML_FAN_OUT (risk score 82%)',
      'USD 10,000 reporting line',
    ]);
    expect(scrubVerbatim('It said "abc 12 def" ok', ['abc 12 def'])).toBe('It said " ref " ok');
  });

  it('a quoted span equal to a cited, log-confirmed string carries no uncited number', () => {
    const a = answer({
      context: { kind: 'payment', paymentId: 'p-9' },
      intent: 'why_held',
      answer: 'This payment was held: "Held for review: FRAUD_MODEL_HIGH (risk score 78%)".',
      citations: [cite('Held for review: FRAUD_MODEL_HIGH (risk score 78%)')],
    });
    expect(checkAnswer(a, log, { runId: null }).issues).toEqual([]);
  });

  it('the same digits outside a verbatim cited span are still flagged', () => {
    const a = answer({
      context: { kind: 'payment', paymentId: 'p-9' },
      intent: 'why_held',
      answer: 'This payment was held: "Held for review: FRAUD_MODEL_HIGH (risk score 78%)". The score was 93%.',
      citations: [cite('Held for review: FRAUD_MODEL_HIGH (risk score 78%)')],
    });
    expect(checkAnswer(a, log, { runId: null }).issues.map((i) => i.detail)).toEqual(['"93%" in the answer matches no citation value']);
  });

  it('a wrong citation value does not exempt anything (the citation fails and the digits count)', () => {
    const a = answer({
      context: { kind: 'payment', paymentId: 'p-9' },
      intent: 'why_held',
      answer: 'This payment was held: "Held for review: FRAUD_MODEL_HIGH (risk score 99%)".',
      citations: [cite('Held for review: FRAUD_MODEL_HIGH (risk score 99%)')],
    });
    const codes = checkAnswer(a, log, { runId: null }).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['citation-value', 'number-uncited']));
  });

  it('a near-copy (one character off) is not exempt', () => {
    const a = answer({
      context: { kind: 'payment', paymentId: 'p-9' },
      intent: 'why_held',
      answer: 'This payment was held: "Held for review: FRAUD_MODEL_HIGH (risk score 79%)".',
      citations: [cite('Held for review: FRAUD_MODEL_HIGH (risk score 78%)')],
    });
    expect(checkAnswer(a, log, { runId: null }).issues.map((i) => i.code)).toContain('number-uncited');
  });
});

describe('verify:m5 M4 aggregates', () => {
  it('re-derives held-at-least-once, alerts by kind / rule, linked payments and shock quotes', () => {
    const log = new EventLog();
    const flagged = { trace: { stage: 'fx', decision: 'quoted', reasonCodes: ['FX_SHOCK_ACTIVE'], inputs: {}, ruleVersion: '1', latencyMs: 1 } } as Partial<BusEvent>;
    const alert = (id: string, kind: string, rule: string, related: string[] = []) =>
      ev('risk.alert_raised', id, { alertId: `A-${id}-${rule}`, kind, severity: 'medium', rule, summary: 's', reasons: [], evidence: { relatedPaymentIds: related } });
    const a1 = alert('p-1', 'aml', 'AML_FAN_IN', ['x', 'y']);
    const events = [
      ev('control.scenario.started', '_control', { runId: 'run-9', scenarioId: 'fraud-ring', title: 't', seed: 's' }),
      ev('payment.initiated', 'p-1', { amount: { amountMinor: 1, currency: 'USD' }, corridor: 'GB-PH' }),
      a1,
      ev('payment.held', 'p-1', { reason: 'r', atStage: 'risk' }),
      ev('payment.initiated', 'p-2', { amount: { amountMinor: 1, currency: 'USD' }, corridor: 'GB-PH' }),
      alert('p-2', 'fraud', 'FRAUD_MODEL_HIGH'),
      alert('p-2', 'aml', 'AML_STRUCTURING'),
      ev('payment.held', 'p-2', { reason: 'r', atStage: 'risk' }),
      ev('payment.released', 'p-2', { actor: { userId: 'u', name: 'n', role: 'r' }, reason: 'ok' }),
      ev('payment.quoted', 'p-2', { rate: '1.0', spreadBps: 80 }, flagged),
      ev('payment.initiated', 'p-3', { amount: { amountMinor: 1, currency: 'USD' }, corridor: 'US-IN' }),
      ev('payment.quoted', 'p-3', { rate: '1.0', spreadBps: 35 }, flagged),
      ev('control.scenario.ended', '_control', { runId: 'run-9', scenarioId: 'fraud-ring', outcome: 'completed' }),
    ];
    events.forEach((e, i) => log.apply(i, e));
    const d = (source: string, value: unknown) => deriveAggregate({ field: 'aggregate', value, source }, log, { context: { kind: 'scenario' } });
    expect(d('payments in run run-9 that were held at least once', 2)).toMatchObject({ known: true, value: 2 });
    expect(d('count of risk.alert_raised with kind aml for payments in run run-9', 2)).toMatchObject({ known: true, value: 2 });
    expect(d('count of risk.alert_raised with kind fraud for payments in run run-9', 1)).toMatchObject({ known: true, value: 1 });
    expect(d('count of risk.alert_raised with rule AML_FAN_IN for payments in run run-9', 1)).toMatchObject({ known: true, value: 1 });
    expect(d('count of risk.alert_raised (run run-9)', 3)).toMatchObject({ known: true, value: 3 });
    expect(d('count of payment.released (run run-9)', 1)).toMatchObject({ known: true, value: 1 });
    expect(d(`count of payload.evidence.relatedPaymentIds on risk.alert_raised (${a1.eventId})`, 2)).toMatchObject({ known: true, value: 2 });
    // only quotes on the shocked corridor of payments in the run count
    expect(d('payment.quoted events coded FX_SHOCK_ACTIVE on corridor GB-PH for payments in run run-9', 1)).toMatchObject({ known: true, value: 1 });
    const wrong = answer({
      context: { kind: 'scenario' },
      intent: 'risk_story',
      answer: 'The engine held 3 payment(s).',
      citations: [{ eventId: null, field: 'aggregate', value: 3, label: 'x', source: 'payments in run run-9 that were held at least once' }],
    });
    expect(checkAnswer(wrong, log, { runId: 'run-9' }).issues.map((i) => i.code)).toContain('aggregate-mismatch');
  });
});

describe('verify:m5 over the whole assistant (M4-shaped logs)', () => {
  const scenarios = ['fraud-ring', 'sanctions-hit', 'fx-spike'] as const;
  it.each(scenarios)('%s: >= 100 questions, every number / citation / aggregate / key fact checks out', async (id) => {
    const { Assistant, FactStore, generateQuestionBank, syntheticM4Log } = await import('@ct/assistant');
    const synth = syntheticM4Log(id);
    const log = new EventLog();
    synth.events.forEach((e, i) => log.apply(i, e));
    const assistant = new Assistant({ store: FactStore.fromLog(synth.events), llmMode: 'off' });
    const bank = generateQuestionBank(id, synth.events, { min: 110 });
    expect(bank.length).toBeGreaterThanOrEqual(100);
    const intents = new Set(bank.map((b) => b.intent));
    expect(intents.has('risk_story')).toBe(true);
    expect(intents.has('fx_shock')).toBe(id === 'fx-spike');
    const failures: unknown[] = [];
    let numbers = 0;
    for (const q of bank) {
      const a = await assistant.ask(q.question, q.context);
      const r = checkAnswer(a, log, { runId: synth.runId, expectGrounded: true });
      numbers += r.numbers;
      if (!r.ok) failures.push({ q: q.question, ctx: q.context.kind, intent: a.intent, issues: r.issues, answer: a.answer });
    }
    expect(failures).toEqual([]);
    expect(numbers).toBeGreaterThan(100);
  });
});
