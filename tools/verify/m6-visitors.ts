// verify:m6 virtual kiosk visitors. Each visit is a scripted walk through exactly the HTTP calls the kiosk
// makes (apps/web/src/kiosk): POST /api/payments with the kiosk's body and an Idempotency-Key, poll the
// payment, ask the assistant about it, post anonymous analytics, submit a lead with consent. The kiosk's own
// pure modules (payment.ts, lead.ts, analytics.ts, explain.ts) are reused, so the script cannot drift from it.
//
// makeVisitScripts() is deterministic (seed -> same scripts); runVisit() does the I/O and returns a
// VisitSummary whose `issues` feed visitChecks() in m6-analyze.ts.
import { isTerminal as isTerminalStatus, type AnyEvent, type PaymentStatus } from '@ct/contracts';
import { newSessionId } from '../../apps/web/src/kiosk/analytics';
import { ledgerBalanced } from '../../apps/web/src/kiosk/explain';
import { emptyLeadForm, toLeadInput } from '../../apps/web/src/kiosk/lead';
import { buildPaymentRequest, amountChips, CORRIDOR_CARDS } from '../../apps/web/src/kiosk/payment';
import { hash32, mulberry32 } from '../traffic/generator';
import { http, isTransient, sleep, type HttpResult } from './m6-http';
import type { VisitIssue, VisitSummary } from './m6-analyze';

export type AbandonPoint = 'before-pay' | 'mid-tracking' | null;

export interface VisitScript {
  index: number;
  corridorId: string;
  amountMajor: number;
  mode: 'send' | 'fail';
  abandon: AbandonPoint;
  /** How many suggested questions the visitor asks (0..3). */
  asks: number;
  lead: boolean;
  /** Run together with the next visitor (two people at the kiosk wall). */
  concurrentWithNext: boolean;
  /** Idle gap after this visit, ms. */
  idleAfterMs: number;
  /** Probe the consent / privacy rules during this visit. */
  probes: boolean;
  /** Seed for ids inside the visit (sessions, account numbers). */
  seed: number;
}

/** Deterministic visitor scripts: the same (seed, count) always yields the same list. */
export function makeVisitScripts(seed: number, count: number): VisitScript[] {
  const out: VisitScript[] = [];
  for (let i = 0; i < count; i++) {
    const rand = mulberry32(hash32(`m6:${seed}:${i}`));
    const card = CORRIDOR_CARDS[Math.floor(rand() * CORRIDOR_CARDS.length)]!;
    const chips = amountChips(card.id);
    const roll = rand();
    out.push({
      index: i,
      corridorId: card.id,
      amountMajor: chips[Math.floor(rand() * chips.length)]!,
      mode: rand() < 0.35 ? 'fail' : 'send',
      abandon: roll < 0.08 ? 'before-pay' : roll < 0.18 ? 'mid-tracking' : null,
      asks: Math.floor(rand() * 4),
      lead: rand() < 0.3,
      concurrentWithNext: rand() < 0.25,
      idleAfterMs: rand() < 0.3 ? Math.round(rand() * 1500) : 0,
      probes: i % 3 === 0,
      seed: Math.floor(rand() * 2 ** 31),
    });
  }
  return out;
}

export interface VisitContext {
  gateway: string;
  /** Staff PIN, to read leads back. */
  staffPin: string;
  /** True while services are being killed: transient errors on optional calls are tolerated (the kiosk hides them). */
  tolerateTransient: () => boolean;
  /** How long a visitor keeps retrying a payment POST / lead POST (same idempotency key) before giving up. */
  retryBudgetMs: number;
  /** How long a payment may take to reach a terminal status. */
  terminalBudgetMs: number;
  now?: () => number;
}

const LEAD_INTERESTS = ['cross-border', 'orchestration', 'risk-compliance', 'ledger-recon', 'ai', 'other'] as const;

function randomBytesFrom(rand: () => number): (n: number) => Uint8Array {
  return (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
}

/** Debits = credits per currency in a ledger journal (JournalView.entries). */
export function journalBalanced(entries: readonly { direction: string; amount: { amountMinor: number; currency: string } }[]): boolean {
  if (entries.length === 0) return false;
  const net = new Map<string, number>();
  for (const e of entries) net.set(e.amount.currency, (net.get(e.amount.currency) ?? 0) + (e.direction === 'debit' ? 1 : -1) * e.amount.amountMinor);
  return [...net.values()].every((v) => v === 0);
}

interface PaymentDetailBody {
  state?: { status?: PaymentStatus };
  events?: AnyEvent[];
}

export async function runVisit(script: VisitScript, ctx: VisitContext): Promise<VisitSummary> {
  const gw = ctx.gateway;
  const rand = mulberry32(script.seed);
  const issues: VisitIssue[] = [];
  const issue = (code: string, detail: string): void => {
    issues.push({ visit: script.index, code, detail });
  };
  const sum: VisitSummary = {
    visit: script.index,
    paymentId: null,
    status: null,
    mode: script.mode,
    abandoned: script.abandon !== null,
    leadId: null,
    leadAttempted: false,
    questions: 0,
    verifiedAnswers: 0,
    transient: 0,
    issues,
  };
  const sessionId = newSessionId(randomBytesFrom(rand));
  const events: { sessionId: string; type: string; at: string; data?: Record<string, string | number | boolean> }[] = [];
  const track = (type: string, data?: Record<string, string | number | boolean>): void => {
    events.push({ sessionId, type, at: new Date().toISOString(), ...(data ? { data } : {}) });
  };
  const tolerated = (r: HttpResult): boolean => isTransient(r.status) && ctx.tolerateTransient();
  const flush = async (): Promise<void> => {
    while (events.length) {
      const batch = events.splice(0, 50);
      const r = await retryWhile(() => http('POST', `${gw}/api/booth/analytics`, { events: batch }), (x) => x.status !== 200 && (isTransient(x.status) && ctx.tolerateTransient()), 15_000);
      if (r.status !== 200) {
        if (tolerated(r)) sum.transient += 1;
        else issue('analytics-rejected', `POST /api/booth/analytics -> ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
  };

  // The kiosk tells the orchestrator someone is at the booth (stops the attract loop).
  await http('POST', `${gw}/api/control/orchestrator/attract/touch`, {}, {}, 3_000);
  track('visit.start');
  track('scenario.viewed', { scenarioId: script.mode === 'fail' ? 'provider-fails' : 'send-payment' });

  if (script.abandon === 'before-pay') {
    track('visit.end', { reason: 'idle', seconds: 3 });
    await flush();
    return sum;
  }

  // 1. Send the payment, exactly like the kiosk (a failed POST is retried with the SAME idempotency key).
  const body = buildPaymentRequest(script.corridorId, script.amountMajor, script.mode, rand);
  const key = `kiosk-m6-${script.seed.toString(16)}-${script.index}`;
  const created = await retryWhile(
    () => http<{ paymentId?: string; error?: string }>('POST', `${gw}/api/payments`, body, { 'idempotency-key': key }, 10_000),
    (r) => isTransient(r.status),
    ctx.retryBudgetMs,
    (r) => {
      sum.transient += 1;
      void r;
    },
  );
  const paymentId = created.status >= 200 && created.status < 300 && typeof created.body?.paymentId === 'string' ? created.body.paymentId : null;
  if (!paymentId) {
    issue('payment-rejected', `POST /api/payments -> ${created.status} ${created.text.slice(0, 160) || created.error || ''}`);
    return sum;
  }
  sum.paymentId = paymentId;
  track('payment.sent', { corridor: script.corridorId, amount: script.amountMajor, mode: script.mode });

  // 2. Follow it until terminal (the kiosk polls the payment).
  const t0 = (ctx.now ?? Date.now)();
  let detail: PaymentDetailBody | null = null;
  let status: PaymentStatus | null = null;
  const stopAfterFirstEvent = script.abandon === 'mid-tracking';
  for (;;) {
    const r = await http<PaymentDetailBody>('GET', `${gw}/api/payments/${encodeURIComponent(paymentId)}`, undefined, {}, 8_000);
    if (r.status === 200 && r.body?.state?.status) {
      detail = r.body;
      status = r.body.state.status;
      if (isTerminalStatus(status)) break;
      if (stopAfterFirstEvent && (r.body.events?.length ?? 0) >= 2) break;
    } else if (!(r.status === 404 || isTransient(r.status))) {
      issue('payment-missing', `GET /api/payments/${paymentId} -> ${r.status}`);
      break;
    } else sum.transient += 1;
    if ((ctx.now ?? Date.now)() - t0 > ctx.terminalBudgetMs) {
      issue('payment-stuck', `${paymentId} still ${status ?? 'unknown'} after ${ctx.terminalBudgetMs} ms`);
      break;
    }
    await sleep(300);
  }
  sum.status = status;

  if (stopAfterFirstEvent) {
    // The visitor walks away mid-tracking; the payment itself must still finish (checked after the run).
    track('visit.end', { reason: 'idle', seconds: 8 });
    await flush();
    return sum;
  }

  if (status && isTerminalStatus(status) && detail) {
    if (status !== 'reconciled') issue('not-reconciled', `${paymentId} ended ${status}`);
    if (script.mode === 'fail' && status === 'reconciled' && !detail.events?.some((e) => e.type === 'payment.send_failed')) {
      issue('no-reroute', `${paymentId}: provider-fail visit shows no payment.send_failed before reconciling`);
    }
    if (status === 'reconciled' && !ledgerBalanced(detail.events ?? [])) issue('ledger-unbalanced', `${paymentId}: ledger.posted missing or unbalanced in the payment's events`);

    // 3. Ledger: exactly one balanced journal for a reconciled payment.
    if (status === 'reconciled') {
      const j = await retryWhile(
        () => http<{ entries: { direction: string; amount: { amountMinor: number; currency: string } }[] }[]>('GET', `${gw}/api/ledger/journals?paymentId=${encodeURIComponent(paymentId)}&limit=10`),
        (r) => isTransient(r.status),
        ctx.tolerateTransient() ? 20_000 : 3_000,
      );
      if (j.status === 200 && Array.isArray(j.body)) {
        if (j.body.length !== 1) issue('journal-count', `${paymentId}: ${j.body.length} journals`);
        else if (!journalBalanced(j.body[0]!.entries)) issue('ledger-unbalanced', `${paymentId}: journal entries do not balance`);
      } else if (!tolerated(j)) issue('journal-count', `GET /api/ledger/journals -> ${j.status}`);
      else sum.transient += 1;
    }
  }

  // 4. Ask why (suggestions, then up to `asks` of them).
  const sg = await retryWhile(() => http<{ text: string; intent: string }[]>('GET', `${gw}/api/assistant/suggestions?context=${encodeURIComponent(`payment:${paymentId}`)}`), (r) => isTransient(r.status) && ctx.tolerateTransient(), 12_000);
  if (sg.status === 200 && Array.isArray(sg.body)) {
    if (sg.body.length === 0) issue('suggestions-empty', `${paymentId}: no suggested questions`);
    for (const q of sg.body.slice(0, script.asks)) {
      sum.questions += 1;
      track('question.asked', { text: q.text.slice(0, 200), source: 'chip', intent: q.intent });
      const a = await retryWhile(
        () => http<{ verified?: boolean; answer?: string; mode?: string }>('POST', `${gw}/api/assistant/ask`, { question: q.text, context: { kind: 'payment', paymentId } }, {}, 25_000),
        (r) => isTransient(r.status) && ctx.tolerateTransient(),
        12_000,
      );
      if (a.status === 200 && typeof a.body === 'object' && a.body) {
        if (a.body.verified === true && (a.body.answer ?? '').length > 0) sum.verifiedAnswers += 1;
        else issue('answer-unverified', `${paymentId}: "${q.text.slice(0, 60)}" verified=${String(a.body.verified)} mode=${a.body.mode}`);
      } else if (tolerated(a)) sum.transient += 1;
      else issue('answer-http', `POST /api/assistant/ask -> ${a.status} ${a.text.slice(0, 120)}`);
    }
  } else if (tolerated(sg)) sum.transient += 1;
  else issue('answer-http', `GET /api/assistant/suggestions -> ${sg.status}`);

  // 5. Consent / privacy probes (every third visitor).
  if (script.probes) {
    const noConsent = await http('POST', `${gw}/api/booth/leads`, { name: 'Probe', company: 'Synthetic Co', email: `probe-${script.index}@example.test`, interest: 'ai', consentText: 'x'.repeat(30) });
    if (noConsent.status !== 400 && !tolerated(noConsent)) issue('consent-accepted', `lead without consent -> ${noConsent.status}`);
    const personal = await http('POST', `${gw}/api/booth/analytics`, { events: [{ sessionId, type: 'question.asked', at: new Date().toISOString(), data: { email: `probe-${script.index}@example.com` } }] });
    if (personal.status !== 400 && !tolerated(personal)) issue('analytics-personal', `analytics with an email -> ${personal.status}`);
  }

  // 6. Lead with consent (~30% of visits). A lost answer is retried; the first acknowledged id counts.
  track('cta.shown', { cta: 'lead-form' });
  if (script.lead && status === 'reconciled') {
    sum.leadAttempted = true;
    const form = {
      ...emptyLeadForm(),
      name: `Rehearsal Visitor ${script.index}`,
      company: 'Synthetic Co',
      role: 'Tester',
      email: `m6-visit-${script.index}@example.test`,
      interest: LEAD_INTERESTS[script.index % LEAD_INTERESTS.length]!,
      consent: true,
    };
    const input = toLeadInput(form, sessionId);
    if (!input) issue('lead-rejected', 'the kiosk form refused the synthetic lead');
    else {
      const r = await retryWhile(
        () => http<{ id?: string }>('POST', `${gw}/api/booth/leads`, input),
        (x) => isTransient(x.status),
        ctx.retryBudgetMs,
      );
      if (r.status >= 200 && r.status < 300 && typeof r.body?.id === 'string') {
        sum.leadId = r.body.id;
        track('lead.submitted');
      } else issue('lead-rejected', `POST /api/booth/leads -> ${r.status} ${r.text.slice(0, 160) || r.error || ''}`);
    }
  }
  track('visit.end', { reason: 'finished', seconds: 20 });
  await flush();
  return sum;
}

/** Repeat `fn` (every 400 ms) while `again(result)` holds, for at most budgetMs; returns the last result. */
export async function retryWhile<T>(fn: () => Promise<T>, again: (r: T) => boolean, budgetMs: number, onRetry?: (r: T) => void): Promise<T> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const r = await fn();
    if (!again(r) || Date.now() >= until) return r;
    onRetry?.(r);
    await sleep(400);
  }
}

/** Run visits in order; a visit flagged concurrentWithNext starts together with the next one. */
export async function runVisits(scripts: readonly VisitScript[], ctx: VisitContext, onDone?: (s: VisitSummary) => void, shouldStop: () => boolean = () => false): Promise<VisitSummary[]> {
  const out: VisitSummary[] = [];
  for (let i = 0; i < scripts.length && !shouldStop(); i++) {
    const s = scripts[i]!;
    const group = s.concurrentWithNext && i + 1 < scripts.length ? [s, scripts[i + 1]!] : [s];
    const res = await Promise.all(group.map((g) => runVisit(g, ctx)));
    for (const r of res) {
      out.push(r);
      onDone?.(r);
    }
    i += group.length - 1;
    const idle = Math.max(...group.map((g) => g.idleAfterMs));
    if (idle > 0) await sleep(idle);
  }
  return out;
}
