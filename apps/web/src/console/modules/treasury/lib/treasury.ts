// Pure logic for Treasury & Reconciliation: FX positions and provider payables from ledger balances, today's
// volumes, reconciliation match rate, and the break queue.
import type { AccountBalance, BreakStatus, Money, ReconBreak } from '@ct/contracts/browser';
import { exponentOf } from '@ct/contracts/browser';

/**
 * Indicative USD value of one unit of each currency, for sizing positions side by side. Synthetic reference
 * rates consistent with the simulated corridors; the UI labels them "indicative".
 */
export const INDICATIVE_USD: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, INR: 1 / 83.25, BRL: 1.08 / 5.91, PHP: 1.27 / 72.4, JPY: 1 / 150 };

export function toUsd(m: Money): number | null {
  const r = INDICATIVE_USD[m.currency];
  if (r === undefined) return null;
  return (m.amountMinor / 10 ** exponentOf(m.currency)) * r;
}

export interface FxPosition {
  currency: string;
  accountId: string;
  /** Ledger balance (debits - credits) in minor units: > 0 long (bought), < 0 short (sold). */
  netMinor: number;
  boughtMinor: number; // debits
  soldMinor: number; // credits
  direction: 'long' | 'short' | 'flat';
  usd: number | null;
  entryCount: number;
}

export function fxPositions(accounts: readonly AccountBalance[]): FxPosition[] {
  return accounts
    .filter((a) => a.accountId.startsWith('fx-position:'))
    .map((a) => {
      const currency = a.accountId.slice('fx-position:'.length) || a.currency;
      return {
        currency,
        accountId: a.accountId,
        netMinor: a.balance,
        boughtMinor: a.debits,
        soldMinor: a.credits,
        direction: a.balance > 0 ? 'long' : a.balance < 0 ? 'short' : 'flat',
        usd: toUsd({ amountMinor: a.balance, currency }),
        entryCount: a.entryCount,
      } satisfies FxPosition;
    })
    .sort((x, y) => Math.abs(y.usd ?? 0) - Math.abs(x.usd ?? 0) || x.currency.localeCompare(y.currency));
}

export interface ProviderBalance {
  providerId: string;
  currency: string;
  accountId: string;
  /** Amount owed to the provider (credit balance of the payable), minor units, positive. */
  payableMinor: number;
  usd: number | null;
  entryCount: number;
}

/** provider:<id>:payable:<CCY> accounts. Liability: credits - debits is what we owe. */
export function providerBalances(accounts: readonly AccountBalance[]): ProviderBalance[] {
  const out: ProviderBalance[] = [];
  for (const a of accounts) {
    const parts = a.accountId.split(':');
    if (parts[0] !== 'provider' || parts.length < 4) continue;
    const currency = parts[3] ?? a.currency;
    const payableMinor = a.credits - a.debits;
    out.push({ providerId: parts[1]!, currency, accountId: a.accountId, payableMinor, usd: toUsd({ amountMinor: payableMinor, currency }), entryCount: a.entryCount });
  }
  return out.sort((x, y) => x.providerId.localeCompare(y.providerId) || x.currency.localeCompare(y.currency));
}

export interface VolumeRow {
  key: string;
  count: number;
  settled: number;
  /** Source amount by currency (minor units). */
  bySource: Record<string, number>;
  usd: number;
}

interface PaymentLike {
  corridor: string;
  providerId?: string;
  amount: Money;
  createdAt: string;
  status: string;
}

export function isSameLocalDay(iso: string, nowMs: number): boolean {
  const d = new Date(iso);
  const n = new Date(nowMs);
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

const SETTLED = new Set(['settled', 'reconciled', 'refund_requested', 'refunded']);

/** Today's payments grouped by `by` (corridor or provider), largest USD volume first. */
export function volumesToday(payments: readonly PaymentLike[], by: 'corridor' | 'provider', nowMs: number): VolumeRow[] {
  const rows = new Map<string, VolumeRow>();
  for (const p of payments) {
    if (!isSameLocalDay(p.createdAt, nowMs)) continue;
    const key = by === 'corridor' ? p.corridor : p.providerId ?? 'unrouted';
    const r = rows.get(key) ?? { key, count: 0, settled: 0, bySource: {}, usd: 0 };
    r.count += 1;
    if (SETTLED.has(p.status)) r.settled += 1;
    r.bySource[p.amount.currency] = (r.bySource[p.amount.currency] ?? 0) + p.amount.amountMinor;
    r.usd += toUsd(p.amount) ?? 0;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key));
}

/** matched / (matched + breaks); null before anything reconciled. */
export function matchRate(matched: number, breaks: number): number | null {
  const total = matched + breaks;
  return total > 0 ? matched / total : null;
}

// ---------------------------------------------------------------------------------------------- breaks

export const RESOLUTION_CODES = [
  { code: 'PROVIDER_ADJUSTMENT', label: 'Provider adjustment', help: 'The provider corrects its statement or pays the difference.' },
  { code: 'LEDGER_CORRECTION', label: 'Ledger correction', help: 'Our books were wrong; post a correcting journal.' },
  { code: 'WRITE_OFF', label: 'Write-off', help: 'Small difference absorbed as an operating loss.' },
  { code: 'FALSE_POSITIVE', label: 'False positive', help: 'The statement and ledger agree after review (timing, rounding).' },
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number]['code'];

export const BREAK_REASON_TEXT: Record<string, string> = {
  AMOUNT_MISMATCH: 'Amount on the statement differs from the ledger',
  MISSING_ON_STATEMENT: 'Settled payment missing from the provider statement',
  MISSING_IN_LEDGER: 'Statement line without a ledger journal',
  CURRENCY_MISMATCH: 'Statement currency differs from the ledger',
  DATE_MISMATCH: 'Booking date differs from the value date',
  DUPLICATE: 'Duplicate statement line',
};

export function breakReasonText(code: string): string {
  const known = BREAK_REASON_TEXT[code.toUpperCase()];
  if (known) return known;
  const s = code.replace(/[_.-]+/g, ' ').toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

/** reported - expected when both are in the same currency (minor units); null otherwise. */
export function breakDifference(b: Pick<ReconBreak, 'expected' | 'reported'>): number | null {
  if (!b.reported || b.reported.currency !== b.expected.currency) return null;
  return b.reported.amountMinor - b.expected.amountMinor;
}

export type BreakFilter = 'open' | 'mine' | 'resolved' | 'all';

export function filterBreaks(list: readonly ReconBreak[], f: BreakFilter, userId: string, q = ''): ReconBreak[] {
  const needle = q.trim().toLowerCase();
  const isOpen = (s: BreakStatus) => s !== 'resolved';
  return list
    .filter((b) => (f === 'all' ? true : f === 'resolved' ? b.status === 'resolved' : f === 'mine' ? isOpen(b.status) && b.assignee?.userId === userId : isOpen(b.status)))
    .filter((b) => !needle || `${b.breakId} ${b.paymentId} ${b.providerId} ${b.breaks.join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || a.breakId.localeCompare(b.breakId));
}

export function validateResolution(code: string, note: string): string | null {
  if (!RESOLUTION_CODES.some((r) => r.code === code)) return 'Choose a resolution code';
  if (note.trim().length < 10) return 'Explain the resolution (at least 10 characters)';
  return null;
}

/** Age of a break, e.g. "3h 12m". */
export function ageLabel(fromIso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}
