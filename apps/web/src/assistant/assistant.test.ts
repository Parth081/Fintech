import { describe, expect, it } from 'vitest';
import type { Answer, Citation } from '@ct/contracts/browser';
import {
  askReducer,
  chipQuestions,
  citationChips,
  citationText,
  citationTitle,
  cleanQuestion,
  contextKey,
  contextParam,
  errorText,
  formatCitationValue,
  hidesPanel,
  initialAsk,
  MAX_QUESTION_CHARS,
  modeBadge,
  parseAnswer,
  parseSuggestions,
} from './assistant';

const answer = (over: Partial<Answer> = {}): Answer => ({
  question: 'Why was it re-routed?',
  context: { kind: 'payment', paymentId: 'pay_1' },
  answer: 'Orion refused it, so it went to Lyra.',
  citations: [],
  mode: 'grounded',
  verified: true,
  intent: 'why_route',
  followUps: [],
  latencyMs: 12,
  ...over,
});

describe('assistant helpers', () => {
  it('builds context params and keys', () => {
    expect(contextParam({ kind: 'payment', paymentId: 'pay_9' })).toBe('payment:pay_9');
    expect(contextParam({ kind: 'scenario' })).toBe('scenario');
    expect(contextParam({ kind: 'system' })).toBe('system');
    expect(contextKey(null)).toBe('');
  });

  it('cleans questions', () => {
    expect(cleanQuestion('  why\n  held?  ')).toBe('why held?');
    expect(cleanQuestion('   ')).toBeNull();
    expect(cleanQuestion('x'.repeat(400))).toHaveLength(MAX_QUESTION_CHARS);
  });

  it('hides the panel only for "no assistant here" statuses', () => {
    for (const s of [0, 404, 502, 503]) expect(hidesPanel(s)).toBe(true);
    for (const s of [400, 408, 429, 500]) expect(hidesPanel(s)).toBe(false);
    expect(errorText(429, '')).toMatch(/moment/);
    expect(errorText(408, 'Request timed out')).toMatch(/too long/);
  });

  it('parses suggestions defensively', () => {
    expect(parseSuggestions([{ id: 'a', text: ' Why held? ', intent: 'why_held' }, { text: 'why held?' }, { nope: 1 }, 'x', { text: 'Ledger?' }])).toEqual([
      { id: 'a', text: 'Why held?', intent: 'why_held' },
      { id: 's1', text: 'Ledger?', intent: 'unknown' },
    ]);
    expect(parseSuggestions({ suggestions: [{ text: 'Q' }] })).toHaveLength(1);
    expect(parseSuggestions(null)).toEqual([]);
  });

  it('parses answers defensively', () => {
    expect(parseAnswer(null)).toBeNull();
    expect(parseAnswer({ answer: '  ' })).toBeNull();
    const a = parseAnswer({ answer: ' Fine. ', mode: 'weird', citations: [{ field: 'x', label: 'L', value: 1 }, { bad: true }], followUps: ['a', 2, 'b', 'c', 'd', 'e'] }, 'q?', { kind: 'scenario' })!;
    expect(a).toMatchObject({ answer: 'Fine.', mode: 'grounded', question: 'q?', context: { kind: 'scenario' }, verified: false, intent: 'unknown' });
    expect(a.citations).toEqual([{ eventId: null, field: 'x', label: 'L', value: 1 }]);
    expect(a.followUps).toEqual(['a', 'b', 'c', 'd']);
    expect(parseAnswer(answer({ mode: 'llm' }))!.mode).toBe('llm');
  });

  it('formats citation chips from the record', () => {
    const fraud: Citation = { eventId: 'ev1', eventType: 'risk.scored', field: 'trace.inputs.fraudScore', value: 0.04, label: 'Fraud score' };
    expect(citationText(fraud)).toBe('Fraud score 0.04');
    expect(citationTitle(fraud)).toBe('From the record: risk.scored ev1 · trace.inputs.fraudScore');
    expect(citationTitle({ eventId: null, field: 'sum', value: 3, label: 'n', source: 'count of payments' })).toBe('From the record: computed: count of payments');
    expect(formatCitationValue({ amountMinor: 123456, currency: 'USD' })).toBe('USD 1,234.56');
    expect(formatCitationValue(true)).toBe('yes');
    expect(formatCitationValue(null)).toBe('—');
    expect(formatCitationValue(['orion', 'lyra'])).toBe('orion, lyra');
    expect(formatCitationValue('x'.repeat(60))).toHaveLength(48);
    expect(citationChips([fraud, { ...fraud, eventId: 'ev2' }, { ...fraud, value: 0.5 }], 5)).toHaveLength(2);
  });

  it('labels the answer mode subtly', () => {
    expect(modeBadge('grounded').label).toBe('Grounded');
    expect(modeBadge('llm').label).toBe('AI');
    expect(modeBadge('cached').label).toBe('Cached');
  });

  it('offers follow-ups first, then suggestions, without repeats or the question just asked', () => {
    const sug = [
      { id: '1', text: 'Why was it re-routed?', intent: 'why_route' },
      { id: '2', text: 'Is the ledger balanced?', intent: 'ledger_proof' },
      { id: '3', text: 'What did FX cost?', intent: 'fx_cost' },
    ];
    expect(chipQuestions(sug, null, 2)).toEqual(['Why was it re-routed?', 'Is the ledger balanced?']);
    expect(chipQuestions(sug, answer({ followUps: ['Which provider took it?', 'is the ledger balanced?'] }))).toEqual([
      'Which provider took it?',
      'is the ledger balanced?',
      'What did FX cost?',
    ]);
  });
});

describe('ask panel state', () => {
  it('asks, answers, and ignores stale responses', () => {
    let s = initialAsk('payment:p1');
    s = askReducer(s, { type: 'suggestions', key: 'payment:p1', suggestions: [{ id: 'a', text: 'Q', intent: 'x' }] });
    s = askReducer(s, { type: 'ask', question: 'first' });
    expect(s).toMatchObject({ status: 'loading', question: 'first', seq: 1 });
    s = askReducer(s, { type: 'ask', question: 'second' });
    expect(askReducer(s, { type: 'answer', seq: 1, answer: answer() })).toBe(s); // stale
    s = askReducer(s, { type: 'answer', seq: 2, answer: answer({ question: 'second' }) });
    expect(s).toMatchObject({ status: 'answered', answer: { question: 'second' } });
    expect(askReducer(s, { type: 'failed', seq: 1, status: 500, error: 'x' })).toBe(s);
    expect(askReducer(s, { type: 'clear' })).toMatchObject({ status: 'idle', answer: null, question: null, suggestions: [{ text: 'Q' }] });
  });

  it('shows retryable errors, hides when there is no assistant, and comes back when it appears', () => {
    let s = askReducer(initialAsk('system'), { type: 'ask', question: 'q' });
    expect(askReducer(s, { type: 'failed', seq: 1, status: 429, error: 'busy' })).toMatchObject({ status: 'error', error: 'busy' });
    s = askReducer(s, { type: 'failed', seq: 1, status: 502, error: 'down' });
    expect(s.status).toBe('hidden');
    expect(askReducer(s, { type: 'ask', question: 'again' })).toBe(s);
    s = askReducer(s, { type: 'context', key: 'scenario' });
    expect(s).toMatchObject({ status: 'hidden', key: 'scenario', seq: 1 });
    s = askReducer(s, { type: 'suggestions', key: 'other', suggestions: [] });
    expect(s.status).toBe('hidden'); // wrong key
    s = askReducer(s, { type: 'suggestions', key: 'scenario', suggestions: [] });
    expect(s.status).toBe('idle');
    // a suggestions failure that is not "absent" leaves the panel alone
    expect(askReducer(s, { type: 'failed', seq: null, status: 500, error: 'x' })).toBe(s);
  });

  it('starts over on a new context', () => {
    let s = askReducer(initialAsk('payment:a'), { type: 'ask', question: 'q' });
    s = askReducer(s, { type: 'answer', seq: 1, answer: answer() });
    const same = askReducer(s, { type: 'context', key: 'payment:a' });
    expect(same).toBe(s);
    expect(askReducer(s, { type: 'context', key: 'payment:b' })).toMatchObject({ key: 'payment:b', status: 'idle', answer: null, seq: 1 });
  });
});
