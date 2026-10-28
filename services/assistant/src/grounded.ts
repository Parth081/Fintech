// Grounded answer engine (the default; deterministic, no network). Each template composes a short
// plain-English answer ONLY from Facts read from the recorded log (knowledge.ts) and returns exactly the
// facts it used. Templates never put a digit in their fixed prose: every number comes from fmt(fact).
//
// Recorded text (a hold reason, an alert summary, a reason text) is quoted verbatim and the fact it came
// from (event + field) is cited, so a reader can open the record and see the same words. Numbers the engine
// states itself (scores, amounts, counts) are always rendered from a numeric fact, never retyped.
import type { AskContext } from '@ct/contracts';
import { exclusionText, fmt, providerName, type Fact } from './facts';
import type { Intent } from './intents';
import {
  fxShockView,
  fxView,
  holdView,
  journalView,
  paymentOverview,
  providerHealthView,
  refundView,
  retryView,
  riskStoryView,
  routeView,
  scenarioView,
  timelineView,
  totalsView,
  trialBalance,
  type AlertView,
  type HoldView,
  type QuotePoint,
  type RouteView,
  type ScoreRow,
} from './knowledge';
import type { FactStore, PaymentRecord, ScenarioRun } from './store';

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
  /** Quote a recorded text verbatim (and cite it). */
  q(x: Fact): string {
    return `"${this.f(x)}"`;
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

/** Why nothing has reached a provider or the ledger, from the recorded hold / rejection / failure. Always cites. */
function stopLine(c: Composer, rec: PaymentRecord): string {
  const v = holdView(rec);
  const r = retryView(rec);
  const status = rec.state.status;
  const o = paymentOverview(rec);
  if (status === 'held' && v.held) {
    for (const f of [o.statusFact, v.held.atStage]) c.f(f);
    return `It is held by ${stagePhrase(String(v.held.atStage.value))}: ${c.q(v.held.reason)}.`;
  }
  if (status === 'rejected' && v.rejected) {
    c.f(o.statusFact);
    return `It was rejected by ${v.rejected.actor ? c.f(v.rejected.actor) : stagePhrase(String(v.rejected.atStage.value))}: ${c.q(v.rejected.reason)}.`;
  }
  if (status === 'failed' && r.failed) {
    c.f(o.statusFact);
    return `It failed: ${c.q(r.failed.reason)}.`;
  }
  c.f(o.statusFact);
  return `It is ${STATUS_PHRASE[status] ?? status}.`;
}

function paymentSummary(rec: PaymentRecord): Draft {
  const v = paymentOverview(rec);
  const r = retryView(rec);
  const h = holdView(rec);
  const c = new Composer();
  c.add(`This ${c.f(v.amount)} payment on the ${c.f(v.corridor)} corridor is ${STATUS_PHRASE[v.status] ?? v.status}.`);
  c.f(v.statusFact);
  if (v.status === 'held' && h.held) c.add(`Hold reason: ${c.q(h.held.reason)}.`);
  if (v.status === 'rejected' && h.rejected) c.add(`Rejection reason: ${c.q(h.rejected.reason)}.`);
  if (v.status === 'failed' && r.failed) c.add(`Failure reason: ${c.q(r.failed.reason)}.`);
  if (h.released) c.add(`${c.f(h.released.actor)} released it from hold${h.released.approvedBy ? `, approved by ${c.f(h.released.approvedBy)}` : ''}.`);
  if (v.targetAmount) c.add(`The recipient ${v.status === 'reconciled' ? 'got' : 'is due'} ${c.f(v.targetAmount)}.`);
  if (v.provider) c.add(`It ${r.failures.length ? 'ended up' : 'was'} routed to ${c.p(v.provider)}.`);
  if (r.failures.length) c.add(`Providers refused it ${c.f(r.failureCount)} time(s) along the way, and each refusal was retried.`);
  const rf = refundView(rec);
  if (rf) c.add(`It was later refunded: the ledger posted reversal journal ${c.f(rf.journalId)}.`);
  return c.done();
}

const sideOf = (f: Fact | undefined) => (String(f?.value) === 'debtor' ? 'sender' : 'beneficiary');

/** One alert, in plain English, every figure from the alert's recorded evidence. */
function alertSentence(c: Composer, a: AlertView): string {
  const e = a.ev;
  const head = `Alert ${c.f(a.rule)} (${c.f(a.kind)}, ${c.f(a.severity)} severity${a.score ? `, score ${c.f(a.score)}` : ''})`;
  const bits: string[] = [];
  switch (String(a.rule.value)) {
    case 'SANCTIONS_FUZZY_MATCH':
      if (e.entryName) {
        bits.push(
          `the ${sideOf(e.field)} name${e.matchedName ? ` matched listed name ${c.q(e.matchedName)}` : ' matched'} on ${e.entryName ? `list entry ${c.f(e.entryName)}` : 'the list'}${e.entryId ? ` (${c.f(e.entryId)}${e.program ? `, programme ${c.f(e.program)}` : ''})` : ''}${e.listName ? ` of the ${c.f(e.listName)}` : ''}${e.matchScore ? `, a similarity of ${c.f(e.matchScore)}` : ''}${e.threshold ? ` against a match threshold of ${c.f(e.threshold)}` : ''}`,
        );
        if (e.field) c.f(e.field);
      }
      break;
    case 'AML_FAN_IN':
      if (e.parties && e.name && e.totalUsd) bits.push(`${c.f(e.parties)} different senders paid ${c.f(e.name)} ${c.f(e.totalUsd)} in total${e.window ? ` within a window of ${c.f(e.window)} (minutes)` : ''}`);
      break;
    case 'AML_FAN_OUT':
      if (e.parties && e.name && e.totalUsd) bits.push(`${c.f(e.name)} paid ${c.f(e.parties)} different beneficiaries ${c.f(e.totalUsd)} in total${e.window ? ` within a window of ${c.f(e.window)} (minutes)` : ''}`);
      break;
    case 'AML_STRUCTURING':
      if (e.threshold) bits.push(`amounts were kept just below the ${c.f(e.threshold)}${e.linkedBy ? `, linked through the same ${c.f(e.linkedBy)}` : ''}`);
      break;
    case 'AML_RAPID_IN_OUT':
      if (e.receivedUsd && e.sentUsd) bits.push(`the sender received ${c.f(e.receivedUsd)} and sent on ${c.f(e.sentUsd)}${e.shareOut ? `, ${c.f(e.shareOut)} of it` : ''}`);
      break;
    case 'AML_LARGE_VALUE_REVIEW':
      if (e.amountUsd && e.reviewUsd) bits.push(`the payment of ${c.f(e.amountUsd)} is at or above the ${c.f(e.reviewUsd)} manual-review threshold`);
      break;
    default:
      if (e.amountUsd) bits.push(`the amount was about ${c.f(e.amountUsd)}`);
      break;
  }
  if (a.related) {
    bits.push(`it links ${c.f(a.related.count)} other payment(s)${a.related.ids.length ? `, for example ${a.related.ids.map((i) => c.f(i)).join(' and ')}` : ''}`);
  }
  const why = a.reasons.slice(0, 2).map((r) => c.q(r));
  return [
    `${head}${bits.length ? `: ${bits.join('; ')}` : ''}.`,
    `Recorded summary: ${c.q(a.summary)}.`,
    why.length && String(a.kind.value) !== 'sanctions' ? `Main factors recorded: ${why.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
}

function operatorOutcome(c: Composer, v: HoldView): string | undefined {
  if (v.released) {
    const role = v.released.role ? ` as ${c.f(v.released.role)}` : '';
    return `${c.f(v.released.actor)} later released it${role}${v.released.approvedBy ? `, approved by ${c.f(v.released.approvedBy)}` : ''}: ${c.q(v.released.reason)}. It then resumed at FX quoting.`;
  }
  if (v.rejected) {
    const by = v.rejected.actor ? c.f(v.rejected.actor) : stagePhrase(String(v.rejected.atStage.value));
    return `It was then rejected by ${by}${v.rejected.approvedBy ? `, approved by ${c.f(v.rejected.approvedBy)}` : ''}: ${c.q(v.rejected.reason)}.`;
  }
  return undefined;
}

function whyHeld(rec: PaymentRecord): Draft {
  const v = holdView(rec);
  const c = new Composer();
  if (v.held) {
    c.add(`This payment was held by ${stagePhrase(String(v.held.atStage.value))}: ${c.q(v.held.reason)}.`);
    c.f(v.held.atStage);
    if (v.held.reasonCodes) c.add(`Decision codes: ${c.f(v.held.reasonCodes)}.`);
    if (v.held.combinedScore) c.add(`The combined risk score was ${c.f(v.held.combinedScore)}${v.held.fraudScore ? `, of which the fraud model alone gave ${c.f(v.held.fraudScore)}` : ''}${v.held.amountUsd ? `, on a payment of ${c.f(v.held.amountUsd)}` : ''}.`);
    else if (v.fraudScore) c.add(`Its fraud score was ${c.f(v.fraudScore)}.`);
    for (const a of v.alerts.slice(0, 3)) c.add(alertSentence(c, a));
    if (v.alerts.length > 3) c.add('More alerts are recorded on this payment than shown here.');
    const outcome = operatorOutcome(c, v);
    if (outcome) c.add(outcome);
    else c.add('It now waits for a person in operations to approve or reject it; the system never decides that alone.');
    return c.done();
  }
  c.add('This payment was not held.');
  if (v.screening) c.add(`Sanctions screening came back ${c.f(v.screening)}.`);
  if (v.fraudScore && v.riskDecision) c.add(`Risk scored it ${c.f(v.fraudScore)} and decided "${c.f(v.riskDecision)}".`);
  if (v.rejected) c.add(`It was rejected instead: ${c.q(v.rejected.reason)}.`);
  if (!v.screening && !v.rejected && !(v.fraudScore && v.riskDecision)) c.add(stopLine(c, rec));
  return c.done();
}

function whyRejected(rec: PaymentRecord): Draft {
  const v = holdView(rec);
  const c = new Composer();
  if (v.rejected) {
    const by = v.rejected.actor ? c.f(v.rejected.actor) : stagePhrase(String(v.rejected.atStage.value));
    c.f(v.rejected.atStage);
    c.add(`This payment was rejected by ${by}${v.rejected.approvedBy ? `, approved by ${c.f(v.rejected.approvedBy)}` : ''}: ${c.q(v.rejected.reason)}.`);
    if (v.rejected.reasonCodes) c.add(`Decision codes: ${c.f(v.rejected.reasonCodes)}.`);
    if (v.fraudScore) c.add(`Its fraud score was ${c.f(v.fraudScore)}.`);
    for (const a of v.alerts.slice(0, 3)) c.add(alertSentence(c, a));
    c.add('A rejected payment never reaches a provider, so nothing was posted to the ledger.');
    return c.done();
  }
  c.add('This payment was not rejected by our checks.');
  if (v.screening) c.add(`Sanctions screening came back ${c.f(v.screening)}.`);
  if (v.fraudScore && v.riskDecision) c.add(`Risk scored it ${c.f(v.fraudScore)} and decided "${c.f(v.riskDecision)}".`);
  const r = retryView(rec);
  const first = r.failures[0];
  if (first) c.add(`A provider did refuse it once: ${c.p(first.provider)} returned ${c.f(first.reasonCode)}, and it was retried.`);
  if (v.held) c.add(`It was held instead: ${c.q(v.held.reason)}.`);
  if (!v.screening && !first && !v.held && !(v.fraudScore && v.riskDecision)) c.add(stopLine(c, rec));
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
    c.add(`This payment has not been routed yet.`);
    c.add(stopLine(c, rec));
    c.add('Routing happens only after risk checks approve the payment and it has an FX quote.');
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
    if (route) {
      c.add(`This payment was not retried: ${c.p(route.chosen)} accepted it on the first attempt.`);
      c.f(route.chosen);
    } else if (r.failed) {
      c.f(paymentOverview(rec).statusFact);
      c.add(`No provider ever refused this payment: it failed before reaching one, with ${c.q(r.failed.reason)}. Nothing was sent or posted.`);
    } else {
      c.add(`This payment has not reached a provider yet, so nothing was sent and nothing was retried. ${stopLine(c, rec)}`);
    }
    if (r.retryRequested) c.add(`${c.f(r.retryRequested.actor)} asked for a fresh retry: ${c.q(r.retryRequested.reason)}.`);
    return c.done();
  }
  for (const f of r.failures.slice(0, 3)) {
    c.add(`${c.p(f.provider)} refused attempt ${c.f(f.attempt)} with ISO 20022 reason ${c.f(f.reasonCode)} (${c.q(f.reason)}).`);
    const next = r.reroutes.find((x) => {
      const a = x.attempt ? Number(x.attempt.value) : 0;
      return a === Number(f.attempt.value) + 1;
    });
    if (next) c.add(`Routing excluded it and chose ${c.p(next.provider)}${next.attempt ? ` for attempt ${c.f(next.attempt)}` : ''}.`);
  }
  if (r.failures.length > 3) c.add(`In total providers refused it ${c.f(r.failureCount)} times.`);
  if (r.settledBy) c.add(`${c.p(r.settledBy)} then settled it, so the customer was not left waiting.`);
  else if (r.failed) c.add(`Every eligible provider refused it, so it failed: ${c.q(r.failed.reason)}. Nothing was posted to the ledger.`);
  if (r.retryRequested) c.add(`${c.f(r.retryRequested.actor)} asked for a fresh retry: ${c.q(r.retryRequested.reason)}.`);
  return c.done();
}

function fxCost(rec: PaymentRecord): Draft {
  const v = fxView(rec);
  const c = new Composer();
  if (!v) {
    c.add(`This payment has no FX quote yet.`);
    c.add(stopLine(c, rec));
    c.add('The FX quote is taken only after risk checks approve the payment.');
    return c.done();
  }
  const src = (v.source.value as { currency: string }).currency;
  const tgt = (v.target.value as { currency: string }).currency;
  if (v.midRate) c.add(`The market mid rate was ${c.f(v.midRate)} (${tgt} per ${src}).`);
  c.add(`We applied a ${c.f(v.spreadBps)} spread, so the customer rate was ${c.f(v.rate)}: ${c.f(v.source)} became ${c.f(v.target)}.`);
  if (v.shock) {
    c.add(
      `This quote was priced while an FX shock was active (reason codes ${c.f(v.shock.codes)})${v.shock.drift ? `: the shock moved the mid rate by up to ${c.f(v.shock.drift)}` : ''}${v.shock.noise ? ` and multiplied short-term noise by ${c.f(v.shock.noise)}` : ''}${v.shock.volatility ? `, and the volatility add-on in the spread was ${c.f(v.shock.volatility)}` : ''}.`,
    );
  }
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
    const h = holdView(rec);
    if (rec.state.status === 'held' && h.held) c.add(`It is waiting on a person because: ${c.q(h.held.reason)}.`);
  }
  return c.done();
}

function ledgerForPayment(rec: PaymentRecord): Draft {
  const v = journalView(rec);
  const rf = refundView(rec);
  const c = new Composer();
  if (!v && !rf) {
    c.add(`Nothing has been posted to the ledger for this payment, and that is correct. ${stopLine(c, rec)}`);
    c.add('The ledger posts a journal only after the provider confirms settlement.');
    return c.done();
  }
  if (v) {
    c.add(`Journal ${c.f(v.journalId)} posted: ${v.entries.map((e) => `${c.f(e.direction)} ${c.f(e.account)} ${c.f(e.amount)}`).join('; ')}.`);
    c.add(`Debits equal credits in each currency (${v.totals.map((t) => `${c.f(t.debits)} = ${c.f(t.credits)}`).join('; ')}), so the journal ${v.balanced ? 'balances' : 'does NOT balance'}.`);
    if (v.reconciled) c.add(v.reconciled.matched.value === true ? `Reconciliation matched it to statement ${c.f(v.reconciled.statementRef)}.` : `Reconciliation found a break against statement ${c.f(v.reconciled.statementRef)}.`);
    c.f(v.reconciled?.matched ?? v.journalId);
  }
  if (rf) {
    if (rf.requested) c.add(`${c.f(rf.requested.actor)} asked for a refund${rf.requested.approvedBy ? `, approved by ${c.f(rf.requested.approvedBy)}` : ''}: ${c.q(rf.requested.reason)}.`);
    c.add(`The ledger then posted reversal journal ${c.f(rf.journalId)}: ${rf.entries.map((e) => `${c.f(e.direction)} ${c.f(e.account)} ${c.f(e.amount)}`).join('; ')}.`);
    c.add(`Its debits equal its credits (${rf.totals.map((t) => `${c.f(t.debits)} = ${c.f(t.credits)}`).join('; ')}), so the reversal ${rf.balanced ? 'balances' : 'does NOT balance'}.`);
  }
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

// ---------------------------------------------------------------------------------------------
// Scenario-level sections (shared by outage_story and the focused risk / FX intents)

function riskSection(c: Composer, store: FactStore, run: ScenarioRun, detailed: boolean): boolean {
  const v = riskStoryView(store, run);
  if (!v.hasRisk) return false;
  c.add(`The risk engine held ${c.f(v.heldEver)} payment(s) for review and raised ${c.f(v.alerts)} alert(s).`);
  if (v.byKind.length) c.add(`Alerts by kind: ${v.byKind.map((b) => `${c.f(b.count)} ${b.kind}`).join(', ')}.`);
  if (detailed && v.byRule.length) c.add(`Most frequent rules: ${v.byRule.map((b) => `${b.rule} (${c.f(b.count)})`).join(', ')}.`);
  c.add(`${c.f(v.stillHeld)} are still waiting for an operator, ${c.f(v.rejected)} were rejected and ${c.f(v.released)} were released by an operator.`);
  if (v.entries.length) {
    c.add(`Sanctions list entries matched: ${v.entries.map((e) => `${c.f(e.name)}${e.id || e.score ? ` (${[e.id ? c.f(e.id) : '', e.score ? `${c.f(e.score)} match` : ''].filter(Boolean).join(', ')})` : ''}`).join('; ')}.`);
  }
  if (detailed) {
    for (const ex of v.examples.slice(0, 2)) c.add(`Example: ${alertSentence(c, ex.alert)}`);
    c.add('Held payments have not moved any money: nothing is posted to the ledger until a person decides.');
  }
  return true;
}

function quoteLine(c: Composer, label: string, q: QuotePoint, corridor: string): string {
  const mid = q.mid ? ` the mid rate was ${c.f(q.mid)} and` : '';
  const vol = q.volatility ? `, of which ${c.f(q.volatility)} was the volatility add-on` : '';
  return `${label}, on ${corridor},${mid} the customer paid a spread of ${c.f(q.spread)} (rate ${c.f(q.rate)})${vol}.`;
}

function fxShockSection(c: Composer, store: FactStore, run: ScenarioRun): boolean {
  const v = fxShockView(store, run);
  if (!v) return false;
  const corridor = c.f(v.corridor);
  c.add(
    `An FX shock hit the ${corridor} corridor at ${c.f(v.startedAt)}, moving the mid rate by up to ${c.f(v.drift)} and multiplying short-term noise by ${c.f(v.noise)}${v.endedAt && v.duration ? `; it ended at ${c.f(v.endedAt)}, after ${c.f(v.duration)}` : ''}.`,
  );
  if (v.reason) c.add(`Recorded reason: ${c.q(v.reason)}.`);
  if (v.before) c.add(quoteLine(c, 'Before the shock', v.before, corridor));
  if (v.during) c.add(`${quoteLine(c, 'During the shock, at its widest', v.during, corridor)} ${c.f(v.duringCount)} quote(s) were priced under the shock.`);
  if (v.after) c.add(quoteLine(c, 'After the shock, the first quote', v.after, corridor));
  if (!v.before && !v.during && !v.after) c.add('No payment on that corridor was quoted around the shock, so there are no spreads to compare.');
  else c.add('The spread widened because volatility raises the add-on, and it came back once the shock ended.');
  return true;
}

function riskStory(store: FactStore, scenarioOnly: boolean): Draft {
  const c = new Composer();
  const run = store.latestRun();
  if (!run) {
    c.add(scenarioOnly ? 'No scenario has run yet. Start one from the presenter console and ask me again.' : 'No scenario has run yet, so there is no risk story to tell.');
    return c.done();
  }
  const v = riskStoryView(store, run);
  c.add(`${c.f(v.title)}:`);
  if (!riskSection(c, store, run, true)) {
    c.add(`No payment was held and no risk alert was raised during this run: ${c.f(v.heldEver)} held, ${c.f(v.alerts)} alerts.`);
  }
  return c.done();
}

function fxShockStory(store: FactStore, scenarioOnly: boolean): Draft {
  const c = new Composer();
  const run = store.latestRun();
  if (!run) {
    c.add(scenarioOnly ? 'No scenario has run yet. Start one from the presenter console and ask me again.' : 'No scenario has run yet, so there is no FX story to tell.');
    return c.done();
  }
  const view = scenarioView(store, run);
  c.add(`${c.f(view.title)}:`);
  if (!fxShockSection(c, store, run)) {
    c.add(`No FX shock was recorded during this run, so rates and spreads stayed in their normal range. ${c.f(view.payments)} payment(s) ran in total.`);
  }
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
  if (v.outages.length === 0) {
    const hadFx = fxShockSection(c, store, run);
    const hadRisk = riskSection(c, store, run, false);
    if (hadFx || hadRisk) c.add(`Of ${c.f(v.payments)} payments in the run, ${c.f(v.reconciled)} reconciled and ${c.f(v.inFlight)} are still in flight.`);
    else c.add(`Of ${c.f(v.payments)} payments in the run, ${c.f(v.reconciled)} reconciled, ${c.f(v.failed)} failed with nothing posted and ${c.f(v.inFlight)} are still in flight.`);
    c.add(`Payments lost: ${c.f(v.lost)}. Unbalanced journals: ${c.f(v.trial.unbalanced)}.`);
    return c.done();
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
  if (intent === 'risk_story') return riskStory(store, context.kind === 'scenario');
  if (intent === 'fx_shock') return fxShockStory(store, context.kind === 'scenario');
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
