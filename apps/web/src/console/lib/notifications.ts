// Notification centre (pure): what needs the signed-in user's attention, built from queue snapshots.
import type { CaseView, ChangeRequest, Permission, ReconBreak } from '@ct/contracts/browser';
import { links } from './routing';
import type { Tone } from './status';

export interface Notice {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  href: string;
  at: string;
  group: 'Cases' | 'Approvals' | 'Reconciliation';
}

export interface NoticeInputs {
  userId: string;
  can(p: Permission): boolean;
  /** Active (not closed) high/critical cases. */
  urgentCases?: readonly CaseView[];
  /** Cases awaiting a second pair of eyes. */
  pendingCases?: readonly CaseView[];
  pendingChanges?: readonly ChangeRequest[];
  pendingRefunds?: readonly { id: string; paymentId: string; requestedBy?: { userId: string; name: string }; requestedAt?: string }[];
  openBreaks?: readonly ReconBreak[];
  nowMs: number;
}

const MAX_PER_GROUP = 6;

export function buildNotices(i: NoticeInputs): Notice[] {
  const out: Notice[] = [];
  if (i.can('alerts.read') && i.urgentCases) {
    const list = [...i.urgentCases]
      .filter((c) => c.status !== 'closed' && (c.priority === 'critical' || c.priority === 'high'))
      .sort((a, b) => (a.priority === b.priority ? a.slaDueAt.localeCompare(b.slaDueAt) : a.priority === 'critical' ? -1 : 1));
    for (const c of list.slice(0, MAX_PER_GROUP)) {
      const breached = Date.parse(c.slaDueAt) < i.nowMs;
      out.push({
        id: `case:${c.caseId}`,
        tone: c.priority === 'critical' ? 'bad' : 'warn',
        title: `${c.priority === 'critical' ? 'Critical' : 'High'} case ${c.caseId}`,
        body: `${breached ? 'SLA breached' : 'SLA due'} · ${c.assignee ? `assigned to ${c.assignee.name}` : 'unassigned'}`,
        href: links.case(c.caseId),
        at: c.openedAt,
        group: 'Cases',
      });
    }
  }
  if (i.can('cases.approve') && i.pendingCases) {
    for (const c of i.pendingCases.filter((x) => x.status === 'pending_approval' && x.proposal?.by.userId !== i.userId).slice(0, MAX_PER_GROUP)) {
      out.push({
        id: `approve-case:${c.caseId}`,
        tone: 'accent',
        title: `Approve ${c.proposal?.decision ?? 'decision'} on ${c.caseId}`,
        body: c.proposal ? `Proposed by ${c.proposal.by.name}` : 'Awaiting approval',
        href: links.case(c.caseId),
        at: c.proposal?.at ?? c.openedAt,
        group: 'Approvals',
      });
    }
  }
  if (i.can('config.approve') && i.pendingChanges) {
    for (const r of i.pendingChanges.filter((x) => x.status === 'pending' && x.requestedBy.userId !== i.userId).slice(0, MAX_PER_GROUP)) {
      out.push({
        id: `change:${r.id}`,
        tone: 'accent',
        title: `Review change ${r.id}`,
        body: `${r.key} · requested by ${r.requestedBy.name}`,
        href: links.change(r.id),
        at: r.requestedAt,
        group: 'Approvals',
      });
    }
  }
  if (i.can('payments.refund.approve') && i.pendingRefunds) {
    for (const r of i.pendingRefunds.filter((x) => x.requestedBy?.userId !== i.userId).slice(0, MAX_PER_GROUP)) {
      out.push({
        id: `refund:${r.id}`,
        tone: 'accent',
        title: `Approve refund ${r.id}`,
        body: `Payment ${r.paymentId}${r.requestedBy ? ` · requested by ${r.requestedBy.name}` : ''}`,
        href: links.refunds({ status: 'pending' }),
        at: r.requestedAt ?? '',
        group: 'Approvals',
      });
    }
  }
  if (i.can('recon.read') && i.openBreaks) {
    for (const b of i.openBreaks.filter((x) => x.status !== 'resolved').slice(0, MAX_PER_GROUP)) {
      out.push({
        id: `break:${b.breakId}`,
        tone: 'bad',
        title: `Reconciliation break ${b.breakId}`,
        body: `${b.providerId} · ${b.breaks.join(', ') || 'statement mismatch'}`,
        href: links.break(b.breakId),
        at: b.detectedAt,
        group: 'Reconciliation',
      });
    }
  }
  return out;
}

/** Notices not yet seen (ids not in `seen`). */
export function unseenCount(notices: readonly Notice[], seen: readonly string[]): number {
  const s = new Set(seen);
  return notices.filter((n) => !s.has(n.id)).length;
}
