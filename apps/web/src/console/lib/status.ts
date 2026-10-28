// Status -> label + tone for badges (pure). One mapping for every console page.
import type { BreakStatus, CaseStatus, ChangeStatus, PaymentStatus, Severity } from '@ct/contracts/browser';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';

export interface StatusStyle {
  label: string;
  tone: Tone;
}

export const PAYMENT_STATUS: Record<PaymentStatus, StatusStyle> = {
  initiated: { label: 'Initiated', tone: 'info' },
  screened: { label: 'Screened', tone: 'info' },
  scored: { label: 'Scored', tone: 'info' },
  quoted: { label: 'FX quoted', tone: 'info' },
  routed: { label: 'Routed', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  settled: { label: 'Settled', tone: 'ok' },
  reconciled: { label: 'Reconciled', tone: 'ok' },
  retrying: { label: 'Retrying', tone: 'warn' },
  held: { label: 'Held', tone: 'warn' },
  rejected: { label: 'Rejected', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  refund_requested: { label: 'Refund requested', tone: 'accent' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export const PAYMENT_STATUSES = Object.keys(PAYMENT_STATUS) as PaymentStatus[];

export const SEVERITY: Record<Severity, StatusStyle> = {
  low: { label: 'Low', tone: 'neutral' },
  medium: { label: 'Medium', tone: 'info' },
  high: { label: 'High', tone: 'warn' },
  critical: { label: 'Critical', tone: 'bad' },
};

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

export const CASE_STATUS: Record<CaseStatus, StatusStyle> = {
  open: { label: 'Open', tone: 'info' },
  in_review: { label: 'In review', tone: 'accent' },
  pending_approval: { label: 'Pending approval', tone: 'warn' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export const CHANGE_STATUS: Record<ChangeStatus, StatusStyle> = {
  pending: { label: 'Pending', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export const BREAK_STATUS: Record<BreakStatus, StatusStyle> = {
  open: { label: 'Open', tone: 'bad' },
  investigating: { label: 'Investigating', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'ok' },
};

export type StatusKind = 'payment' | 'severity' | 'case' | 'change' | 'break' | 'refund' | 'delivery' | 'generic';

const REFUND_STATUS: Record<string, StatusStyle> = {
  pending: { label: 'Pending approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  completed: { label: 'Completed', tone: 'ok' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

const DELIVERY_STATUS: Record<string, StatusStyle> = {
  delivered: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  simulated: { label: 'Simulated', tone: 'info' },
};

function titleCase(s: string): string {
  const t = s.replace(/[._-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** Label and tone for any status value; unknown values render neutral with a humanised label. */
export function statusStyle(kind: StatusKind, value: string): StatusStyle {
  const table: Record<string, StatusStyle> | null =
    kind === 'payment' ? PAYMENT_STATUS
    : kind === 'severity' ? SEVERITY
    : kind === 'case' ? CASE_STATUS
    : kind === 'change' ? CHANGE_STATUS
    : kind === 'break' ? BREAK_STATUS
    : kind === 'refund' ? REFUND_STATUS
    : kind === 'delivery' ? DELIVERY_STATUS
    : null;
  return table?.[value] ?? { label: titleCase(value), tone: 'neutral' };
}

/** Sort rank: critical first. */
export function severityRank(s: Severity): number {
  return s === 'critical' ? 0 : s === 'high' ? 1 : s === 'medium' ? 2 : 3;
}
