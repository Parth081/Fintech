// Read-only views over the recorded log. Each view returns typed data whose numbers are Facts (citations
// with an exact eventId + field path + recorded value, or a labelled aggregate). The grounded templates and
// the LLM's read-only tools both read these views, so an answer can only contain what the log recorded.
import { PROVIDERS, type AnyEvent, type LedgerEntry, type Money, type ProviderScore } from '@ct/contracts';
import { aggFact, eventFact, mustFact, uniqueFacts, type Fact } from './facts';
import { allOf, lastOf, type FactStore, type PaymentRecord, type ScenarioRun } from './store';

const ms = (a: string, b: string) => Date.parse(b) - Date.parse(a);
const shortId = (id: string) => id.slice(0, 8);

function durationFact(from: AnyEvent, to: AnyEvent, label: string): Fact | undefined {
  const d = ms(from.occurredAt, to.occurredAt);
  if (!Number.isFinite(d) || d < 0) return undefined;
  return aggFact(d, label, 'ms', `${to.type}.occurredAt (${to.eventId}) - ${from.type}.occurredAt (${from.eventId})`, 'occurredAt');
}

// ---------------------------------------------------------------------------------------------
// Payment views

export interface PaymentOverview {
  rec: PaymentRecord;
  paymentId: string;
  status: string;
  statusFact: Fact;
  amount: Fact;
  corridor: Fact;
  targetAmount?: Fact;
  provider?: Fact;
  scenario?: Fact;
  facts: Fact[];
}

export function paymentOverview(rec: PaymentRecord): PaymentOverview {
  const init = rec.events[0]!.event as AnyEvent;
  const last = rec.events.at(-1)!.event;
  const statusFact: Fact = { eventId: last.eventId, eventType: last.type, field: 'type', value: last.type, label: `latest event (status ${rec.state.status})`, kind: 'text' };
  const amount = mustFact(init, 'payload.amount', 'amount sent', 'money');
  const corridor = mustFact(init, 'payload.corridor', 'corridor', 'text');
  const quoted = lastOf(rec, 'payment.quoted');
  const routed = lastOf(rec, 'payment.routed');
  const targetAmount = quoted ? eventFact(quoted, 'payload.targetAmount', 'amount the recipient gets', 'money') : undefined;
  const provider = routed ? eventFact(routed, 'payload.providerId', 'provider', 'text') : undefined;
  const scenario = eventFact(init, 'payload.scenario', 'scenario', 'text');
  const v: PaymentOverview = { rec, paymentId: rec.state.paymentId, status: rec.state.status, statusFact, amount, corridor, facts: [] };
  if (targetAmount) v.targetAmount = targetAmount;
  if (provider) v.provider = provider;
  if (scenario) v.scenario = scenario;
  v.facts = uniqueFacts([statusFact, amount, corridor, targetAmount, provider, scenario]);
  return v;
}

export interface HoldView {
  held?: { event: AnyEvent; reason: Fact; atStage: Fact; reasonCodes?: Fact };
  rejected?: { event: AnyEvent; reason: Fact; atStage: Fact; actor?: Fact; reasonCodes?: Fact };
  released?: { event: AnyEvent; actor: Fact; reason: Fact };
  fraudScore?: Fact;
  riskDecision?: Fact;
  screening?: Fact;
  alerts: { rule: Fact; severity: Fact; score?: Fact; summary: Fact }[];
  facts: Fact[];
}

export function holdView(rec: PaymentRecord): HoldView {
  const v: HoldView = { alerts: [], facts: [] };
  const held = lastOf(rec, 'payment.held');
  if (held) {
    v.held = {
      event: held,
      reason: mustFact(held, 'payload.reason', 'hold reason', 'text'),
      atStage: mustFact(held, 'payload.atStage', 'stage that held it', 'text'),
    };
    const rc = eventFact(held, 'trace.reasonCodes', 'decision reason codes', 'text');
    if (rc) v.held.reasonCodes = rc;
  }
  const rejected = lastOf(rec, 'payment.rejected');
  if (rejected) {
    v.rejected = {
      event: rejected,
      reason: mustFact(rejected, 'payload.reason', 'rejection reason', 'text'),
      atStage: mustFact(rejected, 'payload.atStage', 'stage that rejected it', 'text'),
    };
    const actor = eventFact(rejected, 'payload.actor.name', 'operator who rejected it', 'text');
    if (actor) v.rejected.actor = actor;
    const rc = eventFact(rejected, 'trace.reasonCodes', 'decision reason codes', 'text');
    if (rc) v.rejected.reasonCodes = rc;
  }
  const released = lastOf(rec, 'payment.released');
  if (released) {
    v.released = {
      event: released,
      actor: mustFact(released, 'payload.actor.name', 'operator who released it', 'text'),
      reason: mustFact(released, 'payload.reason', 'release reason', 'text'),
    };
  }
  const scored = lastOf(rec, 'payment.scored');
  if (scored) {
    v.fraudScore = mustFact(scored, 'payload.fraudScore', 'fraud score', 'score');
    v.riskDecision = mustFact(scored, 'payload.decision', 'risk decision', 'text');
  }
  const screened = lastOf(rec, 'payment.screened');
  if (screened) v.screening = mustFact(screened, 'payload.result', 'sanctions screening result', 'text');
  for (const a of allOf(rec, 'risk.alert_raised')) {
    const alert = {
      rule: mustFact(a, 'payload.rule', 'alert rule', 'text'),
      severity: mustFact(a, 'payload.severity', 'alert severity', 'text'),
      summary: mustFact(a, 'payload.summary', 'alert summary', 'text'),
    } as HoldView['alerts'][number];
    const score = eventFact(a, 'payload.score', 'alert score', 'score');
    if (score) alert.score = score;
    v.alerts.push(alert);
  }
  v.facts = uniqueFacts([
    v.held?.reason, v.held?.atStage, v.held?.reasonCodes,
    v.rejected?.reason, v.rejected?.atStage, v.rejected?.actor, v.rejected?.reasonCodes,
    v.released?.actor, v.released?.reason, v.fraudScore, v.riskDecision, v.screening,
    ...v.alerts.flatMap((a) => [a.rule, a.severity, a.score, a.summary]),
  ]);
  return v;
}

export interface ScoreRow {
  providerId: string;
  provider: Fact;
  eligible: boolean;
  excludedReason?: Fact;
  fee?: Fact;
  successRate?: Fact;
  latency?: Fact;
  score?: Fact;
}

export interface RouteView {
  routed: AnyEvent;
  chosenId: string;
  chosen: Fact;
  rail?: Fact;
  fee: Fact;
  attempt?: Fact;
  attemptNo: number;
  reasonCodes?: Fact;
  rows: ScoreRow[];
  weights: { success?: Fact; cost?: Fact; speed?: Fact };
  routedCount: Fact;
  facts: Fact[];
}

export function routeView(rec: PaymentRecord): RouteView | undefined {
  const routedAll = allOf(rec, 'payment.routed');
  const routed = routedAll.at(-1);
  if (!routed) return undefined;
  const p = routed.payload;
  const rows: ScoreRow[] = [];
  const scoring: ProviderScore[] = Array.isArray(p.scoring) ? p.scoring : [];
  scoring.forEach((s, i) => {
    const base = `payload.scoring[${i}]`;
    const name = s.providerId;
    const row: ScoreRow = { providerId: s.providerId, provider: mustFact(routed, `${base}.providerId`, 'provider', 'text'), eligible: s.eligible === true };
    const ex = eventFact(routed, `${base}.excludedReason`, `${name} excluded because`, 'text');
    if (ex) row.excludedReason = ex;
    const fee = eventFact(routed, `${base}.fee`, `${name} fee`, 'money');
    if (fee) row.fee = fee;
    const sr = eventFact(routed, `${base}.successRate`, `${name} success rate`, 'ratio');
    if (sr) row.successRate = sr;
    const lat = eventFact(routed, `${base}.latencyMs`, `${name} expected time`, 'ms');
    if (lat) row.latency = lat;
    if (row.eligible) {
      const sc = eventFact(routed, `${base}.score`, `${name} score`, 'score');
      if (sc) row.score = sc;
    }
    rows.push(row);
  });
  if (rows.length === 0) {
    // pre-M2 events: only alternatives with scores
    p.alternatives.forEach((a, i) => {
      const row: ScoreRow = { providerId: a.providerId, provider: mustFact(routed, `payload.alternatives[${i}].providerId`, 'alternative provider', 'text'), eligible: true };
      const sc = eventFact(routed, `payload.alternatives[${i}].score`, `${a.providerId} score`, 'score');
      if (sc) row.score = sc;
      rows.push(row);
    });
  }
  const v: RouteView = {
    routed,
    chosenId: p.providerId,
    chosen: mustFact(routed, 'payload.providerId', 'chosen provider', 'text'),
    fee: mustFact(routed, 'payload.estimatedFee', 'estimated provider fee', 'money'),
    attemptNo: p.attempt ?? 1,
    rows,
    weights: {},
    routedCount: aggFact(routedAll.length, 'routing decisions for this payment', 'count', 'count of payment.routed events for this payment'),
    facts: [],
  };
  const rail = eventFact(routed, 'payload.rail', 'rail', 'text');
  if (rail) v.rail = rail;
  const attempt = eventFact(routed, 'payload.attempt', 'attempt number', 'count');
  if (attempt) v.attempt = attempt;
  const rc = eventFact(routed, 'trace.reasonCodes', 'routing reason codes', 'text');
  if (rc) v.reasonCodes = rc;
  for (const k of ['success', 'cost', 'speed'] as const) {
    const w = eventFact(routed, `trace.inputs.weights.${k}`, `weight on ${k}`, 'ratio');
    if (w) v.weights[k] = w;
  }
  v.facts = uniqueFacts([
    v.chosen, v.rail, v.fee, v.attempt, v.reasonCodes, v.routedCount, v.weights.success, v.weights.cost, v.weights.speed,
    ...rows.flatMap((r) => [r.provider, r.excludedReason, r.fee, r.successRate, r.latency, r.score]),
  ]);
  return v;
}

export interface RetryView {
  failures: { event: AnyEvent; provider: Fact; attempt: Fact; reasonCode: Fact; reason: Fact }[];
  reroutes: { event: AnyEvent; provider: Fact; attempt?: Fact }[];
  failed?: { reason: Fact; attempts?: Fact };
  retryRequested?: { actor: Fact; reason: Fact };
  settledBy?: Fact;
  failureCount: Fact;
  facts: Fact[];
}

export function retryView(rec: PaymentRecord): RetryView {
  const failures = allOf(rec, 'payment.send_failed').map((e) => ({
    event: e as AnyEvent,
    provider: mustFact(e, 'payload.providerId', 'provider that refused it', 'text'),
    attempt: mustFact(e, 'payload.attempt', 'attempt number', 'count'),
    reasonCode: mustFact(e, 'payload.reasonCode', 'ISO 20022 status reason code', 'text'),
    reason: mustFact(e, 'payload.reason', 'status reason', 'text'),
  }));
  const reroutes = allOf(rec, 'payment.routed').slice(1).map((e) => {
    const r: RetryView['reroutes'][number] = { event: e, provider: mustFact(e, 'payload.providerId', 'provider chosen for the retry', 'text') };
    const a = eventFact(e, 'payload.attempt', 'attempt number', 'count');
    if (a) r.attempt = a;
    return r;
  });
  const v: RetryView = {
    failures,
    reroutes,
    failureCount: aggFact(failures.length, 'provider refusals for this payment', 'count', 'count of payment.send_failed events for this payment'),
    facts: [],
  };
  const failed = lastOf(rec, 'payment.failed');
  if (failed) {
    v.failed = { reason: mustFact(failed, 'payload.reason', 'failure reason', 'text') };
    const att = eventFact(failed, 'payload.attempts', 'attempts made', 'count');
    if (att) v.failed.attempts = att;
  }
  const rr = lastOf(rec, 'payment.retry_requested');
  if (rr) v.retryRequested = { actor: mustFact(rr, 'payload.actor.name', 'operator who asked for a retry', 'text'), reason: mustFact(rr, 'payload.reason', 'retry reason', 'text') };
  const settled = lastOf(rec, 'payment.settled');
  if (settled) v.settledBy = mustFact(settled, 'payload.providerId', 'provider that settled it', 'text');
  v.facts = uniqueFacts([
    v.failureCount, ...failures.flatMap((f) => [f.provider, f.attempt, f.reasonCode, f.reason]),
    ...reroutes.flatMap((r) => [r.provider, r.attempt]), v.failed?.reason, v.failed?.attempts,
    v.retryRequested?.actor, v.retryRequested?.reason, v.settledBy,
  ]);
  return v;
}

export interface FxView {
  quoted: AnyEvent;
  midRate?: Fact;
  spreadBps: Fact;
  rate: Fact;
  source: Fact;
  target: Fact;
  fee?: Fact;
  spreadCost?: Fact;
  totalCost?: Fact;
  settledAmount?: Fact;
  facts: Fact[];
}

export function fxView(rec: PaymentRecord): FxView | undefined {
  const quoted = lastOf(rec, 'payment.quoted');
  if (!quoted) return undefined;
  const q = quoted.payload;
  const v: FxView = {
    quoted,
    spreadBps: mustFact(quoted, 'payload.spreadBps', 'FX spread', 'bps'),
    rate: mustFact(quoted, 'payload.rate', 'customer rate (spread applied)', 'rate'),
    source: mustFact(quoted, 'payload.sourceAmount', 'amount converted', 'money'),
    target: mustFact(quoted, 'payload.targetAmount', 'amount the recipient gets', 'money'),
    facts: [],
  };
  const mid = eventFact(quoted, 'payload.midRate', 'market mid rate', 'rate');
  if (mid) v.midRate = mid;
  const spreadMinor = Math.round((q.sourceAmount.amountMinor * q.spreadBps) / 10_000);
  v.spreadCost = aggFact(
    { amountMinor: spreadMinor, currency: q.sourceAmount.currency } satisfies Money,
    'spread cost (amount x spread bps / 10,000, rounded to the minor unit)',
    'money',
    `payment.quoted (${quoted.eventId}) payload.sourceAmount x payload.spreadBps / 10000`,
  );
  const routed = lastOf(rec, 'payment.routed');
  if (routed) {
    v.fee = mustFact(routed, 'payload.estimatedFee', 'provider fee', 'money');
    const fee = routed.payload.estimatedFee;
    if (fee.currency === q.sourceAmount.currency) {
      v.totalCost = aggFact(
        { amountMinor: fee.amountMinor + spreadMinor, currency: fee.currency } satisfies Money,
        'total cost (provider fee + spread cost)',
        'money',
        `payment.routed (${routed.eventId}) payload.estimatedFee + spread cost`,
      );
    }
  }
  const settled = lastOf(rec, 'payment.settled');
  if (settled) {
    const sa = eventFact(settled, 'payload.settledAmount', 'amount the provider delivered', 'money');
    if (sa) v.settledAmount = sa;
  }
  v.facts = uniqueFacts([v.midRate, v.spreadBps, v.rate, v.source, v.target, v.fee, v.spreadCost, v.totalCost, v.settledAmount]);
  return v;
}

export interface TimelineView {
  total: Fact;
  totalLabel: 'reconciled' | 'so far';
  checks?: Fact;
  quoteAndRoute?: Fact;
  provider?: Fact;
  reconcile?: Fact;
  stages: Fact;
  started: Fact;
  facts: Fact[];
}

export function timelineView(rec: PaymentRecord): TimelineView {
  const init = rec.events[0]!.event;
  const last = rec.events.at(-1)!.event;
  const recon = lastOf(rec, 'payment.reconciled');
  const end = recon ?? last;
  const v: TimelineView = {
    total: durationFact(init, end, recon ? 'time from initiation to reconciliation' : 'time from initiation to the latest event')
      ?? aggFact(0, 'elapsed', 'ms', 'no positive duration'),
    totalLabel: recon ? 'reconciled' : 'so far',
    stages: aggFact(rec.events.length, 'recorded events for this payment', 'count', 'count of events for this payment'),
    started: mustFact(init, 'occurredAt', 'initiated at', 'time'),
    facts: [],
  };
  const scored = lastOf(rec, 'payment.scored');
  const routed = allOf(rec, 'payment.routed')[0];
  const sent = lastOf(rec, 'payment.sent');
  const settled = lastOf(rec, 'payment.settled');
  if (scored) {
    const f = durationFact(init, scored, 'screening and risk checks');
    if (f) v.checks = f;
    if (routed) {
      const g = durationFact(scored, routed, 'FX quote and routing');
      if (g) v.quoteAndRoute = g;
    }
  }
  if (sent && settled) {
    const f = durationFact(sent, settled, 'provider settlement after the instruction was sent');
    if (f) v.provider = f;
  }
  if (settled && recon) {
    const f = durationFact(settled, recon, 'reconciliation after settlement');
    if (f) v.reconcile = f;
  }
  v.facts = uniqueFacts([v.total, v.checks, v.quoteAndRoute, v.provider, v.reconcile, v.stages, v.started]);
  return v;
}

export interface JournalView {
  journalId: Fact;
  entries: { account: Fact; direction: Fact; amount: Fact }[];
  totals: { currency: string; debits: Fact; credits: Fact }[];
  balanced: boolean;
  reconciled?: { matched: Fact; statementRef: Fact };
  refundJournal?: Fact;
  facts: Fact[];
}

function totalsOf(entries: LedgerEntry[], source: string): JournalView['totals'] {
  const by = new Map<string, { d: number; c: number }>();
  for (const e of entries) {
    const t = by.get(e.amount.currency) ?? { d: 0, c: 0 };
    if (e.direction === 'debit') t.d += e.amount.amountMinor;
    else t.c += e.amount.amountMinor;
    by.set(e.amount.currency, t);
  }
  return [...by.entries()].map(([currency, t]) => ({
    currency,
    debits: aggFact({ amountMinor: t.d, currency }, `total debits in ${currency}`, 'money', `sum of debit entries in ${source}`),
    credits: aggFact({ amountMinor: t.c, currency }, `total credits in ${currency}`, 'money', `sum of credit entries in ${source}`),
  }));
}

export function journalView(rec: PaymentRecord): JournalView | undefined {
  const posted = lastOf(rec, 'ledger.posted');
  if (!posted) return undefined;
  const entries = posted.payload.entries.map((e, i) => ({
    account: mustFact(posted, `payload.entries[${i}].account`, 'account', 'text'),
    direction: mustFact(posted, `payload.entries[${i}].direction`, 'debit or credit', 'text'),
    amount: mustFact(posted, `payload.entries[${i}].amount`, `${e.direction} ${e.account}`, 'money'),
  }));
  const totals = totalsOf(posted.payload.entries, `ledger.posted ${posted.eventId}`);
  const v: JournalView = {
    journalId: mustFact(posted, 'payload.journalId', 'journal id', 'text'),
    entries,
    totals,
    balanced: totals.every((t) => (t.debits.value as Money).amountMinor === (t.credits.value as Money).amountMinor),
    facts: [],
  };
  const recon = lastOf(rec, 'payment.reconciled');
  if (recon) v.reconciled = { matched: mustFact(recon, 'payload.matched', 'statement matched', 'text'), statementRef: mustFact(recon, 'payload.statementRef', 'statement reference', 'text') };
  const refunded = lastOf(rec, 'payment.refunded');
  if (refunded) v.refundJournal = mustFact(refunded, 'payload.journalId', 'refund (reversal) journal id', 'text');
  v.facts = uniqueFacts([
    v.journalId, ...entries.flatMap((e) => [e.account, e.direction, e.amount]), ...totals.flatMap((t) => [t.debits, t.credits]),
    v.reconciled?.matched, v.reconciled?.statementRef, v.refundJournal,
  ]);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Aggregate views (system and scenario)

export interface TrialBalanceView {
  journals: Fact;
  unbalanced: Fact;
  totals: { currency: string; debits: Fact; credits: Fact }[];
  facts: Fact[];
}

export function trialBalance(records: Iterable<PaymentRecord>, scope: string): TrialBalanceView {
  const entries: LedgerEntry[] = [];
  let journals = 0;
  let unbalanced = 0;
  for (const r of records) {
    for (const x of r.events) {
      const e = x.event;
      if (e.type !== 'ledger.posted' && e.type !== 'payment.refunded') continue;
      journals += 1;
      const t = totalsOf(e.payload.entries, 'journal');
      if (!t.every((y) => (y.debits.value as Money).amountMinor === (y.credits.value as Money).amountMinor)) unbalanced += 1;
      entries.push(...e.payload.entries);
    }
  }
  const totals = totalsOf(entries, `every journal (${scope})`);
  const v: TrialBalanceView = {
    journals: aggFact(journals, `journals posted (${scope})`, 'count', `count of ledger.posted and payment.refunded events (${scope})`),
    unbalanced: aggFact(unbalanced, `unbalanced journals (${scope})`, 'count', `journals whose debits differ from credits in any currency (${scope})`),
    totals,
    facts: [],
  };
  v.facts = uniqueFacts([v.journals, v.unbalanced, ...totals.flatMap((t) => [t.debits, t.credits])]);
  return v;
}

export interface ProviderHealthRow {
  providerId: string;
  name: string;
  attempts: Fact;
  settled: Fact;
  refused: Fact;
  successRate?: Fact;
  breaker?: Fact;
}

export interface ProviderHealthView {
  rows: ProviderHealthRow[];
  facts: Fact[];
}

export function providerHealthView(records: Iterable<PaymentRecord>, scope: string): ProviderHealthView {
  const stats = new Map<string, { sent: number; settled: number; refused: number }>();
  for (const p of PROVIDERS) stats.set(p.id, { sent: 0, settled: 0, refused: 0 });
  let latestRouted: { offset: number; event: AnyEvent } | undefined;
  for (const r of records) {
    for (const x of r.events) {
      const e = x.event;
      if (e.type === 'payment.sent' || e.type === 'payment.settled' || e.type === 'payment.send_failed') {
        const s = stats.get(e.payload.providerId) ?? { sent: 0, settled: 0, refused: 0 };
        if (e.type === 'payment.sent') s.sent += 1;
        else if (e.type === 'payment.settled') s.settled += 1;
        else s.refused += 1;
        stats.set(e.payload.providerId, s);
      }
      if (e.type === 'payment.routed' && (!latestRouted || x.offset > latestRouted.offset)) latestRouted = x;
    }
  }
  const rows: ProviderHealthRow[] = [];
  for (const [id, s] of stats) {
    const name = PROVIDERS.find((p) => p.id === id)?.name ?? id;
    const row: ProviderHealthRow = {
      providerId: id,
      name,
      attempts: aggFact(s.sent, `${id} instructions sent (${scope})`, 'count', `count of payment.sent with providerId ${id} (${scope})`),
      settled: aggFact(s.settled, `${id} settled (${scope})`, 'count', `count of payment.settled with providerId ${id} (${scope})`),
      refused: aggFact(s.refused, `${id} refused (${scope})`, 'count', `count of payment.send_failed with providerId ${id} (${scope})`),
    };
    if (s.settled + s.refused > 0) {
      row.successRate = aggFact(s.settled / (s.settled + s.refused), `${id} success rate (${scope})`, 'ratio', `settled / (settled + refused) for ${id} (${scope})`);
    }
    if (latestRouted) {
      const b = eventFact(latestRouted.event, `trace.inputs.breakers.${id}.state`, `${id} circuit breaker at the latest routing decision`, 'text');
      if (b) row.breaker = b;
    }
    rows.push(row);
  }
  return { rows, facts: uniqueFacts(rows.flatMap((r) => [r.attempts, r.settled, r.refused, r.successRate, r.breaker])) };
}

export interface TotalsView {
  payments: Fact;
  byStatus: { status: string; count: Fact }[];
  reconciledValue: Fact[];
  retries: Fact;
  avgEndToEnd?: Fact;
  facts: Fact[];
}

export function totalsView(records: Iterable<PaymentRecord>, scope: string): TotalsView {
  let n = 0;
  let retries = 0;
  let e2eSum = 0;
  let e2eCount = 0;
  const byStatus = new Map<string, number>();
  const value = new Map<string, number>();
  for (const r of records) {
    n += 1;
    byStatus.set(r.state.status, (byStatus.get(r.state.status) ?? 0) + 1);
    for (const x of r.events) if (x.event.type === 'payment.send_failed') retries += 1;
    if (r.state.status === 'reconciled' || r.state.status === 'refund_requested' || r.state.status === 'refunded') {
      const a = r.state.initiated.amount;
      value.set(a.currency, (value.get(a.currency) ?? 0) + a.amountMinor);
    }
    if (r.state.status === 'reconciled') {
      const d = ms(r.state.createdAt, r.state.updatedAt);
      if (Number.isFinite(d)) {
        e2eSum += d;
        e2eCount += 1;
      }
    }
  }
  const order = ['reconciled', 'settled', 'sent', 'routed', 'quoted', 'scored', 'screened', 'initiated', 'retrying', 'held', 'rejected', 'failed', 'refund_requested', 'refunded'];
  const v: TotalsView = {
    payments: aggFact(n, `payments (${scope})`, 'count', `count of payment.initiated (${scope})`),
    byStatus: [...byStatus.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([status, c]) => ({ status, count: aggFact(c, `payments now ${status} (${scope})`, 'count', `payments whose latest status is ${status} (${scope})`) })),
    reconciledValue: [...value.entries()].sort().map(([currency, minor]) =>
      aggFact({ amountMinor: minor, currency }, `value of reconciled payments in ${currency} (${scope})`, 'money', `sum of payment.initiated amount for reconciled payments (${scope})`)),
    retries: aggFact(retries, `provider refusals retried (${scope})`, 'count', `count of payment.send_failed (${scope})`),
    facts: [],
  };
  if (e2eCount > 0) v.avgEndToEnd = aggFact(Math.round(e2eSum / e2eCount), `average time to reconcile (${scope})`, 'ms', `mean of reconciled.occurredAt - initiated.occurredAt (${scope})`);
  v.facts = uniqueFacts([v.payments, ...v.byStatus.map((b) => b.count), ...v.reconciledValue, v.retries, v.avgEndToEnd]);
  return v;
}

export interface OutageInfo {
  providerId: string;
  provider: Fact;
  mode: Fact;
  failureRate?: Fact;
  startedAt: Fact;
  endedAt?: Fact;
  duration?: Fact;
  breakerOpenedAt?: Fact;
  breakerOpenState?: Fact;
  breakerClosedAt?: Fact;
  breakerClosedState?: Fact;
  refused: Fact;
  steeredAway: Fact;
  retriedElsewhere: Fact;
}

export interface ScenarioView {
  run: ScenarioRun;
  title: Fact;
  scenarioId: Fact;
  startedAt: Fact;
  endedAt?: Fact;
  outcome?: Fact;
  duration?: Fact;
  outages: OutageInfo[];
  payments: Fact;
  reconciled: Fact;
  failed: Fact;
  held: Fact;
  rejected: Fact;
  inFlight: Fact;
  lost: Fact;
  rerouted: Fact;
  trial: TrialBalanceView;
  facts: Fact[];
}

const IN_FLIGHT = new Set(['initiated', 'screened', 'scored', 'quoted', 'routed', 'sent', 'settled', 'retrying', 'refund_requested']);

function breakerState(e: AnyEvent, providerId: string): string | undefined {
  if (e.type !== 'payment.routed') return undefined;
  const fromTrace = (e.trace?.inputs as { breakers?: Record<string, { state?: string }> } | undefined)?.breakers?.[providerId]?.state;
  if (typeof fromTrace === 'string') return fromTrace;
  const row = e.payload.scoring?.find((s) => s.providerId === providerId);
  if (row?.excludedReason === 'CIRCUIT_OPEN') return 'open';
  if (row?.excludedReason === 'CIRCUIT_HALF_OPEN') return 'half-open';
  return undefined;
}

function breakerFact(e: AnyEvent, providerId: string, label: string): Fact | undefined {
  const viaTrace = eventFact(e, `trace.inputs.breakers.${providerId}.state`, label, 'text');
  if (viaTrace) return viaTrace;
  if (e.type !== 'payment.routed') return undefined;
  const i = e.payload.scoring?.findIndex((s) => s.providerId === providerId) ?? -1;
  return i >= 0 ? eventFact(e, `payload.scoring[${i}].excludedReason`, label, 'text') : undefined;
}

export function scenarioView(store: FactStore, run: ScenarioRun): ScenarioView {
  const payments = store.paymentsInRun(run);
  const control = store.controlInRun(run);
  const scope = `run ${run.runId}`;
  const routedInRun: { offset: number; event: AnyEvent }[] = [];
  for (const p of payments) for (const x of p.events) if (x.event.type === 'payment.routed') routedInRun.push(x);
  routedInRun.sort((a, b) => a.offset - b.offset);

  const outages: OutageInfo[] = [];
  for (const c of control) {
    if (c.event.type !== 'control.provider_outage.started') continue;
    const start = c.event;
    const pid = start.payload.providerId;
    const endX = control.find((y) => y.offset > c.offset && y.event.type === 'control.provider_outage.ended' && y.event.payload.providerId === pid);
    const info: OutageInfo = {
      providerId: pid,
      provider: mustFact(start, 'payload.providerId', 'provider with the outage', 'text'),
      mode: mustFact(start, 'payload.mode', 'outage mode', 'text'),
      startedAt: mustFact(start, 'occurredAt', `${pid} outage started at`, 'time'),
      refused: aggFact(0, '', 'count', ''),
      steeredAway: aggFact(0, '', 'count', ''),
      retriedElsewhere: aggFact(0, '', 'count', ''),
    };
    const fr = eventFact(start, 'payload.failureRate', `${pid} share of instructions refused during the outage`, 'ratio');
    if (fr) info.failureRate = fr;
    if (endX) {
      info.endedAt = mustFact(endX.event, 'occurredAt', `${pid} outage ended at`, 'time');
      const d = ms(start.occurredAt, endX.event.occurredAt);
      info.duration = aggFact(d, `${pid} outage duration`, 'ms', `control.provider_outage.ended (${endX.event.eventId}) - started (${start.eventId}) occurredAt`, 'occurredAt');
    }
    // breaker: first routing decision after the outage start that saw it open, then the first one that saw it closed again
    const opened = routedInRun.find((x) => x.offset > c.offset && breakerState(x.event, pid) === 'open');
    if (opened) {
      info.breakerOpenedAt = mustFact(opened.event, 'occurredAt', `routing first saw the ${pid} breaker open at`, 'time');
      const bf = breakerFact(opened.event, pid, `${pid} breaker state`);
      if (bf) info.breakerOpenState = bf;
      const closed = routedInRun.find((x) => x.offset > opened.offset && breakerState(x.event, pid) === 'closed');
      if (closed) {
        info.breakerClosedAt = mustFact(closed.event, 'occurredAt', `routing first saw the ${pid} breaker closed again at`, 'time');
        const cf = breakerFact(closed.event, pid, `${pid} breaker state`);
        if (cf) info.breakerClosedState = cf;
      }
    }
    let refused = 0;
    let steered = 0;
    let retried = 0;
    for (const p of payments) {
      const evs = p.events.map((x) => x.event);
      const fails = evs.filter((e) => e.type === 'payment.send_failed' && e.payload.providerId === pid);
      refused += fails.length;
      if (evs.some((e) => e.type === 'payment.routed' && e.payload.providerId !== pid && (e.trace?.reasonCodes ?? []).some((rc) => rc === 'CIRCUIT_OPEN_REROUTED' || rc === 'CIRCUIT_HALF_OPEN_REROUTED') && breakerState(e, pid) !== undefined && breakerState(e, pid) !== 'closed')) steered += 1;
      const lastFail = p.events.filter((x) => x.event.type === 'payment.send_failed' && x.event.payload.providerId === pid).at(-1);
      if (lastFail && p.events.some((x) => x.offset > lastFail.offset && x.event.type === 'payment.routed' && x.event.payload.providerId !== pid)) retried += 1;
    }
    info.refused = aggFact(refused, `instructions ${pid} refused in the run`, 'count', `count of payment.send_failed with providerId ${pid} for payments in ${scope}`);
    info.steeredAway = aggFact(steered, `payments the ${pid} breaker steered to another provider`, 'count', `payments in ${scope} with a routing decision coded CIRCUIT_OPEN_REROUTED/CIRCUIT_HALF_OPEN_REROUTED while ${pid} was blocked`);
    info.retriedElsewhere = aggFact(retried, `payments ${pid} refused that were retried with another provider`, 'count', `payments in ${scope} with a send_failed from ${pid} followed by a routing decision for another provider`);
    outages.push(info);
  }

  const count = (pred: (s: string) => boolean) => payments.filter((p) => pred(p.state.status)).length;
  const reroutedAny = payments.filter((p) => {
    const routes = p.events.filter((x) => x.event.type === 'payment.routed').map((x) => x.event as Extract<AnyEvent, { type: 'payment.routed' }>);
    return routes.length > 1 || routes.some((e) => (e.trace?.reasonCodes ?? []).some((rc) => rc.endsWith('_REROUTED')));
  }).length;
  // Lost: money moved inconsistently: a journal for a payment that then failed, or a settled payment never posted
  const lost = payments.filter((p) => (p.state.status === 'failed' && p.state.ledgerPosted) || (p.state.status === 'reconciled' && !p.state.ledgerPosted)).length;
  const trial = trialBalance(payments, scope);
  const v: ScenarioView = {
    run,
    title: mustFact(run.started.event, 'payload.title', 'scenario', 'text'),
    scenarioId: mustFact(run.started.event, 'payload.scenarioId', 'scenario id', 'text'),
    startedAt: mustFact(run.started.event, 'occurredAt', 'scenario started at', 'time'),
    outages,
    payments: aggFact(payments.length, `payments started during the run`, 'count', `payments first seen between control.scenario.started and .ended (${scope})`),
    reconciled: aggFact(count((s) => s === 'reconciled'), 'payments reconciled', 'count', `payments in ${scope} with status reconciled`),
    failed: aggFact(count((s) => s === 'failed'), 'payments failed (nothing posted)', 'count', `payments in ${scope} with status failed`),
    held: aggFact(count((s) => s === 'held'), 'payments held for review', 'count', `payments in ${scope} with status held`),
    rejected: aggFact(count((s) => s === 'rejected'), 'payments rejected', 'count', `payments in ${scope} with status rejected`),
    inFlight: aggFact(count((s) => IN_FLIGHT.has(s)), 'payments still in flight', 'count', `payments in ${scope} not yet in a final status`),
    lost: aggFact(lost, 'payments lost', 'count', `payments in ${scope} that failed after a ledger posting or reconciled without one`),
    rerouted: aggFact(reroutedAny, 'payments re-routed (breaker or retry)', 'count', `payments in ${scope} with more than one routing decision or a *_REROUTED reason code`),
    trial,
    facts: [],
  };
  if (run.ended) {
    v.endedAt = mustFact(run.ended.event, 'occurredAt', 'scenario ended at', 'time');
    v.outcome = mustFact(run.ended.event, 'payload.outcome', 'scenario outcome', 'text');
    v.duration = aggFact(ms(run.started.event.occurredAt, run.ended.event.occurredAt), 'scenario duration', 'ms', `control.scenario.ended (${run.ended.event.eventId}) - started (${run.started.event.eventId}) occurredAt`, 'occurredAt');
  }
  v.facts = uniqueFacts([
    v.title, v.scenarioId, v.startedAt, v.endedAt, v.outcome, v.duration,
    ...outages.flatMap((o) => [o.provider, o.mode, o.failureRate, o.startedAt, o.endedAt, o.duration, o.breakerOpenedAt, o.breakerOpenState, o.breakerClosedAt, o.breakerClosedState, o.refused, o.steeredAway, o.retriedElsewhere]),
    v.payments, v.reconciled, v.failed, v.held, v.rejected, v.inFlight, v.lost, v.rerouted, ...trial.facts,
  ]);
  return v;
}

export { shortId };
