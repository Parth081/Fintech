// Risk & Compliance data access (Ops API through the gateway at /api/ops/*).
import type { AlertView, AuditEntry, CaseDecision, CaseView, ConfigValues, DemoUser } from '@ct/contracts/browser';
import { opsApi, opsGet, opsPost, type Query } from '../../api';

const enc = encodeURIComponent;

/** The ops service adds the payment summary and whether the payment is still held (actionable) to every case. */
export type CaseExtras = { payment?: AlertView['payment']; actionable?: boolean; slaBreached?: boolean };
export type CaseRow = CaseView & CaseExtras;
export type CaseDetail = CaseRow & { alerts: AlertView[] };

/** Mutations return the updated case; the ops service may add the audit id / event id it wrote. */
export type CaseResult = CaseRow & { auditId?: string; eventId?: string; audit?: { id?: string; eventId?: string } };

export const riskApi = {
  alerts: (query: Query, signal?: AbortSignal) => opsApi.alerts(query, signal),
  cases: (query: Query, signal?: AbortSignal) => opsApi.cases(query, signal) as Promise<{ items: CaseRow[]; total: number }>,
  caseById: (id: string, signal?: AbortSignal) => opsGet<CaseDetail>(`/cases/${enc(id)}`, { signal }),
  activity: (paymentId: string, signal?: AbortSignal) => opsGet<AuditEntry[]>(`/payments/${enc(paymentId)}/activity`, { signal }),
  assign: (caseId: string, userId: string | null) => opsPost<CaseResult>(`/cases/${enc(caseId)}/assign`, { userId }, { permission: 'cases.work' }),
  note: (caseId: string, text: string) => opsPost<CaseResult>(`/cases/${enc(caseId)}/notes`, { text }, { permission: 'cases.work' }),
  decide: (caseId: string, decision: CaseDecision, reason: string) => opsPost<CaseResult>(`/cases/${enc(caseId)}/decide`, { decision, reason }, { permission: 'cases.decide' }),
  approve: (caseId: string, comment: string) => opsPost<CaseResult>(`/cases/${enc(caseId)}/approve`, { comment }, { permission: 'cases.approve' }),
  returnCase: (caseId: string, comment: string) => opsPost<CaseResult>(`/cases/${enc(caseId)}/return`, { comment }, { permission: 'cases.approve' }),
  /** Close a case whose payment is not held (nothing to release or reject). */
  close: (caseId: string, reason: string) => opsPost<CaseResult>(`/cases/${enc(caseId)}/close`, { reason }, { permission: 'cases.decide' }),
  users: (signal?: AbortSignal) => opsApi.demoUsers(signal) as Promise<DemoUser[]>,
  config: (signal?: AbortSignal) => opsGet<{ values: ConfigValues; versions: Partial<Record<string, number>> }>('/config', { signal }),
};

/** "audit AUD-12 · event 3f…" for toasts; empty when the server returned no reference. */
export function referenceOf(r: unknown): string {
  if (typeof r !== 'object' || r === null) return '';
  const o = r as Record<string, unknown>;
  const audit = typeof o.audit === 'object' && o.audit !== null ? (o.audit as Record<string, unknown>) : {};
  const auditId = o.auditId ?? audit.id;
  const eventId = o.eventId ?? audit.eventId;
  return [typeof auditId === 'string' ? `audit ${auditId}` : null, typeof eventId === 'string' ? `event ${eventId}` : null].filter(Boolean).join(' · ');
}
