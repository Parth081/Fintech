// Context-aware suggested questions (4-6). Each one is phrased so classify() maps it to its intent
// (asserted in tests), and the scripted scenarios' questions are pre-answered into the cache.
import type { AskContext, SuggestedQuestion } from '@ct/contracts';
import type { Intent } from './intents';
import type { FactStore } from './store';

const q = (intent: Intent, text: string, slug: string): SuggestedQuestion => ({ id: `${intent}:${slug}`, text, intent });

export const SCENARIO_QUESTIONS: readonly SuggestedQuestion[] = [
  q('outage_story', 'What happened during the outage?', 'what-happened'),
  q('outage_story', 'How did the circuit breaker react?', 'breaker'),
  q('outage_story', 'Was any payment lost?', 'lost'),
  q('provider_health', 'How healthy are the providers now?', 'health'),
  q('ledger_proof', 'Does the ledger still balance?', 'ledger'),
  q('totals', 'How many payments ran during the scenario?', 'totals'),
];

export const SYSTEM_QUESTIONS: readonly SuggestedQuestion[] = [
  q('totals', 'How many payments have we processed?', 'count'),
  q('provider_health', 'How healthy are the providers?', 'health'),
  q('ledger_proof', 'Does the ledger balance?', 'ledger'),
  q('outage_story', 'What happened in the last scenario?', 'last-scenario'),
  q('provider_health', 'Which provider is most reliable?', 'reliable'),
];

export function suggestionsFor(store: FactStore, context: AskContext): SuggestedQuestion[] {
  if (context.kind === 'scenario') return [...SCENARIO_QUESTIONS];
  if (context.kind === 'system') return [...SYSTEM_QUESTIONS];
  const rec = store.payment(context.paymentId);
  const out: SuggestedQuestion[] = [q('payment_summary', 'What happened to this payment?', 'summary')];
  if (!rec) return [...out, q('how_long', 'How long did it take?', 'timeline'), ...SYSTEM_QUESTIONS.slice(0, 2)];
  const types = new Set(rec.events.map((x) => x.event.type));
  if (types.has('payment.held')) out.push(q('why_held', 'Why was this payment held?', 'held'));
  if (types.has('payment.rejected')) out.push(q('why_rejected', 'Why was it rejected?', 'rejected'));
  if (types.has('payment.send_failed')) out.push(q('why_retried', 'Why was it retried?', 'retried'));
  if (types.has('payment.routed')) out.push(q('why_this_route', 'Why this provider?', 'route'));
  if (types.has('payment.quoted')) out.push(q('fx_rate_and_cost', 'What did the FX cost?', 'fx'));
  out.push(q('how_long', 'How long did it take?', 'timeline'));
  if (types.has('ledger.posted')) out.push(q('ledger_proof', 'Does the ledger balance for this payment?', 'ledger'));
  if (out.length < 4) out.push(q('provider_health', 'How healthy are the providers?', 'health'));
  return out.slice(0, 6);
}

/** 2-4 follow-ups that are not the question just answered. */
export function followUpsFor(store: FactStore, context: AskContext, intent: string, question: string): string[] {
  const norm = question.trim().toLowerCase();
  return suggestionsFor(store, context)
    .filter((s) => s.intent !== intent && s.text.toLowerCase() !== norm)
    .slice(0, 3)
    .map((s) => s.text);
}
