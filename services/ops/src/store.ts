// OpsStore: the back office's own database (workflow state only; everything that "happened" is on the log).
import type {
  Actor,
  ApiKeyView,
  AuditEntry,
  CaseDecision,
  CaseNote,
  CaseStatus,
  ChangeRequest,
  ChangeStatus,
  ConfigKey,
  Money,
  ReconBreak,
  Severity,
  WebhookDelivery,
  WebhookEndpoint,
} from '@ct/contracts';
import { migrate, openDriver, type DriverOptions, type Queryable, type Row, type SqlDriver } from './db';
import { SEVERITY_RANK, SLA_MINUTES } from './users';

export type AuditActor = AuditEntry['actor'];
export type AuditTargetType = AuditEntry['target']['type'];

export interface CaseRow {
  caseId: string;
  paymentId: string;
  status: CaseStatus;
  priority: Severity;
  openedAt: string;
  slaDueAt: string;
  assignee: Actor | null;
  proposal: { decision: CaseDecision; reason: string; by: Actor; at: string } | null;
  /** closedAtOffset: log head when the case closed (internal; a later payment.held reopens the case). */
  decision: { decision: CaseDecision; reason: string; by: Actor; approvedBy?: Actor; at: string; closedWithoutAction?: boolean; closedAtOffset?: number } | null;
  eventId: string | null;
  alertIds: string[];
  notes: CaseNote[];
}

export interface RefundRequest {
  id: string; // e.g. "RF-000007"
  paymentId: string;
  amount: Money;
  reason: string;
  requestedBy: Actor;
  requestedAt: string;
  status: ChangeStatus;
  reviewedBy?: Actor;
  reviewedAt?: string;
  reviewComment?: string;
  eventId: string; // deterministic id of the payment.refund_requested event published on approval
}

export type BreakRow = Pick<ReconBreak, 'breakId' | 'paymentId' | 'detectedAt' | 'status' | 'assignee' | 'resolution'> & { eventId: string };

export interface AuditFilter {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  paymentId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface NewAudit {
  at: string;
  actor: AuditActor;
  action: string;
  target: AuditEntry['target'];
  details?: Record<string, unknown>;
  paymentId?: string;
  eventId?: string;
  /** System rows written while folding the log use a dedupe key so replays never duplicate them. */
  dedupeKey?: string;
}

export interface StoredApiKey extends ApiKeyView {
  secretHash: string;
}

export interface StoredWebhook extends WebhookEndpoint {
  createdBy: Actor;
  fromOffset: number;
  deletedAt: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export function slaDue(openedAt: string, priority: Severity): string {
  return new Date(Date.parse(openedAt) + SLA_MINUTES[priority] * 60_000).toISOString();
}

export class OpsStore {
  private constructor(readonly driver: SqlDriver) {}

  get kind(): SqlDriver['kind'] {
    return this.driver.kind;
  }

  static async open(options: DriverOptions = {}): Promise<OpsStore> {
    const driver = await openDriver(options);
    try {
      await migrate(driver);
    } catch (err) {
      await driver.close();
      throw err;
    }
    return new OpsStore(driver);
  }

  close(): Promise<void> {
    return this.driver.close();
  }

  // ------------------------------------------------------------------------------------------- sessions

  async createSession(tokenHash: string, userId: string, createdAt: string, expiresAt: string): Promise<void> {
    await this.driver.query('INSERT INTO ops.sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)', [tokenHash, userId, createdAt, expiresAt]);
  }

  async session(tokenHash: string): Promise<{ userId: string; expiresAt: string; revokedAt: string | null } | undefined> {
    const [r] = await this.driver.query('SELECT user_id, expires_at, revoked_at FROM ops.sessions WHERE token_hash = $1', [tokenHash]);
    return r ? { userId: String(r.user_id), expiresAt: String(r.expires_at), revokedAt: (r.revoked_at as string | null) ?? null } : undefined;
  }

  async revokeSession(tokenHash: string, at: string): Promise<void> {
    await this.driver.query('UPDATE ops.sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash, at]);
  }

  // ------------------------------------------------------------------------------------------- cases

  /**
   * Link an alert to its payment's case, opening the case if needed. Idempotent on alertId (replays are
   * no-ops). Priority escalates to the highest severity seen; the SLA follows the priority from openedAt.
   */
  async linkAlert(input: { alertId: string; paymentId: string; severity: Severity; raisedAt: string }): Promise<{ caseId: string; opened: boolean; linked: boolean }> {
    return this.driver.transaction(async (q) => {
      const [linked] = await q.query('SELECT case_id FROM ops.case_alerts WHERE alert_id = $1', [input.alertId]);
      if (linked) return { caseId: String(linked.case_id), opened: false, linked: false };
      let [c] = await q.query('SELECT case_id, priority, opened_at FROM ops.cases WHERE payment_id = $1', [input.paymentId]);
      let opened = false;
      if (!c) {
        const [s] = await q.query("SELECT nextval('ops.case_seq') AS n");
        const caseId = `CASE-${input.raisedAt.slice(0, 4)}-${pad(num(s?.n))}`;
        await q.query(
          `INSERT INTO ops.cases (case_id, payment_id, status, priority, opened_at, sla_due_at, updated_at) VALUES ($1,$2,'open',$3,$4,$5,$4)`,
          [caseId, input.paymentId, input.severity, input.raisedAt, slaDue(input.raisedAt, input.severity)],
        );
        c = { case_id: caseId, priority: input.severity, opened_at: input.raisedAt };
        opened = true;
      } else if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[c.priority as Severity]) {
        await q.query('UPDATE ops.cases SET priority = $2, sla_due_at = $3 WHERE case_id = $1', [c.case_id, input.severity, slaDue(String(c.opened_at), input.severity)]);
      }
      await q.query('INSERT INTO ops.case_alerts (alert_id, case_id, severity, raised_at) VALUES ($1,$2,$3,$4)', [input.alertId, c.case_id, input.severity, input.raisedAt]);
      return { caseId: String(c.case_id), opened, linked: true };
    });
  }

  private async hydrateCases(rows: Row[]): Promise<CaseRow[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => String(r.case_id));
    const all = rows.length > 50;
    const inList = all ? '' : `WHERE case_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`;
    const params = all ? [] : ids;
    const alerts = await this.driver.query(`SELECT alert_id, case_id FROM ops.case_alerts ${inList} ORDER BY raised_at, alert_id`, params);
    const notes = await this.driver.query(`SELECT case_id, at, actor, text FROM ops.case_notes ${inList} ORDER BY seq`, params);
    const alertMap = new Map<string, string[]>();
    for (const a of alerts) alertMap.set(String(a.case_id), [...(alertMap.get(String(a.case_id)) ?? []), String(a.alert_id)]);
    const noteMap = new Map<string, CaseNote[]>();
    for (const n of notes) noteMap.set(String(n.case_id), [...(noteMap.get(String(n.case_id)) ?? []), { at: String(n.at), actor: n.actor as Actor, text: String(n.text) }]);
    return rows.map((r) => ({
      caseId: String(r.case_id),
      paymentId: String(r.payment_id),
      status: r.status as CaseStatus,
      priority: r.priority as Severity,
      openedAt: String(r.opened_at),
      slaDueAt: String(r.sla_due_at),
      assignee: (r.assignee as Actor | null) ?? null,
      proposal: (r.proposal as CaseRow['proposal']) ?? null,
      decision: (r.decision as CaseRow['decision']) ?? null,
      eventId: (r.event_id as string | null) ?? null,
      alertIds: alertMap.get(String(r.case_id)) ?? [],
      notes: noteMap.get(String(r.case_id)) ?? [],
    }));
  }

  async cases(): Promise<CaseRow[]> {
    return this.hydrateCases(await this.driver.query('SELECT * FROM ops.cases ORDER BY opened_at, case_id'));
  }

  async case(caseId: string): Promise<CaseRow | undefined> {
    return (await this.hydrateCases(await this.driver.query('SELECT * FROM ops.cases WHERE case_id = $1', [caseId])))[0];
  }

  async caseByPayment(paymentId: string): Promise<CaseRow | undefined> {
    return (await this.hydrateCases(await this.driver.query('SELECT * FROM ops.cases WHERE payment_id = $1', [paymentId])))[0];
  }

  async caseIdsByAlert(): Promise<Map<string, string>> {
    const rows = await this.driver.query('SELECT alert_id, case_id FROM ops.case_alerts');
    return new Map(rows.map((r) => [String(r.alert_id), String(r.case_id)]));
  }

  async updateCase(caseId: string, patch: Partial<Pick<CaseRow, 'status' | 'assignee' | 'proposal' | 'decision' | 'eventId'>>, at: string): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [caseId, at];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.assignee !== undefined) add('assignee', json(patch.assignee));
    if (patch.proposal !== undefined) add('proposal', json(patch.proposal));
    if (patch.decision !== undefined) add('decision', json(patch.decision));
    if (patch.eventId !== undefined) add('event_id', patch.eventId);
    await this.driver.query(`UPDATE ops.cases SET ${[...sets, 'updated_at = $2'].join(', ')} WHERE case_id = $1`, params);
  }

  async addNote(caseId: string, note: CaseNote): Promise<void> {
    await this.driver.query('INSERT INTO ops.case_notes (case_id, at, actor, text) VALUES ($1,$2,$3,$4)', [caseId, note.at, json(note.actor), note.text]);
  }

  // ------------------------------------------------------------------------------------------- config changes

  async createChange(input: Omit<ChangeRequest, 'id' | 'status'>): Promise<ChangeRequest> {
    const [s] = await this.driver.query("SELECT nextval('ops.change_seq') AS n");
    const id = `CR-${pad(num(s?.n))}`;
    await this.driver.query(
      `INSERT INTO ops.change_requests (id, key, current_value, proposed_value, reason, requested_by, requested_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [id, input.key, json(input.currentValue), json(input.proposedValue), input.reason, json(input.requestedBy), input.requestedAt],
    );
    return (await this.change(id))!;
  }

  private toChange(r: Row): ChangeRequest {
    return {
      id: String(r.id),
      key: r.key as ConfigKey,
      currentValue: r.current_value,
      proposedValue: r.proposed_value,
      reason: String(r.reason),
      requestedBy: r.requested_by as Actor,
      requestedAt: String(r.requested_at),
      status: r.status as ChangeStatus,
      reviewedBy: opt<Actor>(r.reviewed_by),
      reviewedAt: opt<string>(r.reviewed_at),
      reviewComment: opt<string>(r.review_comment),
      appliedVersion: r.applied_version === null || r.applied_version === undefined ? undefined : num(r.applied_version),
    };
  }

  async change(id: string): Promise<ChangeRequest | undefined> {
    const [r] = await this.driver.query('SELECT * FROM ops.change_requests WHERE id = $1', [id]);
    return r ? this.toChange(r) : undefined;
  }

  async changes(status?: string): Promise<ChangeRequest[]> {
    const rows = status
      ? await this.driver.query('SELECT * FROM ops.change_requests WHERE status = $1 ORDER BY requested_at DESC, id DESC', [status])
      : await this.driver.query('SELECT * FROM ops.change_requests ORDER BY requested_at DESC, id DESC');
    return rows.map((r) => this.toChange(r));
  }

  async reviewChange(id: string, patch: { status: ChangeStatus; reviewedBy?: Actor; reviewedAt: string; reviewComment?: string; appliedVersion?: number; eventId?: string }): Promise<void> {
    await this.driver.query(
      'UPDATE ops.change_requests SET status=$2, reviewed_by=$3, reviewed_at=$4, review_comment=$5, applied_version=$6, event_id=$7 WHERE id=$1',
      [id, patch.status, json(patch.reviewedBy), patch.reviewedAt, patch.reviewComment ?? null, patch.appliedVersion ?? null, patch.eventId ?? null],
    );
  }

  // ------------------------------------------------------------------------------------------- refunds

  async createRefund(input: Omit<RefundRequest, 'id' | 'status' | 'eventId'>, eventIdFor: (id: string) => string): Promise<RefundRequest> {
    const [s] = await this.driver.query("SELECT nextval('ops.refund_seq') AS n");
    const id = `RF-${pad(num(s?.n))}`;
    await this.driver.query(
      `INSERT INTO ops.refund_requests (id, payment_id, amount, reason, requested_by, requested_at, status, event_id) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
      [id, input.paymentId, json(input.amount), input.reason, json(input.requestedBy), input.requestedAt, eventIdFor(id)],
    );
    return (await this.refund(id))!;
  }

  private toRefund(r: Row): RefundRequest {
    return {
      id: String(r.id),
      paymentId: String(r.payment_id),
      amount: r.amount as Money,
      reason: String(r.reason),
      requestedBy: r.requested_by as Actor,
      requestedAt: String(r.requested_at),
      status: r.status as ChangeStatus,
      reviewedBy: opt<Actor>(r.reviewed_by),
      reviewedAt: opt<string>(r.reviewed_at),
      reviewComment: opt<string>(r.review_comment),
      eventId: String(r.event_id),
    };
  }

  async refund(id: string): Promise<RefundRequest | undefined> {
    const [r] = await this.driver.query('SELECT * FROM ops.refund_requests WHERE id = $1', [id]);
    return r ? this.toRefund(r) : undefined;
  }

  async refunds(filter: { status?: string; paymentId?: string } = {}): Promise<RefundRequest[]> {
    const rows = await this.driver.query(
      'SELECT * FROM ops.refund_requests WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR payment_id = $2) ORDER BY requested_at DESC, id DESC',
      [filter.status ?? null, filter.paymentId ?? null],
    );
    return rows.map((r) => this.toRefund(r));
  }

  async reviewRefund(id: string, patch: { status: ChangeStatus; reviewedBy?: Actor; reviewedAt: string; reviewComment?: string }): Promise<void> {
    await this.driver.query('UPDATE ops.refund_requests SET status=$2, reviewed_by=$3, reviewed_at=$4, review_comment=$5 WHERE id=$1', [
      id,
      patch.status,
      json(patch.reviewedBy),
      patch.reviewedAt,
      patch.reviewComment ?? null,
    ]);
  }

  // ------------------------------------------------------------------------------------------- recon breaks

  /** Register a break detected on the log. Idempotent on paymentId. */
  async ensureBreak(input: { paymentId: string; eventId: string; detectedAt: string }): Promise<{ breakId: string; created: boolean }> {
    return this.driver.transaction(async (q) => {
      const [existing] = await q.query('SELECT break_id FROM ops.recon_breaks WHERE payment_id = $1', [input.paymentId]);
      if (existing) return { breakId: String(existing.break_id), created: false };
      const [s] = await q.query("SELECT nextval('ops.break_seq') AS n");
      const breakId = `BRK-${pad(num(s?.n))}`;
      await q.query(`INSERT INTO ops.recon_breaks (break_id, payment_id, event_id, detected_at, status) VALUES ($1,$2,$3,$4,'open')`, [breakId, input.paymentId, input.eventId, input.detectedAt]);
      return { breakId, created: true };
    });
  }

  private toBreak(r: Row): BreakRow {
    return {
      breakId: String(r.break_id),
      paymentId: String(r.payment_id),
      eventId: String(r.event_id),
      detectedAt: String(r.detected_at),
      status: r.status as BreakRow['status'],
      assignee: (r.assignee as Actor | null) ?? null,
      resolution: opt<NonNullable<ReconBreak['resolution']>>(r.resolution),
    };
  }

  async breaks(status?: string): Promise<BreakRow[]> {
    const rows = await this.driver.query('SELECT * FROM ops.recon_breaks WHERE ($1::text IS NULL OR status = $1) ORDER BY detected_at DESC, break_id DESC', [status ?? null]);
    return rows.map((r) => this.toBreak(r));
  }

  async break(breakId: string): Promise<BreakRow | undefined> {
    const [r] = await this.driver.query('SELECT * FROM ops.recon_breaks WHERE break_id = $1', [breakId]);
    return r ? this.toBreak(r) : undefined;
  }

  async updateBreak(breakId: string, patch: { status: BreakRow['status']; assignee: Actor | null; resolution?: ReconBreak['resolution'] }): Promise<void> {
    await this.driver.query('UPDATE ops.recon_breaks SET status=$2, assignee=$3, resolution=$4 WHERE break_id=$1', [breakId, patch.status, json(patch.assignee), json(patch.resolution)]);
  }

  // ------------------------------------------------------------------------------------------- audit

  /** Append one audit row. Returns false when a row with the same dedupeKey already exists. */
  async audit(entry: NewAudit, q: Queryable = this.driver): Promise<boolean> {
    const rows = await q.query(
      `INSERT INTO ops.audit_log (at, actor, action, target_type, target_id, payment_id, details, event_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING seq`,
      [entry.at, json(entry.actor), entry.action, entry.target.type, entry.target.id, entry.paymentId ?? null, json(entry.details ?? {}), entry.eventId ?? null, entry.dedupeKey ?? null],
    );
    return rows.length > 0;
  }

  private toAudit(r: Row): AuditEntry & { paymentId?: string } {
    return {
      id: `AUD-${pad(num(r.seq), 8)}`,
      at: String(r.at),
      actor: r.actor as AuditEntry['actor'],
      action: String(r.action),
      target: { type: r.target_type as AuditTargetType, id: String(r.target_id) },
      details: (r.details as Record<string, unknown>) ?? {},
      ...(r.event_id ? { eventId: String(r.event_id) } : {}),
      ...(r.payment_id ? { paymentId: String(r.payment_id) } : {}),
    };
  }

  async auditQuery(f: AuditFilter = {}): Promise<{ total: number; rows: (AuditEntry & { paymentId?: string })[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.actor) add(`actor->>'userId' = ?`, f.actor);
    if (f.action) {
      if (f.action.endsWith('*')) add('action LIKE ?', `${f.action.slice(0, -1).replace(/[%_]/g, '\\$&')}%`);
      else add('action = ?', f.action);
    }
    if (f.targetType) add('target_type = ?', f.targetType);
    if (f.targetId) add('target_id = ?', f.targetId);
    if (f.paymentId) add('payment_id = ?', f.paymentId);
    if (f.from) add('at >= ?', f.from);
    if (f.to) add('at <= ?', f.to);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [c] = await this.driver.query(`SELECT count(*) AS n FROM ops.audit_log ${w}`, params);
    let sql = `SELECT * FROM ops.audit_log ${w} ORDER BY seq DESC`;
    if (f.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(f.limit))}`;
    if (f.offset) sql += ` OFFSET ${Math.max(0, Math.floor(f.offset))}`;
    const rows = await this.driver.query(sql, params);
    return { total: num(c?.n), rows: rows.map((r) => this.toAudit(r)) };
  }

  // ------------------------------------------------------------------------------------------- developer

  async createApiKey(k: StoredApiKey): Promise<void> {
    await this.driver.query('INSERT INTO ops.api_keys (id, name, prefix, secret_hash, scopes, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      k.id,
      k.name,
      k.prefix,
      k.secretHash,
      json(k.scopes),
      k.createdAt,
      json(k.createdBy),
    ]);
  }

  async apiKeys(): Promise<StoredApiKey[]> {
    const rows = await this.driver.query('SELECT * FROM ops.api_keys ORDER BY created_at DESC, id');
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      prefix: String(r.prefix),
      secretHash: String(r.secret_hash),
      scopes: r.scopes as string[],
      createdAt: String(r.created_at),
      createdBy: r.created_by as Actor,
      lastUsedAt: (r.last_used_at as string | null) ?? null,
      revokedAt: (r.revoked_at as string | null) ?? null,
    }));
  }

  async revokeApiKey(id: string, at: string): Promise<void> {
    await this.driver.query('UPDATE ops.api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, at]);
  }

  async createWebhook(w: Omit<StoredWebhook, 'deletedAt'>): Promise<void> {
    await this.driver.query('INSERT INTO ops.webhook_endpoints (id, url, events, enabled, created_at, created_by, from_offset) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      w.id,
      w.url,
      json(w.events),
      w.enabled,
      w.createdAt,
      json(w.createdBy),
      w.fromOffset,
    ]);
  }

  async setWebhookEnabled(id: string, enabled: boolean): Promise<void> {
    await this.driver.query('UPDATE ops.webhook_endpoints SET enabled = $2 WHERE id = $1', [id, enabled]);
  }

  async updateWebhook(id: string, patch: { url: string; events: string[]; enabled: boolean }): Promise<void> {
    await this.driver.query('UPDATE ops.webhook_endpoints SET url = $2, events = $3, enabled = $4 WHERE id = $1 AND deleted_at IS NULL', [id, patch.url, json(patch.events), patch.enabled]);
  }

  /** Soft delete: the endpoint disappears from lists and receives nothing; its delivery history is kept. */
  async deleteWebhook(id: string, at: string): Promise<void> {
    await this.driver.query('UPDATE ops.webhook_endpoints SET deleted_at = $2, enabled = false WHERE id = $1 AND deleted_at IS NULL', [id, at]);
  }

  async webhooks(): Promise<StoredWebhook[]> {
    const rows = await this.driver.query('SELECT * FROM ops.webhook_endpoints WHERE deleted_at IS NULL ORDER BY created_at, id');
    return rows.map((r) => ({
      id: String(r.id),
      url: String(r.url),
      events: r.events as string[],
      enabled: Boolean(r.enabled),
      createdAt: String(r.created_at),
      createdBy: r.created_by as Actor,
      fromOffset: num(r.from_offset),
      deletedAt: (r.deleted_at as string | null) ?? null,
    }));
  }

  /** Record a simulated delivery. Idempotent on (endpoint, event). */
  async recordDelivery(d: WebhookDelivery): Promise<boolean> {
    const rows = await this.driver.query(
      'INSERT INTO ops.webhook_deliveries (id, endpoint_id, event_id, event_type, at, status, response_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING seq',
      [d.id, d.endpointId, d.eventId, d.eventType, d.at, d.status, d.responseMs],
    );
    return rows.length > 0;
  }

  async deliveries(filter: { endpointId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
    const rows = await this.driver.query(
      `SELECT * FROM ops.webhook_deliveries WHERE ($1::text IS NULL OR endpoint_id = $1) ORDER BY seq DESC LIMIT ${Math.min(Math.max(filter.limit ?? 100, 1), 1000)}`,
      [filter.endpointId ?? null],
    );
    return rows.map((r) => ({
      id: String(r.id),
      endpointId: String(r.endpoint_id),
      eventId: String(r.event_id),
      eventType: String(r.event_type),
      at: String(r.at),
      status: r.status as WebhookDelivery['status'],
      responseMs: num(r.response_ms),
    }));
  }
}
