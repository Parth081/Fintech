// Payments workspace logic (pure): URL filters <-> API query, operator action availability, event labels.
import type { AnyEvent, Permission, PaymentStatus } from '@ct/contracts/browser';
import { dayBounds } from './format';
import { PAYMENT_STATUSES, type Tone } from './status';

export interface PaymentFilters {
  q: string;
  status: PaymentStatus[];
  corridor: string;
  provider: string;
  currency: string;
  minAmount: string;
  maxAmount: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export const EMPTY_FILTERS: PaymentFilters = { q: '', status: [], corridor: '', provider: '', currency: '', minAmount: '', maxAmount: '', from: '', to: '' };

const KEYS = ['q', 'corridor', 'provider', 'currency', 'minAmount', 'maxAmount', 'from', 'to'] as const;

/** Filters from the console URL query (unknown statuses dropped). */
export function filtersFromQuery(q: Record<string, string>): PaymentFilters {
  const f: PaymentFilters = { ...EMPTY_FILTERS, status: [] };
  for (const k of KEYS) f[k] = (q[k] ?? '').slice(0, 120);
  f.status = (q.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is PaymentStatus => (PAYMENT_STATUSES as string[]).includes(s));
  return f;
}

/** URL query for the filters (empty values omitted). */
export function filtersToQuery(f: PaymentFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEYS) if (f[k].trim()) out[k] = f[k].trim();
  if (f.status.length) out.status = f.status.join(',');
  return out;
}

export function activeFilterCount(f: PaymentFilters): number {
  return KEYS.filter((k) => f[k].trim() !== '').length + (f.status.length ? 1 : 0);
}

const num = (s: string): number | null => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Gateway /api/payments query: amounts in major units; dates as local-day ISO bounds. */
export interface PaymentApiQuery {
  q?: string;
  status?: string[];
  corridor?: string;
  provider?: string;
  currency?: string;
  minAmount?: number;
  maxAmount?: number;
  from?: string;
  to?: string;
}

export function apiQuery(f: PaymentFilters): PaymentApiQuery {
  const out: PaymentApiQuery = {};
  if (f.q.trim()) out.q = f.q.trim();
  if (f.status.length) out.status = f.status;
  if (f.corridor) out.corridor = f.corridor;
  if (f.provider) out.provider = f.provider;
  if (/^[A-Z]{3}$/.test(f.currency)) out.currency = f.currency;
  const min = num(f.minAmount);
  const max = num(f.maxAmount);
  if (min !== null) out.minAmount = min;
  if (max !== null) out.maxAmount = max;
  const from = f.from ? dayBounds(f.from) : null;
  const to = f.to ? dayBounds(f.to) : null;
  if (from) out.from = from.from;
  if (to) out.to = to.to;
  return out;
}

// ---------------------------------------------------------------------------------------------- actions

export type PaymentAction = 'retry' | 'refund' | 'case';

export interface ActionState {
  action: PaymentAction;
  label: string;
  /** Shown at all (status fits). */
  visible: boolean;
  /** Enabled for this user. */
  enabled: boolean;
  /** Why disabled (permission / pending request). */
  reason?: string;
}

/**
 * Operator actions on a payment: Retry (failed; payments.retry), Request refund (reconciled; payments.refund.request,
 * no pending request), Open case (held; alerts.read, a case exists).
 */
export function paymentActions(
  status: PaymentStatus,
  can: (p: Permission) => boolean,
  ctx: { pendingRefund?: boolean; caseId?: string | null } = {},
): ActionState[] {
  const perm = (p: Permission) => (can(p) ? undefined : `You don't have permission: ${p}`);
  const retryReason = perm('payments.retry');
  const refundReason = perm('payments.refund.request') ?? (ctx.pendingRefund ? 'A refund request is already pending approval' : undefined);
  const caseReason = perm('alerts.read') ?? (ctx.caseId ? undefined : 'No case is linked to this payment yet');
  return [
    { action: 'retry', label: 'Retry payment', visible: status === 'failed', enabled: !retryReason, reason: retryReason },
    { action: 'refund', label: 'Request refund', visible: status === 'reconciled', enabled: !refundReason, reason: refundReason },
    { action: 'case', label: 'Open case', visible: status === 'held', enabled: !caseReason, reason: caseReason },
  ];
}

// ---------------------------------------------------------------------------------------------- events

export const EVENT_LABEL: Record<string, string> = {
  'payment.initiated': 'Payment initiated',
  'payment.screened': 'Sanctions screening',
  'payment.scored': 'Fraud & AML scoring',
  'payment.quoted': 'FX quoted',
  'payment.routed': 'Routed to provider',
  'payment.sent': 'pacs.008 sent',
  'payment.settled': 'Settled (pacs.002 ACSC)',
  'ledger.posted': 'Ledger journal posted',
  'payment.reconciled': 'Reconciled against statement',
  'payment.send_failed': 'Provider rejected (pacs.002 RJCT)',
  'payment.failed': 'Payment failed',
  'payment.held': 'Held for review',
  'payment.rejected': 'Rejected',
  'risk.alert_raised': 'Risk alert raised',
  'payment.released': 'Released by compliance',
  'payment.retry_requested': 'Retry requested by operator',
  'payment.refund_requested': 'Refund approved & requested',
  'payment.refunded': 'Refunded (reversal journal)',
};

export function eventTone(e: Pick<AnyEvent, 'type'>): Tone {
  switch (e.type) {
    case 'payment.settled':
    case 'payment.reconciled':
    case 'ledger.posted':
    case 'payment.released':
      return 'ok';
    case 'payment.held':
    case 'payment.send_failed':
    case 'risk.alert_raised':
      return 'warn';
    case 'payment.failed':
    case 'payment.rejected':
      return 'bad';
    case 'payment.retry_requested':
    case 'payment.refund_requested':
    case 'payment.refunded':
      return 'accent';
    default:
      return 'info';
  }
}

/** Operator (human) actor of an event, when it has one. */
export function eventActor(e: AnyEvent): { name: string; role: string } | null {
  const p = e.payload as unknown as Record<string, unknown>;
  const a = p && typeof p === 'object' ? (p.actor as { name?: unknown; role?: unknown } | undefined) : undefined;
  return a && typeof a.name === 'string' ? { name: a.name, role: typeof a.role === 'string' ? a.role : '' } : null;
}
