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

/** Scripted questions for the risk scenarios (fraud ring, sanctions hit). */
export const RISK_SCENARIO_QUESTIONS: readonly SuggestedQuestion[] = [
  q('outage_story', 'What happened in this scenario?', 'what-happened'),
  q('risk_story', 'How many payments were held and why?', 'held'),
  q('risk_story', 'Which alerts did the risk engine raise?', 'alerts'),
  q('risk_story', 'Which sanctions list entries matched?', 'sanctions'),
  q('ledger_proof', 'Does the ledger still balance?', 'ledger'),
  q('totals', 'How many payments ran during the scenario?', 'totals'),
];

/** Scripted questions for the FX spike scenario. */
export const FX_SCENARIO_QUESTIONS: readonly SuggestedQuestion[] = [
  q('outage_story', 'What happened in this scenario?', 'what-happened'),
  q('fx_shock', 'What happened to rates and spreads during the shock?', 'shock'),
  q('fx_shock', 'How wide was the spread before and after the spike?', 'spread'),
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

/** The scripted scenario questions for the latest run: outage by default, risk or FX when the run was one. */
export function scenarioQuestions(store: FactStore): SuggestedQuestion[] {
  const run = store.latestRun();
  if (run) {
    const control = store.controlInRun(run);
    if (control.some((c) => c.event.type === 'control.fx_shock.started')) return [...FX_SCENARIO_QUESTIONS];
    if (control.some((c) => c.event.type === 'control.provider_outage.started')) return [...SCENARIO_QUESTIONS];
    for (const p of store.paymentsInRun(run)) {
      if (p.events.some((x) => x.event.type === 'risk.alert_raised' || x.event.type === 'payment.held')) return [...RISK_SCENARIO_QUESTIONS];
    }
  }
  return [...SCENARIO_QUESTIONS];
}

export function suggestionsFor(store: FactStore, context: AskContext): SuggestedQuestion[] {
  if (context.kind === 'scenario') return scenarioQuestions(store);
  if (context.kind === 'system') return [...SYSTEM_QUESTIONS];
  const rec = store.payment(context.paymentId);
  const out: SuggestedQuestion[] = [q('payment_summary', 'What happened to this payment?', 'summary')];
  if (!rec) return [...out, q('how_long', 'How long did it take?', 'timeline'), ...SYSTEM_QUESTIONS.slice(0, 2)];
  const types = new Set(rec.events.map((x) => x.event.type));
  const status = rec.state.status;
  if (types.has('payment.held')) out.push(q('why_held', status === 'held' ? 'Why was this payment held?' : 'Why was this payment held and who released it?', 'held'));
  if (types.has('risk.alert_raised') && !types.has('payment.held') && !types.has('payment.rejected')) out.push(q('why_held', 'What did the risk alert find?', 'alert'));
  if (types.has('payment.rejected')) out.push(q('why_rejected', 'Why was it rejected?', 'rejected'));
  if (types.has('payment.send_failed') || types.has('payment.retry_requested')) out.push(q('why_retried', 'Why was it retried?', 'retried'));
  if (types.has('payment.routed')) out.push(q('why_this_route', 'Why this provider?', 'route'));
  if (types.has('payment.quoted')) out.push(q('fx_rate_and_cost', 'What did the FX cost?', 'fx'));
  if (types.has('payment.refunded')) out.push(q('ledger_proof', 'Was it refunded and does the reversal balance?', 'refund'));
  out.push(q('how_long', 'How long did it take?', 'timeline'));
  if (types.has('ledger.posted')) out.push(q('ledger_proof', 'Does the ledger balance for this payment?', 'ledger'));
  else if (status === 'held' || status === 'rejected' || status === 'failed') out.push(q('ledger_proof', 'Has any money moved for this payment?', 'money-moved'));
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
