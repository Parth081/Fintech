// Pure analysis for `npm run verify:m2`: folds the event log into payment states with the real state
// machine, counts duplicates and invalid transitions, and turns everything into pass/fail checks.
import { applyEvent, isTerminal, type AnyEvent, type PaymentState, type TrialBalance } from '@ct/contracts';

/** Max routing attempts per payment (ADR 0007). */
export const MAX_ATTEMPTS = 3;

export interface PaymentFacts {
  paymentId: string;
  state: PaymentState;
  /** Number of payment.routed / payment.send_failed / ledger.posted events. */
  routed: number;
  sendFailed: number;
  ledgerPosted: number;
  firstAt: number;
  lastAt: number;
  terminalAt?: number;
}

/** Incremental log analyzer: feed it events in offset order (any number of times, in pages). */
export class LogAnalyzer {
  readonly payments = new Map<string, PaymentFacts>();
  readonly eventIds = new Set<string>();
  readonly duplicates: { offset: number; eventId: string; type: string; paymentId: string }[] = [];
  readonly invalid: { offset: number; eventId: string; type: string; paymentId: string; error: string }[] = [];
  events = 0;
  /** Next offset expected (offsets must be dense). */
  nextOffset = 0;
  readonly gaps: { expected: number; got: number }[] = [];

  apply(offset: number, event: AnyEvent): void {
    if (offset !== this.nextOffset) this.gaps.push({ expected: this.nextOffset, got: offset });
    this.nextOffset = offset + 1;
    this.events += 1;
    if (this.eventIds.has(event.eventId)) {
      this.duplicates.push({ offset, eventId: event.eventId, type: event.type, paymentId: event.paymentId });
      return;
    }
    this.eventIds.add(event.eventId);
    // ISO 20022 XML is irrelevant to the state machine; drop it so 10k payments stay small in memory.
    const slim = stripMessage(event);
    const prev = this.payments.get(event.paymentId);
    let state: PaymentState;
    try {
      state = applyEvent(prev?.state, slim);
    } catch (err) {
      this.invalid.push({ offset, eventId: event.eventId, type: event.type, paymentId: event.paymentId, error: (err as Error).message });
      return;
    }
    const at = Date.parse(event.occurredAt);
    const facts: PaymentFacts = prev ?? {
      paymentId: event.paymentId,
      state,
      routed: 0,
      sendFailed: 0,
      ledgerPosted: 0,
      firstAt: at,
      lastAt: at,
    };
    facts.state = state;
    facts.lastAt = Math.max(facts.lastAt, at);
    if (event.type === 'payment.routed') facts.routed += 1;
    if (event.type === 'payment.send_failed') facts.sendFailed += 1;
    if (event.type === 'ledger.posted') facts.ledgerPosted += 1;
    if (isTerminal(state.status) && facts.terminalAt === undefined) facts.terminalAt = at;
    this.payments.set(event.paymentId, facts);
  }
}

function stripMessage(event: AnyEvent): AnyEvent {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload?.message !== 'string') return event;
  const { message: _m, ...rest } = payload;
  return { ...event, payload: rest } as AnyEvent;
}

export interface Check {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  /** Up to 20 examples of what failed. */
  examples?: unknown[];
}

export interface JournalCounts {
  /** paymentId -> number of journals the ledger reports for it (undefined = request failed). */
  byPayment: Map<string, number | undefined>;
  totalJournals?: number;
}

export interface EvaluateInput {
  log: LogAnalyzer;
  /** The payments this run created (paymentIds from the Payment API). */
  sent: string[];
  trafficErrors: number;
  trialBalance?: TrialBalance | null;
  invariants?: { ok: boolean; violations: string[] } | null;
  journals?: JournalCounts | null;
  gatewayRejectedEvents?: number | null;
  /** Whether the run launched its own system (then the ledger holds only this run's journals). */
  ownSystem: boolean;
}

const sample = <T>(xs: readonly T[]) => xs.slice(0, 20);

export function evaluate(input: EvaluateInput): Check[] {
  const { log, sent } = input;
  const checks: Check[] = [];

  // (a) ledger balanced
  const tb = input.trialBalance;
  const unbalanced = tb ? tb.byCurrency.filter((c) => !c.balanced || c.debits !== c.credits) : [];
  checks.push({
    id: 'a.trial-balance',
    title: 'Ledger trial balance: debits = credits for every currency',
    ok: Boolean(tb && tb.balanced && unbalanced.length === 0),
    detail: tb
      ? `${tb.journals} journals, ${tb.entries} entries; ` +
        tb.byCurrency.map((c) => `${c.currency} D ${c.debits} / C ${c.credits}${c.balanced ? '' : ' UNBALANCED'}`).join(', ')
      : 'trial balance unavailable',
    examples: unbalanced.length ? unbalanced : undefined,
  });
  const inv = input.invariants;
  checks.push({
    id: 'a.invariants',
    title: 'Ledger invariants (full re-check from raw entries)',
    ok: Boolean(inv?.ok),
    detail: inv ? (inv.ok ? 'ok' : `${inv.violations.length} violation(s)`) : 'invariants unavailable',
    examples: inv && !inv.ok ? sample(inv.violations) : undefined,
  });

  // (b) exactly one journal per reconciled payment, none for the others
  const journalProblems: { paymentId: string; status: string; journals: number | undefined; ledgerPostedEvents: number }[] = [];
  let reconciled = 0;
  for (const id of sent) {
    const p = log.payments.get(id);
    if (!p) continue;
    const want = p.state.status === 'reconciled' ? 1 : 0;
    if (p.state.status === 'reconciled') reconciled += 1;
    const have = input.journals?.byPayment.get(id);
    const terminal = isTerminal(p.state.status);
    if (terminal && (have !== want || p.ledgerPosted !== want)) {
      journalProblems.push({ paymentId: id, status: p.state.status, journals: have, ledgerPostedEvents: p.ledgerPosted });
    }
  }
  const total = input.journals?.totalJournals;
  const totalOk = total === undefined || (input.ownSystem ? total === reconciled : total >= reconciled);
  checks.push({
    id: 'b.journals',
    title: 'Exactly one ledger journal (and one ledger.posted) per reconciled payment; none for held/rejected/failed',
    ok: Boolean(input.journals) && journalProblems.length === 0 && totalOk,
    detail: input.journals
      ? `${reconciled} reconciled; ${journalProblems.length} mismatch(es)` + (total !== undefined ? `; ledger holds ${total} journal(s)${totalOk ? '' : ' (MISMATCH)'}` : '')
      : 'journal lookup unavailable',
    examples: journalProblems.length ? sample(journalProblems) : undefined,
  });

  // (c) log integrity
  checks.push({
    id: 'c.no-duplicate-events',
    title: 'Zero duplicate eventIds in the event log',
    ok: log.duplicates.length === 0 && log.gaps.length === 0,
    detail: `${log.events} events, ${log.eventIds.size} distinct eventIds, ${log.duplicates.length} duplicate(s)${log.gaps.length ? `, ${log.gaps.length} offset gap(s)` : ''}`,
    examples: log.duplicates.length ? sample(log.duplicates) : log.gaps.length ? sample(log.gaps) : undefined,
  });
  checks.push({
    id: 'c.state-machine',
    title: "Every payment's history is a valid state-machine walk",
    ok: log.invalid.length === 0,
    detail: `${log.invalid.length} event(s) refused by the state machine`,
    examples: log.invalid.length ? sample(log.invalid) : undefined,
  });
  const overAttempts = [...log.payments.values()].filter((p) => p.routed > MAX_ATTEMPTS || p.sendFailed > MAX_ATTEMPTS);
  checks.push({
    id: 'c.retry-bound',
    title: `At most ${MAX_ATTEMPTS} routing attempts per payment`,
    ok: overAttempts.length === 0,
    detail: `${overAttempts.length} payment(s) over the limit`,
    examples: overAttempts.length ? sample(overAttempts.map((p) => ({ paymentId: p.paymentId, routed: p.routed, sendFailed: p.sendFailed }))) : undefined,
  });

  // (d) nothing stuck
  const missing = sent.filter((id) => !log.payments.has(id));
  const stuck = sent.filter((id) => {
    const p = log.payments.get(id);
    return p && !isTerminal(p.state.status);
  });
  checks.push({
    id: 'd.all-terminal',
    title: 'Every payment reached a terminal status (reconciled/held/rejected/failed); every request accepted',
    ok: missing.length === 0 && stuck.length === 0 && input.trafficErrors === 0 && sent.length > 0,
    detail: `${sent.length} sent, ${input.trafficErrors} request error(s), ${missing.length} missing from the log, ${stuck.length} non-terminal`,
    examples:
      missing.length || stuck.length
        ? sample([...missing.map((id) => ({ paymentId: id, status: 'missing' })), ...stuck.map((id) => ({ paymentId: id, status: log.payments.get(id)!.state.status }))])
        : undefined,
  });

  // (e) gateway
  checks.push({
    id: 'e.gateway-rejected-events',
    title: 'Gateway /api/stats rejectedEvents = 0',
    ok: input.gatewayRejectedEvents === 0,
    detail: input.gatewayRejectedEvents === null || input.gatewayRejectedEvents === undefined ? 'gateway stats unavailable' : `rejectedEvents = ${input.gatewayRejectedEvents}`,
  });
  return checks;
}

export interface Breakdown {
  byStatus: Record<string, number>;
  byCorridor: Record<string, Record<string, number>>;
  byProvider: Record<string, Record<string, number>>;
  byScenario: Record<string, Record<string, number>>;
  retries: { sendFailedEvents: number; paymentsRetried: number; failedAfterRetries: number; reconciledAfterRetry: number };
  reconBreaks: number;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
}

function bump(m: Record<string, Record<string, number>>, k: string, s: string): void {
  const row = (m[k] ??= {});
  row[s] = (row[s] ?? 0) + 1;
  row.total = (row.total ?? 0) + 1;
}

function pct(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** (f) counts per corridor / status / provider / scenario, retries, recon breaks, end-to-end latency. */
export function breakdown(log: LogAnalyzer, sent: string[]): Breakdown {
  const out: Breakdown = {
    byStatus: {},
    byCorridor: {},
    byProvider: {},
    byScenario: {},
    retries: { sendFailedEvents: 0, paymentsRetried: 0, failedAfterRetries: 0, reconciledAfterRetry: 0 },
    reconBreaks: 0,
    latencyMs: { p50: null, p95: null, p99: null, max: null },
  };
  const latencies: number[] = [];
  for (const id of sent) {
    const p = log.payments.get(id);
    if (!p) continue;
    const { state } = p;
    out.byStatus[state.status] = (out.byStatus[state.status] ?? 0) + 1;
    bump(out.byCorridor, state.initiated.corridor, state.status);
    const provider = state.facts['payment.settled']?.providerId ?? state.facts['payment.routed']?.providerId ?? '(none)';
    bump(out.byProvider, provider, state.status);
    bump(out.byScenario, state.initiated.scenario ?? '(none)', state.status);
    out.retries.sendFailedEvents += p.sendFailed;
    if (p.sendFailed > 0) {
      out.retries.paymentsRetried += 1;
      if (state.status === 'failed') out.retries.failedAfterRetries += 1;
      if (state.status === 'reconciled') out.retries.reconciledAfterRetry += 1;
    }
    const rec = state.facts['payment.reconciled'];
    if (rec && (rec.matched === false || (rec.breaks?.length ?? 0) > 0)) out.reconBreaks += 1;
    if (p.terminalAt !== undefined) latencies.push(p.terminalAt - p.firstAt);
  }
  latencies.sort((a, b) => a - b);
  out.latencyMs = { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), p99: pct(latencies, 0.99), max: latencies.at(-1) ?? null };
  return out;
}
