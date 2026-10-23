// M4: the Operations service (services/ops, default http://127.0.0.1:7075) — the enterprise back office:
// demo users and roles, risk/compliance alert & case workflow, operator actions on payments, maker-checker
// configuration changes, reconciliation break queue, audit trail, developer keys/webhooks.
// The browser reaches it through the gateway at /api/ops/* (same paths, prefixed).
import type { Actor, Money, PaymentStatus } from './events';
import type { ConfigKey } from './control';

// ---------------------------------------------------------------------------------------------- users & roles

export type Role =
  | 'ops_analyst' // payment operations: search, retry failed, request refunds
  | 'compliance_analyst' // works alerts and cases, recommends decisions
  | 'compliance_manager' // approves high-risk releases and refunds (second pair of eyes)
  | 'treasury' // FX positions, provider statements, reconciliation breaks
  | 'admin' // configuration change requests/approvals, users, developer settings
  | 'auditor'; // read-only everything, including the audit trail

export type Permission =
  | 'payments.read' | 'payments.retry' | 'payments.refund.request' | 'payments.refund.approve'
  | 'alerts.read' | 'cases.work' | 'cases.decide' | 'cases.approve'
  | 'recon.read' | 'recon.resolve'
  | 'config.read' | 'config.request' | 'config.approve'
  | 'audit.read' | 'users.read' | 'developer.manage';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ops_analyst: ['payments.read', 'payments.retry', 'payments.refund.request', 'alerts.read', 'recon.read', 'config.read'],
  compliance_analyst: ['payments.read', 'alerts.read', 'cases.work', 'cases.decide', 'config.read'],
  compliance_manager: ['payments.read', 'alerts.read', 'cases.work', 'cases.decide', 'cases.approve', 'payments.refund.approve', 'config.read', 'audit.read'],
  treasury: ['payments.read', 'recon.read', 'recon.resolve', 'config.read'],
  admin: ['payments.read', 'alerts.read', 'recon.read', 'config.read', 'config.request', 'config.approve', 'audit.read', 'users.read', 'developer.manage'],
  auditor: ['payments.read', 'alerts.read', 'recon.read', 'config.read', 'audit.read', 'users.read'],
};

export interface DemoUser {
  id: string; // e.g. "u-maya"
  name: string; // fictional
  title: string; // e.g. "Payment Operations Analyst"
  role: Role;
  initials: string;
}

export interface Session {
  token: string; // opaque bearer token, sent as `Authorization: Bearer <token>` (the UI keeps it in sessionStorage)
  user: DemoUser;
  permissions: Permission[];
  expiresAt: string;
}

// ---------------------------------------------------------------------------------------------- alerts & cases

export type AlertKind = 'sanctions' | 'fraud' | 'aml';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertView {
  alertId: string;
  paymentId: string;
  kind: AlertKind;
  severity: Severity;
  rule: string;
  score?: number;
  summary: string;
  reasons: { code: string; text: string; weight?: number }[];
  evidence: Record<string, unknown>;
  raisedAt: string;
  caseId: string | null; // alerts on the same payment roll up into one case
  payment: { status: PaymentStatus; corridor: string; amount: Money; debtorName: string; creditorName: string };
}

export type CaseStatus = 'open' | 'in_review' | 'pending_approval' | 'closed';
export type CaseDecision = 'release' | 'reject';

export interface CaseNote { at: string; actor: Actor; text: string }

export interface CaseView {
  caseId: string; // e.g. "CASE-2026-000123"
  paymentId: string;
  status: CaseStatus;
  priority: Severity; // = highest alert severity
  alertIds: string[];
  assignee: Actor | null;
  openedAt: string;
  slaDueAt: string; // e.g. critical 15 min, high 1 h, medium 4 h, low 24 h
  notes: CaseNote[];
  /** Recommended by an analyst; for high/critical cases a manager must approve before it takes effect. */
  proposal: { decision: CaseDecision; reason: string; by: Actor; at: string } | null;
  decision: { decision: CaseDecision; reason: string; by: Actor; approvedBy?: Actor; at: string } | null;
}

// ---------------------------------------------------------------------------------------------- config (maker-checker)

export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ChangeRequest {
  id: string; // e.g. "CR-000042"
  key: ConfigKey;
  currentValue: unknown;
  proposedValue: unknown;
  reason: string;
  requestedBy: Actor;
  requestedAt: string;
  status: ChangeStatus;
  reviewedBy?: Actor; // must differ from requestedBy (four-eyes)
  reviewedAt?: string;
  reviewComment?: string;
  appliedVersion?: number; // set when approved and published as control.config.updated
}

// ---------------------------------------------------------------------------------------------- reconciliation

export type BreakStatus = 'open' | 'investigating' | 'resolved';

export interface ReconBreak {
  breakId: string;
  paymentId: string;
  providerId: string;
  detectedAt: string;
  breaks: string[]; // from payment.reconciled.breaks
  expected: Money;
  reported: Money | null;
  status: BreakStatus;
  assignee: Actor | null;
  resolution?: { code: 'WRITE_OFF' | 'PROVIDER_ADJUSTMENT' | 'LEDGER_CORRECTION' | 'FALSE_POSITIVE'; note: string; by: Actor; at: string };
}

// ---------------------------------------------------------------------------------------------- audit & developer

export interface AuditEntry {
  id: string;
  at: string;
  actor: Actor | { userId: 'system'; name: 'System'; role: 'system' };
  action: string; // e.g. "case.assigned", "payment.released", "config.change.approved", "auth.login"
  target: { type: 'payment' | 'case' | 'alert' | 'config' | 'break' | 'user' | 'apikey' | 'webhook'; id: string };
  details: Record<string, unknown>;
  /** Event id on the payment log when the action produced one (links the audit row to the immutable log). */
  eventId?: string;
}

export interface ApiKeyView { id: string; name: string; prefix: string; createdAt: string; createdBy: Actor; lastUsedAt: string | null; revokedAt: string | null; scopes: string[] }
export interface WebhookEndpoint { id: string; url: string; events: string[]; enabled: boolean; createdAt: string }
export interface WebhookDelivery { id: string; endpointId: string; eventId: string; eventType: string; at: string; status: 'delivered' | 'failed' | 'simulated'; responseMs: number }

// ---------------------------------------------------------------------------------------------- overview

export interface OpsOverview {
  asOf: string;
  payments: { today: number; volumeUsdToday: number; successRate: number; inFlight: number; held: number; failed: number };
  alerts: { open: number; bySeverity: Record<Severity, number> };
  cases: { open: number; pendingApproval: number; breachingSla: number; myAssigned: number };
  recon: { openBreaks: number; matchRate: number };
  changes: { pending: number };
}

/**
 * Ops API (all JSON; all routes except /health and /auth/* require a Bearer token; 401 without, 403 when the
 * role lacks the permission). Every mutating route writes an AuditEntry; actions on payments publish events
 * (producer 'ops', payload.actor) and return 202 with the eventId.
 *
 *   GET  /health
 *   GET  /auth/users                               -> DemoUser[]                (sign-in screen)
 *   POST /auth/login { userId }                    -> Session                   (demo sign-in, no password)
 *   POST /auth/logout                              -> { ok }
 *   GET  /me                                       -> Session
 *   GET  /overview                                 -> OpsOverview
 *
 *   GET  /alerts?status=&kind=&severity=&q=&limit=&offset=   -> AlertView[]   (X-Total-Count)
 *   GET  /cases?status=&assignee=me|<userId>&priority=&q=    -> CaseView[]    (X-Total-Count)
 *   GET  /cases/:id                                -> CaseView & { alerts: AlertView[] }
 *   POST /cases/:id/assign { userId | null }       -> CaseView      (cases.work)
 *   POST /cases/:id/notes { text }                 -> CaseView      (cases.work)
 *   POST /cases/:id/decide { decision, reason }    -> CaseView      (cases.decide) low/medium: takes effect;
 *                                                                    high/critical: becomes a proposal -> pending_approval
 *   POST /cases/:id/approve { comment }            -> CaseView      (cases.approve; approver != proposer)
 *   POST /cases/:id/return { comment }             -> CaseView      (cases.approve; back to in_review)
 *
 *   POST /payments/:id/retry { reason }            -> { eventId }   (payments.retry; status failed)
 *   POST /payments/:id/refunds { reason }          -> ChangeRequest-like refund request; needs payments.refund.approve
 *   GET  /refunds?status=                          -> refund requests
 *   POST /refunds/:id/approve | /reject { comment }-> publishes payment.refund_requested on approve
 *   GET  /payments/:id/activity                    -> AuditEntry[]  (operator actions on that payment)
 *
 *   GET  /config                                   -> { values, versions }  (from the log)
 *   GET  /changes?status=                          -> ChangeRequest[]
 *   POST /changes { key, proposedValue, reason }   -> ChangeRequest (config.request; validated per key)
 *   POST /changes/:id/approve { comment }          -> ChangeRequest (config.approve; reviewer != requester)
 *                                                     publishes control.config.updated
 *   POST /changes/:id/reject { comment } | /withdraw
 *
 *   GET  /recon/breaks?status=                     -> ReconBreak[]
 *   POST /recon/breaks/:id/assign { userId|null } | /resolve { code, note }
 *
 *   GET  /audit?actor=&action=&targetType=&targetId=&from=&to=&limit=&offset=  -> AuditEntry[] (X-Total-Count)
 *   GET  /audit/export.csv                         -> text/csv
 *   GET  /users                                    -> DemoUser[] with role and permissions
 *
 *   GET  /developer/keys | POST /developer/keys { name, scopes } (returns the secret once) | POST /developer/keys/:id/revoke
 *   GET  /developer/webhooks | POST /developer/webhooks { url, events } | GET /developer/webhooks/deliveries
 *        (deliveries are SIMULATED in the demo: nothing is sent off the machine)
 */
export const OPS_API_DOC = true;
