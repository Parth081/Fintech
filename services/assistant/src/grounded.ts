// Grounded answer engine (the default; deterministic, no network). Each template composes a short
// plain-English answer ONLY from Facts read from the recorded log (knowledge.ts) and returns exactly the
// facts it used. Templates never put a digit in their fixed prose: every number comes from fmt(fact).
import type { AskContext } from '@ct/contracts';
import { exclusionText, fmt, providerName, type Fact } from './facts';
import type { Intent } from './intents';
import {
  fxView,
  holdView,
  journalView,
  paymentOverview,
  providerHealthView,
  retryView,
  routeView,
  scenarioView,
  timelineView,
  totalsView,
  trialBalance,
  type RouteView,
  type ScoreRow,
} from './knowledge';
import type { FactStore, PaymentRecord } from './store';

export interface Draft {
  text: string;
  facts: Fact[];
}

class Composer {
  readonly facts: Fact[] = [];
  private readonly parts: string[] = [];
  /** Render a fact and record it as a citation. */
  f(x: Fact): string {
    if (!this.facts.includes(x)) this.facts.push(x);
    return fmt(x);
  }
  /** Provider display name from a text fact holding a provider id. */
  p(x: Fact): string {
    if (!this.facts.includes(x)) this.facts.push(x);
    return providerName(String(x.value));
  }
  add(s: string | undefined | false): this {
    if (s) this.parts.push(s.trim());
    return this;
  }
  done(): Draft {
    return { text: this.parts.join(' ').replace(/\s+/g, ' ').replace(/\s([.,;:])/g, '$1').trim(), facts: this.facts };
  }
}

const STATUS_PHRASE: Record<string, string> = {
  initiated: 'just started and is being checked',
  screened: 'past sanctions screening and in risk checks',
  scored: 'approved by risk checks and waiting for an FX quote',
  quoted: 'quoted and being routed to a provider',
  routed: 'routed to a provider',
  sent: 'with the provider, waiting for confirmation',
  settled: 'settled by the provider and waiting for reconciliation',
  reconciled: 'complete: settled and reconciled against the provider statement',
  retrying: 'being retried after a provider refused it',
  held: 'held for review by the operations team',
  rejected: 'rejected',
  failed: 'marked failed: every eligible provider refused it and nothing was posted to the ledger',
  refund_requested: 'being refunded',
  refunded: 'refunded: the ledger posted the reversal',
};

const stagePhrase = (stage: string) => (stage === 'ops' ? 'an operator' : stage === 'risk' ? 'the risk check' : stage === 'screening' ? 'sanctions screening' : `the ${stage} stage`);

function paymentSummary(rec: PaymentRecord): Draft {
  const v = paymentOverview(rec);
  const r = retryView(rec);
  const c = new Composer();
  c.add(`This ${c.f(v.amount)} payment on the ${c.f(v.corridor)} corridor is ${STATUS_PHRASE[v.status] ?? v.status}.`);
  c.f(v.statusFact);
  if (v.targetAmount) c.add(`The recipient ${v.status === 'reconciled' ? 'got' : 'is due'} ${c.f(v.targetAmount)}.`);
  if (v.provider) c.add(`It ${r.failures.length ? 'ended up' : 'was'} routed to ${c.p(v.provider)}.`);
  if (r.failures.length) c.add(`Providers refused it ${c.f(r.failureCount)} time(s) along the way, and each refusal was retried.`);
  return c.done();
}

function whyHeld(rec: PaymentRecord): Draft {
  const v = holdView(rec);
  const c = new Composer();
  if (v.held) {
    c.add(`This payment was held by ${stagePhrase(String(v.held.atStage.value))}: "${c.f(v.held.reason)}".`);
    c.f(v.held.atStage);
    if (v.held.reasonCodes) c.add(`Decision codes: ${c.f(v.held.reasonCodes)}.`);
    if (v.fraudScore) c.add(`Its fraud score was ${c.f(v.fraudScore)}.`);
    const a = v.alerts[0];
    if (a) c.add(`Alert ${c.f(a.rule)} (${c.f(a.severity)} severity${a.score ? `, score ${c.f(a.score)}` : ''}): ${c.f(a.summary)}`);
    if (v.released) c.add(`${c.f(v.released.actor)} later released it: "${c.f(v.released.reason)}".`);
    else if (v.rejected) c.add(`It was then rejected: "${c.f(v.rejected.reason)}".`);
    else c.add('It now waits for a person in operations to approve or reject it; the system never decides that alone.');
    return c.done();
  }
  c.add('This payment was not held.');
  if (v.screening) c.add(`Sanctions screening came back ${c.f(v.screening)}.`);
  if (v.fraudScore && v.riskDecision) c.add(`Risk scored it ${c.f(v.fraudScore)} and decided "${c.f(v.riskDecision)}".`);
  if (v.rejected) c.add(`It was rejected instead: "${c.f(v.rejected.reason)}".`);
  return c.done();
}

function whyRejected(rec: PaymentRecord): Draft {
  const v = holdView(rec);
  const c = new Composer();
  if (v.rejected) {
    const by = v.rejected.actor ? c.f(v.rejected.actor) : stagePhrase(String(v.rejected.atStage.value));
    c.f(v.rejected.atStage);
    c.add(`This payment was rejected by ${by}: "${c.f(v.rejected.reason)}".`);
    if (v.rejected.reasonCodes) c.add(`Decision codes: ${c.f(v.rejected.reasonCodes)}.`);
    if (v.fraudScore) c.add(`Its fraud score was ${c.f(v.fraudScore)}.`);
    const a = v.alerts[0];
    if (a) c.add(`Alert ${c.f(a.rule)} (${c.f(a.severity)} severity): ${c.f(a.summary)}`);
    c.add('A rejected payment never reaches a provider, so nothing was posted to the ledger.');
    return c.done();
  }
  c.add('This payment was not rejected by our checks.');
  if (v.screening) c.add(`Sanctions screening came back ${c.f(v.screening)}.`);
  if (v.fraudScore && v.riskDecision) c.add(`Risk scored it ${c.f(v.fraudScore)} and decided "${c.f(v.riskDecision)}".`);
  const r = retryView(rec);
  const first = r.failures[0];
  if (first) c.add(`A provider did refuse it once: ${c.p(first.provider)} returned ${c.f(first.reasonCode)}, and it was retried.`);
  return c.done();
}

function rowLine(c: Composer, row: ScoreRow): string {
  const bits: string[] = [];
  if (row.fee) bits.push(`fee ${c.f(row.fee)}`);
  if (row.successRate) bits.push(`success ${c.f(row.successRate)}`);
  return `${c.p(row.provider)} scored ${row.score ? c.f(row.score) : 'lower'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

function whyRoute(rec: PaymentRecord, v: RouteView | undefined): Draft {
  const c = new Composer();
  if (!v) {
    c.add(`This payment has not been routed yet; it is ${STATUS_PHRASE[rec.state.status] ?? rec.state.status}.`);
    return c.done();
  }
  const chosen = v.rows.find((r) => r.providerId === v.chosenId);
  const attempt = v.attempt && v.attemptNo > 1 ? ` on attempt ${c.f(v.attempt)}` : '';
  c.add(`Routing picked ${c.p(v.chosen)}${v.rail ? ` (${c.f(v.rail)})` : ''}${attempt}`);
  if (chosen?.score) {
    const bits = [`fee ${c.f(chosen.fee ?? v.fee)}`];
    if (chosen.successRate) bits.push(`success rate ${c.f(chosen.successRate)}`);
    if (chosen.latency) bits.push(`expected time ${c.f(chosen.latency)}`);
    c.add(`with the best score, ${c.f(chosen.score)}: ${bits.join(', ')}.`);
  } else {
    c.add(`with an estimated fee of ${c.f(v.fee)}.`);
  }
  const others = v.rows.filter((r) => r.providerId !== v.chosenId && r.eligible);
  if (others.length) c.add(`Other options: ${others.map((r) => rowLine(c, r)).join('; ')}.`);
  const excluded = v.rows.filter((r) => !r.eligible && r.excludedReason);
  for (const r of excluded) c.add(`${c.p(r.provider)} was excluded: ${exclusionText(String(c.f(r.excludedReason!)))}.`);
  if (v.weights.success && v.weights.cost && v.weights.speed) {
    c.add(`The score weighs success ${c.f(v.weights.success)}, cost ${c.f(v.weights.cost)} and speed ${c.f(v.weights.speed)}.`);
  }
  return c.done();
}

function whyRetried(rec: PaymentRecord): Draft {
  const r = retryView(rec);
  const route = routeView(rec);
  const c = new Composer();
  if (r.failures.length === 0) {
    if (route) c.add(`This payment was not retried: ${c.p(route.chosen)} accepted it on the first attempt.`);
    else c.add(`This payment has not reached a provider yet; it is ${STATUS_PHRASE[rec.state.status] ?? rec.state.status}.`);
    return c.done();
  }
  for (const f of r.failures.slice(0, 3)) {
    c.add(`${c.p(f.provider)} refused attempt ${c.f(f.attempt)} with ISO 20022 reason ${c.f(f.reasonCode)} ("${c.f(f.reason)}").`);
    const next = r.reroutes.find((x) => {
      const a = x.attempt ? Number(x.attempt.value) : 0;
      return a === Number(f.attempt.value) + 1;
    });
    if (next) c.add(`Routing excluded it and chose ${c.p(next.provider)}${next.attempt ? ` for attempt ${c.f(next.attempt)}` : ''}.`);
  }
  if (r.failures.length > 3) c.add(`In total providers refused it ${c.f(r.failureCount)} times.`);
  if (r.settledBy) c.add(`${c.p(r.settledBy)} then settled it, so the customer was not left waiting.`);
  else if (r.failed) c.add(`Every eligible provider refused it, so it failed: "${c.f(r.failed.reason)}". Nothing was posted to the ledger.`);
  if (r.retryRequested) c.add(`${c.f(r.retryRequested.actor)} asked for a fresh retry: "${c.f(r.retryRequested.reason)}".`);
  return c.done();
}

function fxCost(rec: PaymentRecord): Draft {
  const v = fxView(rec);
  const c = new Composer();
  if (!v) {
    c.add(`This payment has no FX quote yet; it is ${STATUS_PHRASE[rec.state.status] ?? rec.state.status}.`);
    return c.done();
  }
  const src = (v.source.value as { currency: string }).currency;
  const tgt = (v.target.value as { currency: string }).currency;
  if (v.midRate) c.add(`The market mid rate was ${c.f(v.midRate)} (${tgt} per ${src}).`);
  c.add(`We applied a ${c.f(v.spreadBps)} spread, so the customer rate was ${c.f(v.rate)}: ${c.f(v.source)} became ${c.f(v.target)}.`);
  if (v.fee) c.add(`The provider fee was ${c.f(v.fee)}.`);
  if (v.spreadCost && v.totalCost) c.add(`The spread cost ${c.f(v.spreadCost)}, so the all-in cost was ${c.f(v.totalCost)}.`);
  else if (v.spreadCost) c.add(`The spread cost ${c.f(v.spreadCost)}.`);
  if (v.settledAmount) c.add(`The provider confirmed delivering ${c.f(v.settledAmount)}.`);
  return c.done();
}

function howLong(rec: PaymentRecord): Draft {
  const v = timelineView(rec);
  const c = new Composer();
  if (v.totalLabel === 'reconciled') {
    c.add(`End to end it took ${c.f(v.total)} from initiation to reconciliation.`);
    const bits: string[] = [];
    if (v.checks) bits.push(`screening and risk checks took ${c.f(v.checks)}`);
    if (v.quoteAndRoute) bits.push(`the FX quote and routing ${c.f(v.quoteAndRoute)}`);
    if (v.provider) bits.push(`the provider settled ${c.f(v.provider)} after the instruction was sent`);
    if (v.reconcile) bits.push(`reconciliation followed ${c.f(v.reconcile)} later`);
    if (bits.length) c.add(`${bits.join(', ').replace(/^./, (s) => s.toUpperCase())}.`);
  } else {
    c.add(`It started at ${c.f(v.started)} and the latest recorded event came ${c.f(v.total)} later; it is ${STATUS_PHRASE[rec.state.status] ?? rec.state.status}.`);
    if (v.checks) c.add(`Screening and risk checks took ${c.f(v.checks)}.`);
  }
  return c.done();
}

function ledgerForPayment(rec: PaymentRecord): Draft {
  const v = journalView(rec);
  const c = new Composer();
  if (!v) {
    c.add(`Nothing has been posted to the ledger for this payment, and that is correct: it is ${STATUS_PHRASE[rec.state.status] ?? rec.state.status}.`);
    c.add('The ledger posts a journal only after the provider confirms settlement.');
    return c.done();
  }
  c.add(`Journal ${c.f(v.journalId)} posted: ${v.entries.map((e) => `${c.f(e.direction)} ${c.f(e.account)} ${c.f(e.amount)}`).join('; ')}.`);
  c.add(`Debits equal credits in each currency (${v.totals.map((t) => `${c.f(t.debits)} = ${c.f(t.credits)}`).join('; ')}), so the journal ${v.balanced ? 'balances' : 'does NOT balance'}.`);
  if (v.reconciled) c.add(v.reconciled.matched.value === true ? `Reconciliation matched it to statement ${c.f(v.reconciled.statementRef)}.` : `Reconciliation found a break against statement ${c.f(v.reconciled.statementRef)}.`);
  c.f(v.reconciled?.matched ?? v.journalId);
  if (v.refundJournal) c.add(`It was later refunded with reversal journal ${c.f(v.refundJournal)}.`);
  return c.done();
}

function ledgerTrial(records: PaymentRecord[], scope: string, scopeText: string): Draft {
  const t = trialBalance(records, scope);
  const c = new Composer();
  if (Number(t.journals.value) === 0) {
    c.add(`No journals have been posted yet${scopeText.startsWith('during') ? ` ${scopeText}` : ''}, so there is nothing to balance.`);
    c.f(t.journals);
    return c.done();
  }
  c.add(`Across ${c.f(t.journals)} journals ${scopeText}, total debits equal total credits in every currency: ${t.totals.map((x) => `${c.f(x.debits)} = ${c.f(x.credits)}`).join('; ')}.`);
  c.add(`Unbalanced journals: ${c.f(t.unbalanced)}. Every posting is double-entry, so money is never created or lost.`);
  return c.done();
}

function providerHealth(records: PaymentRecord[], scope: string, scopeText: string): Draft {
  const v = providerHealthView(records, scope);
  const c = new Composer();
  c.add(`Provider health ${scopeText}:`);
  for (const r of v.rows) {
    const sr = r.successRate ? ` (${c.f(r.successRate)} success)` : '';
    const br = r.breaker ? `, breaker ${c.f(r.breaker)}` : '';
    c.add(`${providerName(r.providerId)}: ${c.f(r.attempts)} sent, ${c.f(r.settled)} settled, ${c.f(r.refused)} refused${sr}${br}.`);
  }
  return c.done();
}

function totals(records: PaymentRecord[], scope: string, scopeText: string): Draft {
  const v = totalsView(records, scope);
  const c = new Composer();
  c.add(`${c.f(v.payments)} payments ${scopeText}.`);
  if (v.byStatus.length) c.add(`Status now: ${v.byStatus.slice(0, 6).map((b) => `${c.f(b.count)} ${b.status.replace('_', ' ')}`).join(', ')}.`);
  if (v.reconciledValue.length) c.add(`Value reconciled: ${v.reconciledValue.slice(0, 4).map((m) => c.f(m)).join(', ')}.`);
  c.add(`Providers refused ${c.f(v.retries)} instructions; each one was retried or reported.`);
  if (v.avgEndToEnd) c.add(`Average time to reconcile: ${c.f(v.avgEndToEnd)}.`);
  return c.done();
}

function outageStory(store: FactStore, scenarioOnly: boolean): Draft {
  const c = new Composer();
  const run = store.latestRun();
  if (!run) {
    c.add(scenarioOnly ? 'No scenario has run yet. Start one from the presenter console and ask me again.' : 'No scenario has run yet, so there is no outage story to tell.');
    return c.done();
  }
  const v = scenarioView(store, run);
  c.add(`${c.f(v.title)}${v.outcome ? '' : ' (still running)'}.`);
  for (const o of v.outages.slice(0, 2)) {
    const what = String(o.mode.value) === 'degraded' && o.failureRate ? `became unreliable, refusing ${c.f(o.failureRate)} of instructions,` : 'went down';
    c.f(o.mode);
    c.add(`${c.p(o.provider)} ${what} at ${c.f(o.startedAt)}.`);
    if (o.breakerOpenedAt) c.add(`Routing first saw its circuit breaker open at ${c.f(o.breakerOpenedAt)}${o.breakerClosedAt ? ` and closed again at ${c.f(o.breakerClosedAt)}` : ''}.`);
    if (o.breakerOpenState) c.f(o.breakerOpenState);
    if (o.breakerClosedState) c.f(o.breakerClosedState);
    if (o.endedAt && o.duration) c.add(`The outage ended at ${c.f(o.endedAt)}, after ${c.f(o.duration)}.`);
    c.add(`${providerName(o.providerId)} refused ${c.f(o.refused)} instructions; ${c.f(o.retriedElsewhere)} of those payments were retried with another provider, and the breaker steered ${c.f(o.steeredAway)} payments away.`);
  }
  c.add(`Of ${c.f(v.payments)} payments in the run, ${c.f(v.reconciled)} reconciled, ${c.f(v.failed)} failed with nothing posted and ${c.f(v.inFlight)} are still in flight.`);
  c.add(`Payments lost: ${c.f(v.lost)}. Unbalanced journals: ${c.f(v.trial.unbalanced)}.`);
  return c.done();
}

/** Compose the grounded answer for an intent in a context. */
export function groundedDraft(store: FactStore, intent: Intent, context: AskContext): Draft {
  if (context.kind === 'payment') {
    const rec = store.payment(context.paymentId);
    if (!rec) return { text: 'I could not find that payment in the recorded log yet. If it was just submitted, ask again in a moment.', facts: [] };
    switch (intent) {
      case 'payment_summary':
        return paymentSummary(rec);
      case 'why_held':
        return whyHeld(rec);
      case 'why_rejected':
        return whyRejected(rec);
      case 'why_this_route':
        return whyRoute(rec, routeView(rec));
      case 'why_retried':
        return whyRetried(rec);
      case 'fx_rate_and_cost':
        return fxCost(rec);
      case 'how_long':
        return howLong(rec);
      case 'ledger_proof':
        return ledgerForPayment(rec);
      default:
        break;
    }
  }
  if (intent === 'outage_story') return outageStory(store, context.kind === 'scenario');
  const run = context.kind === 'scenario' ? store.latestRun() : undefined;
  const records = run ? store.paymentsInRun(run) : [...store.payments()];
  const scope = run ? `run ${run.runId}` : 'all payments';
  const scopeText = run ? 'during the latest scenario run' : 'recorded so far';
  if (context.kind === 'scenario' && !run && intent !== 'needs_payment') {
    return { text: 'No scenario has run yet. Start one from the presenter console and ask me again.', facts: [] };
  }
  switch (intent) {
    case 'ledger_proof':
      return ledgerTrial(records, scope, scopeText);
    case 'provider_health':
      return providerHealth(records, scope, scopeText);
    case 'totals':
      return totals(records, scope, scopeText);
    case 'needs_payment':
      return { text: 'That question is about a single payment. Open a payment (pick any row or dot on the map) and ask again: I will explain its route, FX cost and timeline from its recorded decisions.', facts: [] };
    default:
      return totals(records, scope, scopeText);
  }
}

export const OFF_TOPIC_TEXT =
  'I can only explain what this control tower recorded: payments, routes, FX, the ledger and scenarios. I can\'t help with that one, but here are some things you can ask me.';
