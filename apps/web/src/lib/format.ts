import { PIPELINE, PROVIDERS, formatMoney, isTerminal, type EventType, type PaymentStatus } from '@ct/contracts/browser';
import type { PaymentSummary } from './types';

export const STAGE_LABELS: Record<PaymentStatus, { title: string; detail?: string }> = {
  initiated: { title: 'Initiated' },
  screened: { title: 'Screened', detail: 'KYC / sanctions' },
  scored: { title: 'Scored', detail: 'fraud / AML' },
  quoted: { title: 'FX quoted' },
  routed: { title: 'Routed' },
  sent: { title: 'Sent', detail: 'pacs.008' },
  settled: { title: 'Settled', detail: 'pacs.002' },
  reconciled: { title: 'Reconciled' },
  retrying: { title: 'Retrying', detail: 'provider reject' },
  held: { title: 'Held' },
  rejected: { title: 'Rejected' },
  failed: { title: 'Failed', detail: 'all providers' },
  refund_requested: { title: 'Refund requested' },
  refunded: { title: 'Refunded' },
};

export function stageLabel(status: PaymentStatus): string {
  const l = STAGE_LABELS[status];
  return l.detail ? `${l.title} (${l.detail})` : l.title;
}

export const EVENT_LABELS: Record<EventType, string> = {
  'payment.initiated': 'Payment initiated',
  'payment.screened': 'Sanctions & KYC screening',
  'payment.scored': 'Fraud & AML scoring',
  'payment.quoted': 'FX quote locked',
  'payment.routed': 'Provider selected',
  'payment.sent': 'Sent to provider (pacs.008)',
  'payment.settled': 'Settlement confirmed (pacs.002)',
  'ledger.posted': 'Ledger journal posted',
  'payment.reconciled': 'Reconciled with statement',
  'payment.send_failed': 'Provider rejected (pacs.002 RJCT)',
  'payment.failed': 'Payment failed',
  'payment.held': 'Payment held',
  'payment.rejected': 'Payment rejected',
  'risk.alert_raised': 'Risk alert raised',
  'payment.released': 'Released by operator',
  'payment.retry_requested': 'Retry requested by operator',
  'payment.refund_requested': 'Refund requested',
  'payment.refunded': 'Refund posted to ledger',
};

/** Status a payment enters because of this event type, if any. */
export function statusForEvent(type: string): PaymentStatus | null {
  if (type === 'payment.send_failed') return 'retrying';
  if (!type.startsWith('payment.')) return null;
  const s = type.slice('payment.'.length) as PaymentStatus;
  return (PIPELINE as readonly string[]).includes(s) || s === 'held' || s === 'rejected' || s === 'failed' ? s : null;
}

/** Statuses a payment can stop in or detour through (shown as tiles beside the pipeline). */
export const OFF_PATH: readonly PaymentStatus[] = ['retrying', 'failed', 'held', 'rejected'];

export const ALL_STATUSES: readonly PaymentStatus[] = [...PIPELINE, ...OFF_PATH];

/** Integer with thousands separators. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function formatPct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

/** Minor units -> "1,234.56" using the currency exponent. */
export function formatMinor(amountMinor: number, currency: string): string {
  return formatMoney({ amountMinor, currency }).slice(currency.length + 1);
}

/** Human duration: "850 ms", "4.2 s", "3m 05s", "1h 02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalS = Math.floor(ms / 1000);
  if (totalS < 3600) return `${Math.floor(totalS / 60)}m ${String(totalS % 60).padStart(2, '0')}s`;
  const m = Math.floor(totalS / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Local wall-clock time with milliseconds, e.g. "14:03:07.120". */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Time a payment has been (or was) in flight. Terminal payments stop the clock. */
export function elapsedMs(p: Pick<PaymentSummary, 'status' | 'createdAt' | 'updatedAt'>, now: number): number {
  const start = Date.parse(p.createdAt);
  const end = isTerminal(p.status) ? Date.parse(p.updatedAt) : now;
  return Math.max(0, end - start);
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export function providerName(providerId: string | undefined): string {
  if (!providerId) return '—';
  return PROVIDERS.find((p) => p.id === providerId)?.name ?? providerId;
}

export function corridorLabel(corridor: string): string {
  const [a, b] = corridor.split('-');
  return a && b ? `${a} → ${b}` : corridor;
}
