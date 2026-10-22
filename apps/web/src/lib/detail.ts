// Pure helpers for the payment detail drawer.
import { formatMoney, isBalanced, type AnyEvent, type LedgerEntry, type PaymentState } from '@ct/contracts/browser';
import { providerName } from './format';

export interface TimelineRow {
  eventId: string;
  type: AnyEvent['type'];
  occurredAt: string;
  producer: string;
  /** Time since the previous event (null for the first). */
  sincePrevMs: number | null;
  /** Time since the payment was initiated. */
  sinceStartMs: number;
  /** Processing latency the stage reported in its decision trace. */
  stageLatencyMs: number | null;
  trace: AnyEvent['trace'];
}

export function timelineRows(events: AnyEvent[]): TimelineRow[] {
  const start = events[0] ? Date.parse(events[0].occurredAt) : 0;
  return events.map((e, i) => {
    const t = Date.parse(e.occurredAt);
    const prev = i > 0 ? Date.parse(events[i - 1]!.occurredAt) : null;
    return {
      eventId: e.eventId,
      type: e.type,
      occurredAt: e.occurredAt,
      producer: e.producer,
      sincePrevMs: prev === null ? null : t - prev,
      sinceStartMs: t - start,
      stageLatencyMs: e.trace ? e.trace.latencyMs : null,
      trace: e.trace,
    };
  });
}

export interface Fact {
  label: string;
  value: string;
}

export function keyFacts(state: PaymentState): Fact[] {
  const f = state.facts;
  const out: Fact[] = [];
  const init = state.initiated;
  out.push({ label: 'Corridor', value: init.corridor });
  out.push({ label: 'Debtor', value: `${init.debtor.name} (${init.debtor.country})` });
  out.push({ label: 'Creditor', value: `${init.creditor.name} (${init.creditor.country})` });
  out.push({ label: 'Amount', value: formatMoney(init.amount) });
  if (init.scenario) out.push({ label: 'Scenario', value: init.scenario });
  if (f['payment.screened']) {
    out.push({ label: 'Screening', value: `${f['payment.screened'].result} · list ${f['payment.screened'].listVersion}` });
  }
  if (f['payment.scored']) {
    const s = f['payment.scored'];
    const alerts = s.amlAlerts.length ? s.amlAlerts.join(', ') : 'none';
    out.push({ label: 'Risk', value: `${s.decision} · fraud score ${s.fraudScore.toFixed(2)} · AML alerts ${alerts}` });
  }
  if (f['payment.quoted']) {
    const q = f['payment.quoted'];
    out.push({ label: 'FX rate', value: `${q.rate} ${q.sourceAmount.currency}→${q.targetAmount.currency}` });
    out.push({ label: 'FX spread', value: `${q.spreadBps} bps` });
    out.push({ label: 'Target amount', value: formatMoney(q.targetAmount) });
    out.push({ label: 'Quote id', value: q.quoteId });
  }
  if (f['payment.routed']) {
    const r = f['payment.routed'];
    out.push({ label: 'Provider', value: providerName(r.providerId) });
    out.push({ label: 'Rail', value: r.rail });
    out.push({ label: 'Fee', value: formatMoney(r.estimatedFee) });
    if (r.alternatives.length) {
      out.push({
        label: 'Alternatives',
        value: r.alternatives.map((a) => `${providerName(a.providerId)} (${a.score.toFixed(2)})`).join(', '),
      });
    }
  }
  if (f['payment.sent']) out.push({ label: 'pacs.008 message id', value: f['payment.sent'].messageId });
  if (f['payment.settled']) out.push({ label: 'pacs.002 settlement ref', value: f['payment.settled'].settlementRef });
  if (f['ledger.posted']) out.push({ label: 'Ledger journal', value: f['ledger.posted'].journalId });
  if (f['payment.reconciled']) {
    const r = f['payment.reconciled'];
    out.push({ label: 'Statement', value: `${r.statementRef} · ${r.matched ? 'matched' : 'NOT matched'}` });
  }
  const stop = f['payment.held'] ?? f['payment.rejected'];
  if (stop) out.push({ label: state.status === 'rejected' ? 'Rejected' : 'Held', value: `${stop.reason} (at ${stop.atStage})` });
  const fail = f['payment.failed'];
  if (fail) out.push({ label: 'Failed', value: `${fail.reason} (at ${fail.atStage}${fail.attempts ? `, ${fail.attempts} attempts` : ''})` });
  return out;
}

export interface LedgerRow {
  account: string;
  debit: string;
  credit: string;
}

export function ledgerRows(entries: LedgerEntry[]): LedgerRow[] {
  return entries.map((e) => ({
    account: e.account,
    debit: e.direction === 'debit' ? formatMoney(e.amount) : '',
    credit: e.direction === 'credit' ? formatMoney(e.amount) : '',
  }));
}

export function ledgerCheck(entries: LedgerEntry[] | undefined): { present: boolean; balanced: boolean } {
  if (!entries) return { present: false, balanced: false };
  return { present: true, balanced: isBalanced(entries) };
}

/** Render a trace input value compactly. */
export function formatInput(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    if ('amountMinor' in value && 'currency' in value) {
      const m = value as { amountMinor: unknown; currency: unknown };
      if (typeof m.amountMinor === 'number' && typeof m.currency === 'string') {
        return formatMoney({ amountMinor: m.amountMinor, currency: m.currency });
      }
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export interface QuoteView {
  quoteId: string;
  mid: string | null;
  rate: string;
  spreadBps: number;
  /** (mid - rate) / mid in bps, when the mid is known: the spread actually applied. */
  effectiveSpreadBps: number | null;
  source: string;
  target: string;
  rateTimestamp: string | null;
  expiresAt: string;
  /** Quote validity from the market tick (or quote event) to expiry. */
  validForMs: number | null;
}

export function quoteView(state: PaymentState, quotedAt?: string): QuoteView | null {
  const q = state.facts['payment.quoted'];
  if (!q) return null;
  const mid = q.midRate ?? null;
  const m = mid === null ? NaN : Number(mid);
  const r = Number(q.rate);
  const from = q.rateTimestamp ?? quotedAt;
  const valid = from ? Date.parse(q.expiresAt) - Date.parse(from) : NaN;
  return {
    quoteId: q.quoteId,
    mid,
    rate: q.rate,
    spreadBps: q.spreadBps,
    effectiveSpreadBps: Number.isFinite(m) && m > 0 && Number.isFinite(r) ? Math.round(((m - r) / m) * 10_000 * 10) / 10 : null,
    source: formatMoney(q.sourceAmount),
    target: formatMoney(q.targetAmount),
    rateTimestamp: q.rateTimestamp ?? null,
    expiresAt: q.expiresAt,
    validForMs: Number.isFinite(valid) ? valid : null,
  };
}

export interface ReconView {
  matched: boolean;
  statementRef: string;
  journalId: string | null;
  breaks: string[];
}

export function reconView(state: PaymentState): ReconView | null {
  const r = state.facts['payment.reconciled'];
  if (!r) return null;
  return { matched: r.matched, statementRef: r.statementRef, journalId: r.journalId ?? null, breaks: r.breaks ?? [] };
}

/** Sample scenarios the payment API forwards to the stages (POST /api/payments/sample {scenario}). */
export const SCENARIOS = {
  hold: 'force-hold',
  providerReject: 'provider-reject',
  reconBreak: 'recon-break',
} as const;
