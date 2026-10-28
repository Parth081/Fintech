// Pure logic for the Risk & Compliance queue and cases: filters, SLA countdown, queue views, workflow rules.
import type { Actor, AlertKind, AlertView, CaseStatus, CaseView, Permission, Severity } from '@ct/contracts/browser';

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
export const ALERT_KINDS: readonly AlertKind[] = ['sanctions', 'fraud', 'aml'];

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
export const severityRank = (s: Severity): number => SEVERITY_RANK[s] ?? 0;

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'neutral';

export function severityTone(s: Severity): Tone {
  return s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'info';
}

export const KIND_LABEL: Record<AlertKind, string> = { sanctions: 'Sanctions', fraud: 'Fraud', aml: 'AML' };

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  pending_approval: 'Pending approval',
  closed: 'Closed',
};

export function caseStatusTone(s: CaseStatus): Tone {
  return s === 'pending_approval' ? 'warn' : s === 'closed' ? 'neutral' : s === 'in_review' ? 'accent' : 'info';
}

/** SLA targets by priority (minutes) — mirrors the contract comment on CaseView.slaDueAt. */
export const SLA_MINUTES: Record<Severity, number> = { critical: 15, high: 60, medium: 240, low: 1440 };

// ---------------------------------------------------------------------------------------------- SLA

export interface SlaState {
  /** ms until due; negative when breached. */
  remainingMs: number;
  breached: boolean;
  /** "12m 04s left", "1h 05m left", "Breached 3m 10s ago". */
  label: string;
  tone: Tone;
}

function hms(ms: number): string {
  const totalS = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(totalS / 86_400);
  const h = Math.floor((totalS % 86_400) / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Countdown to `dueAt`. Tone: bad when breached or under 20% of the window (or 5 min) remains, warn under 50%.
 * `windowMs` is the full SLA window (for the ratio); when unknown the 5/30 minute marks are used.
 */
export function slaState(dueAt: string, nowMs: number, windowMs?: number): SlaState {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return { remainingMs: 0, breached: false, label: '—', tone: 'neutral' };
  const remainingMs = due - nowMs;
  if (remainingMs <= 0) return { remainingMs, breached: true, label: `Breached ${hms(remainingMs)} ago`, tone: 'bad' };
  const ratio = windowMs && windowMs > 0 ? remainingMs / windowMs : null;
  const tone: Tone =
    (ratio !== null && ratio < 0.2) || remainingMs < 5 * 60_000 ? 'bad' : (ratio !== null && ratio < 0.5) || (ratio === null && remainingMs < 30 * 60_000) ? 'warn' : 'ok';
  return { remainingMs, breached: false, label: `${hms(remainingMs)} left`, tone };
}

/** SLA for a case; closed cases stop the clock. */
export function caseSla(c: Pick<CaseView, 'slaDueAt' | 'openedAt' | 'status'>, nowMs: number): SlaState {
  if (c.status === 'closed') return { remainingMs: 0, breached: false, label: 'Closed', tone: 'neutral' };
  const window = Date.parse(c.slaDueAt) - Date.parse(c.openedAt);
  return slaState(c.slaDueAt, nowMs, Number.isFinite(window) ? window : undefined);
}

/** SLA for an alert (from raisedAt + the priority's window). */
export function alertSla(a: Pick<AlertView, 'raisedAt' | 'severity'>, nowMs: number): SlaState {
  const windowMs = SLA_MINUTES[a.severity] * 60_000;
  const raised = Date.parse(a.raisedAt);
  if (!Number.isFinite(raised)) return { remainingMs: 0, breached: false, label: '—', tone: 'neutral' };
  return slaState(new Date(raised + windowMs).toISOString(), nowMs, windowMs);
}

// ---------------------------------------------------------------------------------------------- alerts queue

export type AlertStatusFilter = 'open' | 'all' | 'closed';

export interface AlertFilter {
  kinds: AlertKind[]; // empty = any
  severities: Severity[]; // empty = any
  status: AlertStatusFilter;
  q: string;
}

export const EMPTY_ALERT_FILTER: AlertFilter = { kinds: [], severities: [], status: 'open', q: '' };

/** An alert is "open" while its payment is still held (operators have not decided yet). */
export function alertIsOpen(a: Pick<AlertView, 'payment'>, caseStatus?: CaseStatus): boolean {
  if (caseStatus) return caseStatus !== 'closed';
  return a.payment.status === 'held';
}

export function matchesAlert(a: AlertView, f: AlertFilter, caseStatusById?: ReadonlyMap<string, CaseStatus>): boolean {
  if (f.kinds.length && !f.kinds.includes(a.kind)) return false;
  if (f.severities.length && !f.severities.includes(a.severity)) return false;
  if (f.status !== 'all') {
    const open = alertIsOpen(a, a.caseId ? caseStatusById?.get(a.caseId) : undefined);
    if (f.status === 'open' ? !open : open) return false;
  }
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = [a.alertId, a.paymentId, a.caseId ?? '', a.rule, a.summary, a.payment.debtorName, a.payment.creditorName, a.payment.corridor].join(' ').toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  return true;
}

export function filterAlerts(list: readonly AlertView[], f: AlertFilter, caseStatusById?: ReadonlyMap<string, CaseStatus>): AlertView[] {
  return list.filter((a) => matchesAlert(a, f, caseStatusById));
}

/** Worst first, then oldest first (closest to SLA breach). */
export function sortAlerts(list: readonly AlertView[]): AlertView[] {
  return [...list].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || Date.parse(a.raisedAt) - Date.parse(b.raisedAt) || a.alertId.localeCompare(b.alertId));
}

/** Query string for GET /ops/alerts (server-side filtering when the server supports it). */
export function alertQuery(f: AlertFilter, limit = 200, offset = 0): string {
  const p = new URLSearchParams();
  if (f.status !== 'all') p.set('status', f.status);
  if (f.kinds.length) p.set('kind', f.kinds.join(','));
  if (f.severities.length) p.set('severity', f.severities.join(','));
  if (f.q.trim()) p.set('q', f.q.trim());
  p.set('limit', String(limit));
  p.set('offset', String(offset));
  return p.toString();
}

export function countBy<T, K extends string>(list: readonly T[], key: (t: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const t of list) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
}

/** Distinct case ids among the selected alerts that the user could assign to themselves. */
export function bulkAssignTargets(selected: readonly AlertView[], cases: ReadonlyMap<string, Pick<CaseView, 'assignee' | 'status'>>, userId: string): string[] {
  const out = new Set<string>();
  for (const a of selected) {
    if (!a.caseId) continue;
    const c = cases.get(a.caseId);
    if (c && (c.status === 'closed' || c.assignee?.userId === userId)) continue;
    out.add(a.caseId);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------- case queues

export type CaseQueue = 'mine' | 'unassigned' | 'approval' | 'all';

export const CASE_QUEUES: readonly { id: CaseQueue; label: string }[] = [
  { id: 'mine', label: 'My cases' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'approval', label: 'Pending my approval' },
  { id: 'all', label: 'All' },
];

export function inQueue(c: CaseView, queue: CaseQueue, userId: string): boolean {
  switch (queue) {
    case 'mine':
      return c.assignee?.userId === userId && c.status !== 'closed';
    case 'unassigned':
      return c.assignee === null && c.status !== 'closed';
    case 'approval':
      return c.status === 'pending_approval' && c.proposal !== null && c.proposal.by.userId !== userId;
    case 'all':
      return true;
  }
}

/** Open first, then priority, then SLA due soonest. */
export function sortCases<C extends CaseView>(list: readonly C[]): C[] {
  return [...list].sort(
    (a, b) =>
      Number(a.status === 'closed') - Number(b.status === 'closed') ||
      severityRank(b.priority) - severityRank(a.priority) ||
      Date.parse(a.slaDueAt) - Date.parse(b.slaDueAt) ||
      a.caseId.localeCompare(b.caseId),
  );
}

export function filterCases<C extends CaseView>(list: readonly C[], queue: CaseQueue, userId: string, q = ''): C[] {
  const needle = q.trim().toLowerCase();
  return sortCases(list.filter((c) => inQueue(c, queue, userId) && (!needle || `${c.caseId} ${c.paymentId} ${c.assignee?.name ?? ''}`.toLowerCase().includes(needle))));
}

// ---------------------------------------------------------------------------------------------- workflow rules

/** High and critical decisions need a Compliance Manager's approval (four-eyes). */
export const requiresApproval = (priority: Severity): boolean => priority === 'high' || priority === 'critical';

export interface Gate {
  allowed: boolean;
  /** Why not (tooltip): a missing permission or a workflow rule. */
  reason?: string;
}

type Can = (p: Permission) => boolean;

const missing = (p: Permission): Gate => ({ allowed: false, reason: `Requires permission ${p}` });

export function canAssign(c: CaseView, can: Can): Gate {
  if (!can('cases.work')) return missing('cases.work');
  if (c.status === 'closed') return { allowed: false, reason: 'Case is closed' };
  return { allowed: true };
}

export function canAddNote(c: CaseView, can: Can): Gate {
  if (!can('cases.work')) return missing('cases.work');
  return { allowed: true };
}

export function canDecide(c: CaseView, can: Can, me: Actor | null): Gate {
  if (!can('cases.decide')) return missing('cases.decide');
  if (c.status === 'closed') return { allowed: false, reason: 'Case is closed' };
  if (c.status === 'pending_approval') return { allowed: false, reason: 'A decision is already waiting for approval' };
  if (c.assignee && me && c.assignee.userId !== me.userId) return { allowed: false, reason: `Assigned to ${c.assignee.name} — assign it to yourself first` };
  return { allowed: true };
}

export function canApprove(c: CaseView, can: Can, me: Actor | null): Gate {
  if (!can('cases.approve')) return missing('cases.approve');
  if (c.status !== 'pending_approval' || !c.proposal) return { allowed: false, reason: 'Nothing is waiting for approval' };
  if (me && c.proposal.by.userId === me.userId) return { allowed: false, reason: 'Four-eyes rule: you proposed this decision, another manager must approve it' };
  return { allowed: true };
}

export const MIN_REASON_LENGTH = 10;

export function validateReason(text: string, min = MIN_REASON_LENGTH): string | null {
  const t = text.trim();
  if (!t) return 'A reason is required';
  if (t.length < min) return `Please write at least ${min} characters`;
  return null;
}

// ---------------------------------------------------------------------------------------------- history

export interface HistoryItem {
  at: string;
  title: string;
  detail?: string;
  actor?: string;
  tone: Tone;
}

/** Case history built from the case record itself (opened, alerts, notes, proposal, decision). Oldest first. */
export function caseHistory(c: CaseView, alerts: readonly Pick<AlertView, 'alertId' | 'raisedAt' | 'kind' | 'severity' | 'summary'>[]): HistoryItem[] {
  const items: HistoryItem[] = [{ at: c.openedAt, title: 'Case opened', detail: `Priority ${c.priority}`, tone: 'info' }];
  for (const a of alerts) items.push({ at: a.raisedAt, title: `${KIND_LABEL[a.kind]} alert raised (${a.severity})`, detail: a.summary, tone: severityTone(a.severity) });
  for (const n of c.notes) items.push({ at: n.at, title: 'Note added', detail: n.text, actor: n.actor.name, tone: 'neutral' });
  if (c.proposal) items.push({ at: c.proposal.at, title: `Proposed: ${c.proposal.decision}`, detail: c.proposal.reason, actor: c.proposal.by.name, tone: 'warn' });
  if (c.decision) {
    items.push({
      at: c.decision.at,
      title: `Decision: ${c.decision.decision}${c.decision.approvedBy ? ` (approved by ${c.decision.approvedBy.name})` : ''}`,
      detail: c.decision.reason,
      actor: c.decision.by.name,
      tone: c.decision.decision === 'release' ? 'ok' : 'bad',
    });
  }
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Query object for opsApi.alerts (server-side filtering: status open|closed, kind/severity comma lists, q). */
export function alertQueryParams(f: AlertFilter, limit = 200, offset = 0): Record<string, string | number> {
  const q: Record<string, string | number> = { limit, offset };
  if (f.status !== 'all') q.status = f.status;
  if (f.kinds.length) q.kind = f.kinds.join(',');
  if (f.severities.length) q.severity = f.severities.join(',');
  if (f.q.trim()) q.q = f.q.trim();
  return q;
}

/** Users whose role holds `permission` (e.g. who a case can be reassigned to). */
export function usersWith<U extends { role: string }>(users: readonly U[], permission: Permission, rolePermissions: Readonly<Record<string, readonly Permission[]>>): U[] {
  return users.filter((u) => rolePermissions[u.role]?.includes(permission));
}
