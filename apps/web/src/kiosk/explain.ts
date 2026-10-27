// Plain-English explanations of each step a payment takes, built only from what the pipeline recorded
// (event payloads and decision traces). Pure functions; the kiosk reveals them one by one.
import { formatMoney, isBalanced, PROVIDERS, type AnyEvent, type Money, type PaymentStatus } from '@ct/contracts/browser';
import type { Outcome } from './flow';

export type StepTone = 'ok' | 'info' | 'warn' | 'bad';

export interface KioskStep {
  /** Event id (stable key; also what "Ask why" refers to). */
  id: string;
  type: AnyEvent['type'];
  title: string;
  body: string;
  tone: StepTone;
  /** Assistant intent that best answers "why" for this step (used to order suggestion chips). */
  intent: string;
  at: string;
}

const providerName = (id: string | undefined) => PROVIDERS.find((p) => p.id === id)?.name ?? (id ? `Provider ${id}` : 'the provider');
const money = (m: Money | undefined) => (m ? formatMoney(m) : '');
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

const REASON_WORDS: Record<string, string> = {
  LOWEST_FEE: 'the lowest fee',
  HIGHEST_SUCCESS: 'the best success rate',
  FASTEST: 'the fastest delivery',
  ONLY_ELIGIBLE_PROVIDER: 'being the only provider left',
  CIRCUIT_OPEN_REROUTED: 'avoiding a provider whose circuit breaker is open',
  RECOVERED_AFTER_OUTAGE: 'having recovered from an outage',
};

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One explanation per recorded event; null for events a visitor does not need to see. */
export function explainEvent(e: AnyEvent): KioskStep | null {
  const base = { id: e.eventId, type: e.type, at: e.occurredAt };
  switch (e.type) {
    case 'payment.initiated': {
      const p = e.payload;
      return {
        ...base,
        title: 'Payment created',
        body: `${p.debtor.name} sends ${money(p.amount)} to ${p.creditor.name}. The request was checked and accepted.`,
        tone: 'info',
        intent: 'overview',
      };
    }
    case 'payment.screened':
      return e.payload.result === 'clear'
        ? { ...base, title: 'Sanctions check passed', body: `Both parties were checked against the sanctions list (version ${e.payload.listVersion}). No match.`, tone: 'ok', intent: 'why_screened' }
        : { ...base, title: 'Possible sanctions match', body: 'A name looked like an entry on the sanctions list, so the payment stops for a person to review.', tone: 'warn', intent: 'why_held' };
    case 'payment.scored': {
      const p = e.payload;
      const score = Math.round(p.fraudScore * 100);
      if (p.decision === 'approve') {
        return { ...base, title: 'Fraud check passed', body: `The risk model scored it ${score} out of 100: low risk, approved automatically.`, tone: 'ok', intent: 'why_approved' };
      }
      return { ...base, title: p.decision === 'hold' ? 'Held for review' : 'Blocked by risk', body: `The risk model scored it ${score} out of 100, so a person must look at it.`, tone: 'warn', intent: 'why_held' };
    }
    case 'payment.quoted': {
      const p = e.payload;
      const spread = `${(p.spreadBps / 100).toFixed(2)}%`;
      return {
        ...base,
        title: 'Exchange rate locked',
        body: `${money(p.sourceAmount)} becomes ${money(p.targetAmount)} at ${p.rate}${p.midRate ? ` (market rate ${p.midRate}, our margin ${spread})` : ` (margin ${spread})`}.`,
        tone: 'info',
        intent: 'fx_cost',
      };
    }
    case 'payment.routed': {
      const p = e.payload;
      const name = providerName(p.providerId);
      const codes = e.trace?.reasonCodes ?? [];
      const why = codes.map((c) => REASON_WORDS[c]).filter((w): w is string => !!w);
      const chosen = p.scoring?.find((s) => s.providerId === p.providerId);
      const facts = chosen ? ` Fee ${money(chosen.fee)}, success rate ${pct(chosen.successRate)}.` : '';
      if ((p.attempt ?? 1) > 1) {
        const failed = (p.excludedProviders ?? []).map(providerName);
        return {
          ...base,
          title: `Re-routed to ${name}`,
          body: `${failed.length ? `${listWords(failed)} refused it, so` : 'After the refusal,'} the router automatically picked the next best partner: ${name}.${facts}`,
          tone: 'ok',
          intent: 'why_route',
        };
      }
      const others = p.scoring ? p.scoring.filter((s) => s.eligible).length - 1 : p.alternatives.length;
      return {
        ...base,
        title: `${name} chosen`,
        body: `Out of ${others + 1} partners, ${name} won${why.length ? ` on ${listWords(why)}` : ' on overall score'}.${facts}`,
        tone: 'info',
        intent: 'why_route',
      };
    }
    case 'payment.sent':
      return {
        ...base,
        title: 'Instruction sent',
        body: `A standard ISO 20022 payment message (pacs.008) went to ${providerName(e.payload.providerId)}.`,
        tone: 'info',
        intent: 'overview',
      };
    case 'payment.send_failed':
      return {
        ...base,
        title: `${providerName(e.payload.providerId)} refused it`,
        body: `The provider answered "${e.payload.reason}" (code ${e.payload.reasonCode}). No money moved, so it is safe to try another partner.`,
        tone: 'warn',
        intent: 'outage_story',
      };
    case 'payment.settled': {
      const p = e.payload;
      return {
        ...base,
        title: 'Delivered',
        body: `${providerName(p.providerId)} confirmed delivery${p.settledAmount ? ` of ${money(p.settledAmount)}` : ''}${p.valueDate ? ` on ${p.valueDate}` : ''}.`,
        tone: 'ok',
        intent: 'overview',
      };
    }
    case 'ledger.posted': {
      const balanced = isBalanced(e.payload.entries);
      return {
        ...base,
        title: balanced ? 'Ledger balanced' : 'Ledger posting',
        body: balanced
          ? `${e.payload.entries.length} double-entry lines were written: every debit has a matching credit, so the books add up to zero.`
          : `${e.payload.entries.length} ledger lines were written.`,
        tone: balanced ? 'ok' : 'warn',
        intent: 'ledger_proof',
      };
    }
    case 'payment.reconciled':
      return e.payload.matched
        ? { ...base, title: 'Reconciled', body: "The provider's own statement matches our records to the cent.", tone: 'ok', intent: 'ledger_proof' }
        : { ...base, title: 'Reconciliation break', body: "The provider's statement does not match our records, so an operator is alerted.", tone: 'warn', intent: 'ledger_proof' };
    case 'payment.failed':
      return { ...base, title: 'Payment failed', body: `${e.payload.reason}. Nothing was posted to the ledger, so no money is lost.`, tone: 'bad', intent: 'outage_story' };
    case 'payment.held':
      return { ...base, title: 'Held for review', body: `${e.payload.reason}. A compliance analyst decides what happens next.`, tone: 'warn', intent: 'why_held' };
    case 'payment.rejected':
      return { ...base, title: 'Rejected', body: `${e.payload.reason}.`, tone: 'bad', intent: 'why_held' };
    default:
      return null;
  }
}

export function explainEvents(events: readonly AnyEvent[]): KioskStep[] {
  const out: KioskStep[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    const step = explainEvent(e);
    if (step) out.push(step);
  }
  return out;
}

const TERMINAL: readonly PaymentStatus[] = ['reconciled', 'failed', 'held', 'rejected', 'refunded'];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL.includes(status);
}

export function outcomeOf(status: PaymentStatus): Outcome {
  switch (status) {
    case 'reconciled':
    case 'refunded':
      return 'delivered';
    case 'failed':
      return 'failed';
    case 'held':
      return 'held';
    case 'rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}

/** True when the payment's ledger journal was posted and balanced (the "Ledger balanced ✓" claim). */
export function ledgerBalanced(events: readonly AnyEvent[]): boolean {
  const posted = events.filter((e): e is Extract<AnyEvent, { type: 'ledger.posted' }> => e.type === 'ledger.posted');
  return posted.length > 0 && posted.every((e) => isBalanced(e.payload.entries));
}

/**
 * How many of `available` steps to show: one new step at most every `gapMs`, so a visitor can read each one
 * even when the pipeline is faster than that. Returns the new count and when the last one was revealed.
 */
export function revealNext(available: number, shown: number, lastRevealAt: number, now: number, gapMs: number): { shown: number; lastRevealAt: number } {
  if (shown >= available) return { shown: Math.min(shown, available), lastRevealAt };
  if (shown === 0 || now - lastRevealAt >= gapMs) return { shown: shown + 1, lastRevealAt: now };
  return { shown, lastRevealAt };
}

/** Order suggestion chips so the ones about this step's topic come first; keep at most `max`. */
export function rankSuggestions<T extends { intent: string; text: string }>(items: readonly T[], intent: string | undefined, max = 4): T[] {
  const seen = new Set<string>();
  const unique = items.filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true)));
  const first = intent ? unique.filter((s) => s.intent === intent) : [];
  const rest = unique.filter((s) => !first.includes(s));
  return [...first, ...rest].slice(0, max);
}

/** A citation value as a short chip text: Money as "USD 250.00", numbers as recorded, long text cut. */
export function citationValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const m = value as Partial<Money>;
    if (typeof m.amountMinor === 'number' && typeof m.currency === 'string') return formatMoney({ amountMinor: m.amountMinor, currency: m.currency });
  }
  const s = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** Visitors only ever see verified answers (assistant contract); anything else gets a polite fallback. */
export function visibleAnswer(a: { answer: string; verified: boolean } | null | undefined): string | null {
  if (!a || !a.verified || !a.answer.trim()) return null;
  return a.answer.trim();
}
