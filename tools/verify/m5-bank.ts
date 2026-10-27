// verify:m5 question bank. Prefers the assistant's own bank (services/assistant: generateQuestionBank(scenarioId,
// log)); falls back to a small independent generator built from the log when the library is not available, and
// says so in the report. Either way the EXPECTED facts are re-derived by m5-analyze.ts, never taken from the bank.
import type { AskContext, BusEvent } from '@ct/contracts';

export interface BankQuestion {
  question: string;
  context: AskContext;
  /** Intent the bank meant to exercise (informational). */
  intent?: string;
}

export interface Bank {
  source: 'assistant' | 'fallback';
  note?: string;
  questions: BankQuestion[];
}

function isContext(v: unknown): v is AskContext {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { kind?: unknown }).kind;
  return k === 'system' || k === 'scenario' || (k === 'payment' && typeof (v as { paymentId?: unknown }).paymentId === 'string');
}

/** Accepts the bank in the shapes the assistant may return: strings, {question|text, context?, intent?}. */
export function normaliseBank(raw: unknown): BankQuestion[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { questions?: unknown }).questions) ? (raw as { questions: unknown[] }).questions : [];
  const out: BankQuestion[] = [];
  for (const item of list) {
    if (typeof item === 'string') out.push({ question: item, context: { kind: 'scenario' } });
    else if (item && typeof item === 'object') {
      const q = (item as { question?: unknown; text?: unknown }).question ?? (item as { text?: unknown }).text;
      if (typeof q !== 'string' || q.trim() === '') continue;
      const ctx = (item as { context?: unknown }).context;
      const intent = (item as { intent?: unknown }).intent;
      out.push({ question: q, context: isContext(ctx) ? ctx : { kind: 'scenario' }, ...(typeof intent === 'string' ? { intent } : {}) });
    }
  }
  return out;
}

type BankFn = (scenarioId: string, log: BusEvent[], opts?: { min?: number }) => unknown;

/** Load generateQuestionBank from @ct/assistant, or explain why not. */
export async function loadAssistantBank(): Promise<{ fn: BankFn | null; why?: string }> {
  try {
    const mod = (await import('@ct/assistant')) as Record<string, unknown>;
    const fn = mod.generateQuestionBank;
    if (typeof fn !== 'function') return { fn: null, why: '@ct/assistant does not export generateQuestionBank yet' };
    return { fn: fn as BankFn };
  } catch (err) {
    return { fn: null, why: `@ct/assistant could not be imported: ${(err as Error).message.split('\n')[0]}` };
  }
}

export async function buildBank(scenarioId: string, log: BusEvent[], runId: string | null, min: number): Promise<Bank> {
  const { fn, why } = await loadAssistantBank();
  if (fn) {
    const questions = normaliseBank(await fn(scenarioId, log, { min }));
    return { source: 'assistant', questions };
  }
  return { source: 'fallback', note: why, questions: fallbackBank(log, runId, min) };
}

/** Independent fallback: questions about real payments of the run, the scenario and the system. */
export function fallbackBank(log: readonly BusEvent[], runId: string | null, min: number): BankQuestion[] {
  let from = 0;
  let to = log.length - 1;
  if (runId) {
    const s = log.findIndex((e) => e.type === 'control.scenario.started' && (e.payload as { runId?: string }).runId === runId);
    const e = log.findIndex((x) => x.type === 'control.scenario.ended' && (x.payload as { runId?: string }).runId === runId);
    if (s >= 0) from = s;
    if (e >= 0) to = e;
  }
  const window = log.slice(from, to + 1);
  const ids = (type: string) => [...new Set(window.filter((e) => e.type === type).map((e) => e.paymentId))];
  const held = ids('payment.held');
  const failedOnce = ids('payment.send_failed');
  const settled = ids('payment.settled');
  const quoted = ids('payment.quoted');
  const qs: BankQuestion[] = [];
  const scen: AskContext = { kind: 'scenario' };
  const sys: AskContext = { kind: 'system' };
  for (const q of [
    'What happened during this scenario?',
    'Which provider had a problem?',
    'How long was the provider down?',
    'How many payments were re-routed?',
    'Did we lose any payments?',
    'How many payments were reconciled during the run?',
    'How many instructions did the provider refuse?',
    'When did the circuit breaker open?',
  ]) qs.push({ question: q, context: scen, intent: 'outage_story' });
  for (const q of ['Does the ledger balance?', 'How many payments have we processed?', 'How healthy are the providers?', 'What is the average time to reconcile?']) {
    qs.push({ question: q, context: sys });
  }
  const per = (pid: string, list: string[]) => list.map((question) => ({ question, context: { kind: 'payment', paymentId: pid } as AskContext }));
  const pools: [string[], string[]][] = [
    [held, ['Why was this payment held?', 'What did the risk check find?']],
    [failedOnce, ['Why was this payment re-routed?', 'Which provider refused it and why?', 'Why did routing choose this provider?']],
    [quoted, ['What FX rate did this payment get?', 'How much did the FX conversion cost?']],
    [settled, ['What happened to this payment?', 'How long did this payment take?', 'Is this payment in the ledger?']],
  ];
  for (let round = 0; (qs.length < min || round < 3) && round < 400; round++) {
    let added = false;
    for (const [pool, questions] of pools) {
      const pid = pool[round];
      if (pid) {
        qs.push(...per(pid, questions));
        added = true;
      }
    }
    if (!added) break;
  }
  return qs;
}
