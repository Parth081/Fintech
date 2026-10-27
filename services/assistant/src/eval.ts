// Evaluation library (for tools/verify verify:m5): a bank of >= 100 questions per scenario run, each with
// key facts computed INDEPENDENTLY from the raw log (this file never uses the answer engine's views), and
// an evaluator: pass = answer.verified && every expected key fact appears in the answer text.
import {
  PROVIDERS,
  formatMoney,
  isControlEvent,
  type AnyEvent,
  type Answer,
  type AskContext,
  type BusEvent,
  type Money,
} from '@ct/contracts';
import type { Fact } from './facts';
import { extractNumbers, tokenMatches } from './verify';

export type KeyFact =
  | { kind: 'text'; value: string; label: string }
  | { kind: 'money'; value: Money; label: string }
  | { kind: 'count'; value: number; label: string }
  | { kind: 'bps'; value: number; label: string }
  | { kind: 'ms'; value: number; label: string };

export interface BankQuestion {
  id: string;
  question: string;
  context: AskContext;
  intent: string;
  expected: KeyFact[];
}

export interface QuestionResult {
  id: string;
  question: string;
  context: AskContext;
  intent: string;
  answerIntent: string;
  mode: string;
  pass: boolean;
  verified: boolean;
  missing: string[];
  answer: string;
}

export interface EvalReport {
  scenarioId: string;
  runId: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byIntent: Record<string, { total: number; passed: number }>;
  results: QuestionResult[];
  generatedAt: string;
}

const name = (id: string) => (PROVIDERS.find((p) => p.id === id)?.name ?? id).replace(/^Provider /, '');

const PHRASINGS: Record<string, string[]> = {
  payment_summary: ['What happened to this payment?', 'Can you explain this payment?', 'What is the status of this payment?', 'Tell me about this payment.'],
  why_held: ['Why was this payment held?', 'Why is this payment on hold?', 'Why did it go to manual review?'],
  why_rejected: ['Why was it rejected?', 'Why was this payment rejected?', 'Why was this transfer declined?'],
  why_this_route: ['Why this provider?', 'Why was it routed this way?', 'How did routing choose the provider?', 'Why not a cheaper partner?'],
  why_retried: ['Why was it retried?', 'Did a provider refuse it?', 'Why did the first attempt fail?', 'Was this payment retried?'],
  fx_rate_and_cost: ['What did the FX cost?', 'What exchange rate did it get?', 'How much was the spread and fee?', 'What was the total cost of this transfer?'],
  how_long: ['How long did it take?', 'How fast was this payment?', 'What does the timeline look like?'],
  ledger_proof: ['Does the ledger balance for this payment?', 'Show me the journal entries.', 'Prove the books balance for this payment.'],
};

const SCENARIO_PHRASINGS: Record<string, string[]> = {
  outage_story: [
    'What happened during the outage?', 'How did the circuit breaker react?', 'Was any payment lost?', 'Tell me the outage story.',
    'When did the breaker open?', 'How many payments were re-routed?', 'What happened in this scenario?', 'Did Orion recover?',
    'Explain the incident.', 'How did the system handle Orion going down?', 'Were payments lost during the outage?',
    'What did the breaker do?', 'How long was the outage?', 'Summarise the scenario.',
  ],
  provider_health: [
    'How healthy are the providers now?', 'Which provider is most reliable?', 'What is each provider\'s success rate?', 'How are the partners performing?',
    'Show provider health.', 'Is Lyra reliable?', 'How reliable was Vega during the run?', 'Provider success rates please.',
  ],
  ledger_proof: [
    'Does the ledger still balance?', 'Prove the ledger balances.', 'Is the trial balance correct?', 'Are debits equal to credits?',
    'Show me the ledger proof.', 'Did the books stay balanced?', 'Is every journal balanced?', 'How many journals were posted?',
  ],
  totals: [
    'How many payments ran during the scenario?', 'How many payments in total?', 'What was the total volume?', 'Give me the overall stats.',
    'How many payments were processed?', 'What is the payment count?', 'Total value reconciled?', 'Summary statistics please.',
  ],
};

interface RunWindow {
  runId: string;
  startIndex: number;
  endIndex: number;
}

function findRun(scenarioId: string, log: readonly BusEvent[]): RunWindow {
  let found: RunWindow | undefined;
  log.forEach((e, i) => {
    if (e.type === 'control.scenario.started' && e.payload.scenarioId === scenarioId) found = { runId: e.payload.runId, startIndex: i, endIndex: Number.POSITIVE_INFINITY };
    if (found && e.type === 'control.scenario.ended' && e.payload.runId === found.runId && found.endIndex === Number.POSITIVE_INFINITY) found.endIndex = i;
  });
  if (!found) throw new Error(`no run of scenario "${scenarioId}" in the log`);
  return found;
}

function groupPayments(log: readonly BusEvent[]): Map<string, { first: number; events: AnyEvent[] }> {
  const m = new Map<string, { first: number; events: AnyEvent[] }>();
  log.forEach((e, i) => {
    if (isControlEvent(e)) return;
    const p = e as AnyEvent;
    const g = m.get(p.paymentId) ?? { first: i, events: [] };
    if (!g.events.some((x) => x.eventId === p.eventId)) g.events.push(p);
    m.set(p.paymentId, g);
  });
  return m;
}

const last = <T extends AnyEvent['type']>(evs: AnyEvent[], t: T) => [...evs].reverse().find((e) => e.type === t) as Extract<AnyEvent, { type: T }> | undefined;
const all = <T extends AnyEvent['type']>(evs: AnyEvent[], t: T) => evs.filter((e) => e.type === t) as Extract<AnyEvent, { type: T }>[];

/** Expected key facts for a payment question, computed straight from the payment's events. */
function paymentExpected(intent: string, evs: AnyEvent[]): KeyFact[] {
  const init = evs[0] as Extract<AnyEvent, { type: 'payment.initiated' }>;
  const routed = last(evs, 'payment.routed');
  switch (intent) {
    case 'payment_summary':
      return [{ kind: 'money', value: init.payload.amount, label: 'amount' }];
    case 'why_held': {
      const h = last(evs, 'payment.held');
      return h ? [{ kind: 'text', value: h.payload.reason, label: 'hold reason' }] : [];
    }
    case 'why_rejected': {
      const r = last(evs, 'payment.rejected');
      return r ? [{ kind: 'text', value: r.payload.reason, label: 'rejection reason' }] : [];
    }
    case 'why_this_route':
      return routed ? [{ kind: 'text', value: name(routed.payload.providerId), label: 'chosen provider' }, { kind: 'money', value: routed.payload.estimatedFee, label: 'fee' }] : [];
    case 'why_retried': {
      const fails = all(evs, 'payment.send_failed');
      if (fails.length) return fails.slice(0, 3).map((f) => ({ kind: 'text' as const, value: f.payload.reasonCode, label: `reason code attempt ${f.payload.attempt}` }));
      return routed ? [{ kind: 'text', value: name(routed.payload.providerId), label: 'provider' }] : [];
    }
    case 'fx_rate_and_cost': {
      const q = last(evs, 'payment.quoted');
      if (!q) return [];
      const out: KeyFact[] = [
        { kind: 'text', value: q.payload.rate, label: 'customer rate' },
        { kind: 'bps', value: q.payload.spreadBps, label: 'spread' },
        { kind: 'money', value: q.payload.targetAmount, label: 'target amount' },
      ];
      if (routed) out.push({ kind: 'money', value: routed.payload.estimatedFee, label: 'fee' });
      return out;
    }
    case 'how_long': {
      const rec = last(evs, 'payment.reconciled');
      const end = rec ?? evs[evs.length - 1]!;
      return [{ kind: 'ms', value: Date.parse(end.occurredAt) - Date.parse(init.occurredAt), label: 'elapsed' }];
    }
    case 'ledger_proof': {
      const lp = last(evs, 'ledger.posted');
      return lp ? [{ kind: 'text', value: lp.payload.journalId, label: 'journal id' }] : [];
    }
    default:
      return [];
  }
}

function applicable(intent: string, evs: AnyEvent[]): boolean {
  const has = (t: AnyEvent['type']) => evs.some((e) => e.type === t);
  if (intent === 'why_held') return has('payment.held');
  if (intent === 'why_rejected') return has('payment.rejected');
  if (intent === 'why_this_route') return has('payment.routed');
  if (intent === 'fx_rate_and_cost') return has('payment.quoted');
  return true;
}

/** >= 100 questions about the latest run of `scenarioId` in `log`, with independently computed key facts. */
export function generateQuestionBank(scenarioId: string, log: readonly BusEvent[], opts: { min?: number } = {}): BankQuestion[] {
  const min = opts.min ?? 110;
  const run = findRun(scenarioId, log);
  const payments = [...groupPayments(log).entries()]
    .filter(([, g]) => g.first > run.startIndex && g.first < run.endIndex)
    .map(([id, g]) => ({ id, evs: g.events }));
  const bank: BankQuestion[] = [];

  // scenario-level facts
  const outageStarts = log.filter((e, i) => i >= run.startIndex && i <= run.endIndex && e.type === 'control.provider_outage.started') as Extract<BusEvent, { type: 'control.provider_outage.started' }>[];
  const journals = payments.flatMap((p) => p.evs.filter((e) => e.type === 'ledger.posted' || e.type === 'payment.refunded')).length;
  const lost = payments.filter((p) => {
    const posted = p.evs.some((e) => e.type === 'ledger.posted');
    const lastStatusFailed = p.evs.at(-1)?.type === 'payment.failed';
    const reconciled = p.evs.at(-1)?.type === 'payment.reconciled';
    return (lastStatusFailed && posted) || (reconciled && !posted);
  }).length;
  const settledBy = (pid: string) => payments.reduce((n, p) => n + p.evs.filter((e) => e.type === 'payment.settled' && e.payload.providerId === pid).length, 0);
  const scenarioExpected: Record<string, KeyFact[]> = {
    outage_story: [
      ...outageStarts.map((o) => ({ kind: 'text' as const, value: name(o.payload.providerId), label: 'provider with the outage' })),
      { kind: 'count', value: payments.length, label: 'payments in the run' },
      { kind: 'count', value: lost, label: 'payments lost' },
    ],
    provider_health: PROVIDERS.map((p) => ({ kind: 'count' as const, value: settledBy(p.id), label: `${p.id} settled` })),
    ledger_proof: [{ kind: 'count', value: journals, label: 'journals' }],
    totals: [{ kind: 'count', value: payments.length, label: 'payments' }],
  };
  for (const [intent, qs] of Object.entries(SCENARIO_PHRASINGS)) {
    qs.forEach((question, k) => bank.push({ id: `scenario:${intent}:${k}`, question, context: { kind: 'scenario' }, intent, expected: scenarioExpected[intent] ?? [] }));
  }

  // payment-level: cycle through payments (special ones first) until the bank is big enough
  const special = (p: { evs: AnyEvent[] }) => p.evs.some((e) => ['payment.held', 'payment.rejected', 'payment.send_failed', 'payment.failed'].includes(e.type)) ? 0 : 1;
  const ordered = [...payments].sort((a, b) => special(a) - special(b));
  let round = 0;
  while (bank.length < min && ordered.length > 0 && round < 20) {
    for (const p of ordered) {
      for (const [intent, phrasings] of Object.entries(PHRASINGS)) {
        if (!applicable(intent, p.evs)) continue;
        const question = phrasings[(round + p.id.charCodeAt(0)) % phrasings.length]!;
        bank.push({ id: `payment:${p.id}:${intent}:${round}`, question, context: { kind: 'payment', paymentId: p.id }, intent, expected: paymentExpected(intent, p.evs) });
      }
      if (bank.length >= min) break;
    }
    round += 1;
  }
  return bank;
}

/** Is a key fact present in the answer text? (Uses the published formatting/rounding rules.) */
export function keyFactPresent(answer: string, k: KeyFact): boolean {
  if (k.kind === 'text') return answer.toLowerCase().includes(k.value.toLowerCase());
  const tokens = extractNumbers(answer, k.kind === 'money' ? [k.value.currency] : []);
  const fact: Fact = { eventId: null, field: 'expected', label: k.label, value: k.value, kind: k.kind === 'money' ? 'money' : k.kind };
  if (k.kind === 'money' && answer.includes(formatMoney(k.value))) return true;
  return tokens.some((t) => tokenMatches(t, fact));
}

export type AnswerFn = (question: string, context: AskContext) => Promise<Answer> | Answer;

/** Ask every question and grade it: pass = verified && all expected key facts present in the answer. */
export async function evaluate(answerFn: AnswerFn, bank: readonly BankQuestion[], meta: { scenarioId?: string; runId?: string } = {}): Promise<EvalReport> {
  const results: QuestionResult[] = [];
  const byIntent: EvalReport['byIntent'] = {};
  for (const q of bank) {
    const a = await answerFn(q.question, q.context);
    const missing = q.expected.filter((k) => !keyFactPresent(a.answer, k)).map((k) => k.label);
    const pass = a.verified === true && missing.length === 0 && a.intent !== 'unknown';
    results.push({ id: q.id, question: q.question, context: q.context, intent: q.intent, answerIntent: a.intent, mode: a.mode, pass, verified: a.verified, missing, answer: a.answer });
    const b = (byIntent[q.intent] ??= { total: 0, passed: 0 });
    b.total += 1;
    if (pass) b.passed += 1;
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    scenarioId: meta.scenarioId ?? '',
    runId: meta.runId ?? '',
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    byIntent,
    results,
    generatedAt: new Date().toISOString(),
  };
}

/** Run id of the latest run of a scenario in a log (for report metadata). */
export function latestRunId(scenarioId: string, log: readonly BusEvent[]): string {
  return findRun(scenarioId, log).runId;
}
