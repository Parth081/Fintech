import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  makeControlEvent,
  newId,
  type AnyEvent,
  type BusEvent,
  type CaseView,
  type ChangeRequest,
  type EventType,
  type PayloadMap,
  type Permission,
  type Role,
  type Session,
  type StageName,
} from '@ct/contracts';
import { happyPath, makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { InMemoryBus } from '@ct/event-bus';
import { startOps, type OpsHandle } from './service';
import { OpsStore } from './store';
import { DEMO_USERS } from './users';
import { csvCell, toCsv } from './csv';

// ------------------------------------------------------------------------------------------ helpers

let clock = Date.parse('2026-03-01T09:00:00.000Z');
const at = () => new Date((clock += 1000)).toISOString();

function ev<T extends EventType>(type: T, paymentId: string, payload: PayloadMap[T], producer: StageName = 'payment-api'): AnyEvent {
  return makeEvent(type, paymentId, payload, { producer, occurredAt: at() }) as AnyEvent;
}

type Sev = 'low' | 'medium' | 'high' | 'critical';

function alert(paymentId: string, severity: Sev, kind: 'sanctions' | 'fraud' | 'aml' = 'fraud') {
  const alertId = `ALR-${newId().slice(0, 8)}`;
  return {
    alertId,
    event: ev('risk.alert_raised', paymentId, { alertId, kind, severity, rule: `${kind.toUpperCase()}_RULE`, score: 0.8, summary: `${kind} alert ${severity}`, reasons: [{ code: 'R1', text: 'synthetic reason' }], evidence: { synthetic: true } }, 'risk'),
  };
}

/** initiated -> screened -> alerts -> scored(hold) -> held. */
function heldPayment(severities: Sev[], paymentId = newId()) {
  const alerts = severities.map((s) => alert(paymentId, s));
  const events: AnyEvent[] = [
    ev('payment.initiated', paymentId, sampleInitiatedPayload()),
    ev('payment.screened', paymentId, { result: 'clear', listVersion: 'fict-1' }, 'screening'),
    ...alerts.map((a) => a.event),
    ev('payment.scored', paymentId, { fraudScore: 0.81, amlAlerts: [], decision: 'hold' }, 'risk'),
    ev('payment.held', paymentId, { reason: 'risk review', atStage: 'risk', alertIds: alerts.map((a) => a.alertId) }, 'risk'),
  ];
  return { paymentId, alertIds: alerts.map((a) => a.alertId), events };
}

function failedPayment(paymentId = newId()): AnyEvent[] {
  const init = sampleInitiatedPayload();
  return [
    ev('payment.initiated', paymentId, init),
    ev('payment.screened', paymentId, { result: 'clear', listVersion: 'fict-1' }, 'screening'),
    ev('payment.scored', paymentId, { fraudScore: 0.1, amlAlerts: [], decision: 'approve' }, 'risk'),
    ev('payment.quoted', paymentId, { quoteId: 'q', rate: '83.25', spreadBps: 0, sourceAmount: init.amount, targetAmount: { amountMinor: 1, currency: 'INR' }, expiresAt: at() }, 'fx'),
    ev('payment.routed', paymentId, { providerId: 'orion', rail: 'A', estimatedFee: { amountMinor: 1, currency: 'USD' }, alternatives: [] }, 'routing'),
    ev('payment.sent', paymentId, { providerId: 'orion', messageType: 'pacs.008', messageId: 'm' }, 'settlement'),
    ev('payment.send_failed', paymentId, { providerId: 'orion', attempt: 1, reasonCode: 'AC04', reason: 'closed account', statusMessage: 'pacs.002' }, 'settlement'),
    ev('payment.failed', paymentId, { reason: 'all providers failed', atStage: 'routing', attempts: 1 }, 'routing'),
  ];
}

function reconciled(paymentId = newId(), matched = true): AnyEvent[] {
  const events = happyPath(paymentId);
  const last = events[events.length - 1]!;
  if (!matched) (last as AnyEvent & { payload: PayloadMap['payment.reconciled'] }).payload = { statementRef: 'camt.053-x', matched: false, breaks: ['AMOUNT_MISMATCH: reported 10 vs expected 11'] };
  return events;
}

interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

class Harness {
  ops!: OpsHandle;
  base = '';
  tokens = new Map<string, string>();
  constructor(
    readonly bus: InMemoryBus,
    readonly store: OpsStore,
  ) {}

  async start(): Promise<this> {
    this.ops = await startOps({ bus: this.bus, store: this.store, port: 0 });
    this.base = `http://127.0.0.1:${this.ops.port}`;
    this.tokens.clear();
    return this;
  }

  async publish(...events: BusEvent[]): Promise<void> {
    for (const e of events) await this.bus.publish(e);
    await this.ops.sync();
  }

  async req<T = any>(method: string, path: string, opts: { as?: string; token?: string; body?: unknown } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    const token = opts.token ?? (opts.as ? await this.token(opts.as) : undefined);
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(this.base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* csv */
    }
    return { status: r.status, body: body as T, headers: r.headers, text };
  }

  async token(userId: string): Promise<string> {
    const t = this.tokens.get(userId);
    if (t) return t;
    const r = await this.req<Session>('POST', '/auth/login', { body: { userId } });
    expect(r.status).toBe(200);
    this.tokens.set(userId, r.body.token);
    return r.body.token;
  }

  eventsOfType<T extends EventType>(type: T) {
    return this.bus.events.filter((e) => e.type === type) as Extract<AnyEvent, { type: T }>[];
  }

  async auditCount(): Promise<number> {
    return (await this.store.auditQuery({ limit: 0 })).total;
  }
}

async function harness(): Promise<Harness> {
  return new Harness(new InMemoryBus(), await OpsStore.open()).start();
}

const userOf = (role: Role) => DEMO_USERS.find((u) => u.role === role)!.id;

// ------------------------------------------------------------------------------------------ tests

describe('ops service', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.ops.close();
    await h.store.close();
  });

  describe('auth & RBAC', () => {
    it('lists fictional demo users across every role, with second analyst and manager for four-eyes', async () => {
      const r = await h.req('GET', '/auth/users');
      expect(r.status).toBe(200);
      expect(r.body.length).toBeGreaterThanOrEqual(8);
      const roles = new Set(r.body.map((u: { role: Role }) => u.role));
      for (const role of Object.keys(ROLE_PERMISSIONS)) expect(roles.has(role)).toBe(true);
      expect(r.body.filter((u: { role: Role }) => u.role === 'compliance_analyst').length).toBeGreaterThanOrEqual(2);
      expect(r.body.filter((u: { role: Role }) => u.role === 'compliance_manager').length).toBeGreaterThanOrEqual(2);
    });

    it('login returns a session with role permissions; token stored hashed; logout revokes; both audited', async () => {
      const bad = await h.req('POST', '/auth/login', { body: { userId: 'u-nobody' } });
      expect(bad.status).toBe(400);
      const login = await h.req<Session>('POST', '/auth/login', { body: { userId: 'u-hiro' } });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe('auditor');
      expect(login.body.permissions).toEqual([...ROLE_PERMISSIONS.auditor]);
      const ttl = Date.parse(login.body.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(7.9 * 3600_000);
      expect(ttl).toBeLessThanOrEqual(8 * 3600_000);
      const raw = await h.store.driver.query('SELECT token_hash FROM ops.sessions');
      expect(raw.some((x) => x.token_hash === login.body.token)).toBe(false);
      expect(raw.every((x) => /^[0-9a-f]{64}$/.test(String(x.token_hash)))).toBe(true);

      const me = await h.req<Session>('GET', '/me', { token: login.body.token });
      expect(me.status).toBe(200);
      expect(me.body.user.id).toBe('u-hiro');
      expect(me.body.token).toBe(login.body.token);

      expect((await h.req('GET', '/me')).status).toBe(401);
      expect((await h.req('GET', '/me', { token: 'garbage' })).status).toBe(401);
      expect((await h.req('POST', '/auth/logout', { token: login.body.token })).status).toBe(200);
      expect((await h.req('GET', '/me', { token: login.body.token })).status).toBe(401);

      const audit = await h.store.auditQuery({ actor: 'u-hiro' });
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.login', 'auth.logout']));
    });

    // One probe per permission: a route guarded by exactly that permission (bodies are minimal; a role
    // that has the permission gets past the guard and fails later with 400/404/409, never 403).
    const probes: Record<Permission, [string, string, unknown?]> = {
      'payments.read': ['GET', '/overview'],
      'payments.retry': ['POST', '/payments/nope/retry', { reason: 'probe' }],
      'payments.refund.request': ['POST', '/payments/nope/refunds', { reason: 'probe' }],
      'payments.refund.approve': ['POST', '/refunds/RF-999999/approve', {}],
      'alerts.read': ['GET', '/alerts'],
      'cases.work': ['POST', '/cases/CASE-0000-000000/notes', { text: 'probe' }],
      'cases.decide': ['POST', '/cases/CASE-0000-000000/decide', { decision: 'release', reason: 'probe' }],
      'cases.approve': ['POST', '/cases/CASE-0000-000000/approve', {}],
      'recon.read': ['GET', '/recon/breaks'],
      'recon.resolve': ['POST', '/recon/breaks/BRK-999999/resolve', { code: 'WRITE_OFF', note: 'probe' }],
      'config.read': ['GET', '/config'],
      'config.request': ['POST', '/changes', { key: 'nope' }],
      'config.approve': ['POST', '/changes/CR-999999/approve', {}],
      'audit.read': ['GET', '/audit'],
      'users.read': ['GET', '/users'],
      'developer.manage': ['GET', '/developer/keys'],
    };

    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      it(`enforces permission boundaries for ${role}`, async () => {
        const user = userOf(role);
        for (const [perm, [method, path, body]] of Object.entries(probes) as [Permission, [string, string, unknown?]][]) {
          const r = await h.req(method, path, { as: user, body });
          if (ROLE_PERMISSIONS[role].includes(perm)) {
            expect(r.status, `${role} ${perm} ${method} ${path}`).not.toBe(403);
            expect(r.status).not.toBe(401);
          } else {
            expect(r.status, `${role} ${perm}`).toBe(403);
            expect(r.body.missingPermission).toBe(perm);
            expect(r.body.error).toContain(perm);
          }
        }
      });
    }
  });

  describe('alerts -> cases', () => {
    it('rolls alerts on one payment into one case; priority = max severity; SLA by priority', async () => {
      const p = heldPayment(['medium', 'high']);
      await h.publish(...p.events);
      const alerts = await h.req('GET', `/alerts?q=${p.paymentId}`, { as: 'u-daniel' });
      expect(alerts.status).toBe(200);
      expect(alerts.headers.get('x-total-count')).toBe('2');
      const caseId = alerts.body[0].caseId as string;
      expect(caseId).toMatch(/^CASE-2026-\d{6}$/);
      expect(alerts.body[1].caseId).toBe(caseId);
      expect(alerts.body[0].payment.status).toBe('held');
      const c = await h.req<CaseView & { alerts: unknown[] }>('GET', `/cases/${caseId}`, { as: 'u-daniel' });
      expect(c.body.priority).toBe('high');
      expect(c.body.alertIds.sort()).toEqual([...p.alertIds].sort());
      expect(c.body.alerts).toHaveLength(2);
      expect(Date.parse(c.body.slaDueAt) - Date.parse(c.body.openedAt)).toBe(60 * 60_000);
      expect(c.body.status).toBe('open');
    });

    it('low/medium decision takes effect: publishes payment.released with actor and case; idempotent; 409 afterwards', async () => {
      const p = heldPayment(['medium']);
      await h.publish(...p.events);
      const list = await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-daniel' });
      expect(list.headers.get('x-total-count')).toBe('1');
      const caseId = list.body[0]!.caseId;
      expect(list.body[0]!.slaDueAt).toBe(new Date(Date.parse(list.body[0]!.openedAt) + 4 * 3600_000).toISOString());

      const assign = await h.req<CaseView>('POST', `/cases/${caseId}/assign`, { as: 'u-daniel', body: { userId: 'me' } });
      expect(assign.body.status).toBe('in_review');
      expect(assign.body.assignee?.userId).toBe('u-daniel');
      const mine = await h.req<CaseView[]>('GET', '/cases?assignee=me', { as: 'u-daniel' });
      expect(mine.body.map((c) => c.caseId)).toContain(caseId);
      const note = await h.req<CaseView>('POST', `/cases/${caseId}/notes`, { as: 'u-daniel', body: { text: 'Customer KYC refreshed; benign.' } });
      expect(note.body.notes).toHaveLength(1);

      const d1 = await h.req<CaseView>('POST', `/cases/${caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'false positive' } });
      expect(d1.status).toBe(200);
      expect(d1.body.status).toBe('closed');
      expect(d1.body.decision?.decision).toBe('release');
      const released = h.eventsOfType('payment.released').filter((e) => e.paymentId === p.paymentId);
      expect(released).toHaveLength(1);
      expect(released[0]!.producer).toBe('ops');
      expect(released[0]!.payload).toMatchObject({ caseId, actor: { userId: 'u-daniel', role: 'compliance_analyst' }, reason: 'false positive' });
      expect(released[0]!.payload.approvedBy).toBeUndefined();

      const d2 = await h.req<CaseView>('POST', `/cases/${caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'false positive' } });
      expect(d2.status).toBe(200);
      expect(h.eventsOfType('payment.released').filter((e) => e.paymentId === p.paymentId)).toHaveLength(1);
      const d3 = await h.req('POST', `/cases/${caseId}/decide`, { as: 'u-daniel', body: { decision: 'reject', reason: 'changed my mind' } });
      expect(d3.status).toBe(409);

      const activity = await h.req('GET', `/payments/${p.paymentId}/activity`, { as: 'u-maya' });
      const actions = activity.body.map((a: { action: string }) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['case.opened', 'case.assigned', 'case.note_added', 'payment.released', 'case.closed']));
      expect(activity.body.find((a: { action: string }) => a.action === 'payment.released').eventId).toBe(released[0]!.eventId);
    });

    it('high/critical: four-eyes — proposal, return, re-propose, approval by a different manager', async () => {
      const p = heldPayment(['high']);
      await h.publish(...p.events);
      const caseId = (await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-daniel' })).body[0]!.caseId;

      const prop = await h.req<CaseView>('POST', `/cases/${caseId}/decide`, { as: 'u-daniel', body: { decision: 'reject', reason: 'sanctions nexus' } });
      expect(prop.body.status).toBe('pending_approval');
      expect(prop.body.proposal).toMatchObject({ decision: 'reject', by: { userId: 'u-daniel' } });
      expect(prop.body.decision).toBeNull();
      expect(h.eventsOfType('payment.rejected').filter((e) => e.paymentId === p.paymentId)).toHaveLength(0);

      // analyst lacks cases.approve
      const self = await h.req('POST', `/cases/${caseId}/approve`, { as: 'u-daniel', body: {} });
      expect(self.status).toBe(403);
      expect(self.body.missingPermission).toBe('cases.approve');
      // a second decision while pending -> 409
      expect((await h.req('POST', `/cases/${caseId}/decide`, { as: 'u-amara', body: { decision: 'release', reason: 'other view' } })).status).toBe(409);

      const ret = await h.req<CaseView>('POST', `/cases/${caseId}/return`, { as: 'u-priya', body: { comment: 'Need more evidence' } });
      expect(ret.body.status).toBe('in_review');
      expect(ret.body.proposal).toBeNull();

      const prop2 = await h.req<CaseView>('POST', `/cases/${caseId}/decide`, { as: 'u-amara', body: { decision: 'release', reason: 'name mismatch resolved' } });
      expect(prop2.body.status).toBe('pending_approval');
      const ok = await h.req<CaseView>('POST', `/cases/${caseId}/approve`, { as: 'u-priya', body: { comment: 'agreed' } });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('closed');
      expect(ok.body.decision).toMatchObject({ decision: 'release', by: { userId: 'u-amara' }, approvedBy: { userId: 'u-priya' } });
      const ev1 = h.eventsOfType('payment.released').filter((e) => e.paymentId === p.paymentId);
      expect(ev1).toHaveLength(1);
      expect(ev1[0]!.payload).toMatchObject({ caseId, actor: { userId: 'u-amara' }, approvedBy: { userId: 'u-priya' } });
      // idempotent replay of the approval
      expect((await h.req('POST', `/cases/${caseId}/approve`, { as: 'u-priya', body: {} })).status).toBe(200);
      expect(h.eventsOfType('payment.released').filter((e) => e.paymentId === p.paymentId)).toHaveLength(1);
    });

    it('a manager cannot approve their own proposal; reject publishes payment.rejected atStage ops', async () => {
      const p = heldPayment(['critical']);
      await h.publish(...p.events);
      const c = (await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-tomas' })).body[0]!;
      expect(c.priority).toBe('critical');
      expect(Date.parse(c.slaDueAt) - Date.parse(c.openedAt)).toBe(15 * 60_000);
      await h.req('POST', `/cases/${c.caseId}/decide`, { as: 'u-tomas', body: { decision: 'reject', reason: 'confirmed fraud ring' } });
      const self = await h.req('POST', `/cases/${c.caseId}/approve`, { as: 'u-tomas', body: {} });
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('FOUR_EYES');
      const ok = await h.req<CaseView>('POST', `/cases/${c.caseId}/approve`, { as: 'u-priya', body: {} });
      expect(ok.body.status).toBe('closed');
      const rej = h.eventsOfType('payment.rejected').filter((e) => e.paymentId === p.paymentId);
      expect(rej).toHaveLength(1);
      expect(rej[0]!.payload).toMatchObject({ atStage: 'ops', caseId: c.caseId, actor: { userId: 'u-tomas' } });
      const audit = await h.store.auditQuery({ targetId: c.caseId });
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['case.opened', 'case.decision_proposed', 'case.approved', 'case.closed']));
    });

    it('409 when the payment is not held; such a case can be closed without action', async () => {
      const pid = newId();
      const a = alert(pid, 'low');
      await h.publish(ev('payment.initiated', pid, sampleInitiatedPayload()), a.event);
      const c = (await h.req<CaseView[]>('GET', `/cases?q=${pid}`, { as: 'u-daniel' })).body[0]!;
      const r = await h.req('POST', `/cases/${c.caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'looks fine' } });
      expect(r.status).toBe(409);
      expect(r.body.paymentStatus).toBe('initiated');
      expect(h.bus.events.some((e) => e.paymentId === pid && e.type === 'payment.released')).toBe(false);
      const closed = await h.req<CaseView>('POST', `/cases/${c.caseId}/close`, { as: 'u-daniel', body: { reason: 'informational only' } });
      expect(closed.body.status).toBe('closed');
    });

    it('validates input and paging', async () => {
      const c = (await h.req<CaseView[]>('GET', '/cases?limit=1&offset=0', { as: 'u-daniel' }));
      expect(c.body).toHaveLength(1);
      expect(Number(c.headers.get('x-total-count'))).toBeGreaterThan(1);
      const filtered = await h.req<CaseView[]>('GET', '/cases?status=closed&priority=critical', { as: 'u-daniel' });
      expect(filtered.body.every((x) => x.status === 'closed' && x.priority === 'critical')).toBe(true);
      const caseId = c.body[0]!.caseId;
      expect((await h.req('POST', `/cases/${caseId}/decide`, { as: 'u-daniel', body: { decision: 'maybe', reason: 'x' } })).status).toBe(400);
      expect((await h.req('POST', `/cases/${caseId}/assign`, { as: 'u-daniel', body: { userId: 'u-maya' } })).status).toBe(400);
      expect((await h.req('GET', '/cases/CASE-0000-000000', { as: 'u-daniel' })).status).toBe(404);
    });
  });

  describe('payment actions', () => {
    it('retry only for failed payments, publishes payment.retry_requested, idempotent', async () => {
      const failed = failedPayment();
      const ok = reconciled();
      await h.publish(...failed, ...ok);
      const pid = failed[0]!.paymentId;
      const r1 = await h.req('POST', `/payments/${pid}/retry`, { as: 'u-maya', body: { reason: 'provider back up' } });
      expect(r1.status).toBe(202);
      const evs = h.eventsOfType('payment.retry_requested').filter((e) => e.paymentId === pid);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.eventId).toBe(r1.body.eventId);
      expect(evs[0]!.payload.actor.userId).toBe('u-maya');
      const r2 = await h.req('POST', `/payments/${pid}/retry`, { as: 'u-maya', body: { reason: 'provider back up' } });
      expect(r2.status).toBe(202);
      expect(r2.body.eventId).toBe(r1.body.eventId);
      expect(h.eventsOfType('payment.retry_requested').filter((e) => e.paymentId === pid)).toHaveLength(1);
      const r3 = await h.req('POST', `/payments/${ok[0]!.paymentId}/retry`, { as: 'u-maya', body: { reason: 'nope' } });
      expect(r3.status).toBe(409);
      expect((await h.req('POST', `/payments/${newId()}/retry`, { as: 'u-maya', body: { reason: 'nope' } })).status).toBe(404);
    });

    it('refund maker-checker: request -> approve by a checker publishes payment.refund_requested', async () => {
      const ok = reconciled();
      await h.publish(...ok);
      const pid = ok[0]!.paymentId;
      const req = await h.req('POST', `/payments/${pid}/refunds`, { as: 'u-maya', body: { reason: 'customer dispute upheld' } });
      expect(req.status).toBe(201);
      expect(req.body.status).toBe('pending');
      expect(req.body.id).toMatch(/^RF-\d{6}$/);
      expect((await h.req('POST', `/payments/${pid}/refunds`, { as: 'u-maya', body: { reason: 'dup' } })).status).toBe(409);
      expect(h.eventsOfType('payment.refund_requested').filter((e) => e.paymentId === pid)).toHaveLength(0);
      // maker lacks the checker permission
      expect((await h.req('POST', `/refunds/${req.body.id}/approve`, { as: 'u-maya', body: {} })).status).toBe(403);
      const pending = await h.req('GET', '/refunds?status=pending', { as: 'u-priya' });
      expect(pending.body.map((r: { id: string }) => r.id)).toContain(req.body.id);
      const ap = await h.req('POST', `/refunds/${req.body.id}/approve`, { as: 'u-priya', body: { comment: 'ok' } });
      expect(ap.status).toBe(202);
      expect(ap.body.status).toBe('approved');
      const evs = h.eventsOfType('payment.refund_requested').filter((e) => e.paymentId === pid);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.eventId).toBe(ap.body.eventId);
      expect(evs[0]!.payload).toMatchObject({ actor: { userId: 'u-maya' }, approvedBy: { userId: 'u-priya' }, reason: 'customer dispute upheld' });
      // idempotent
      expect((await h.req('POST', `/refunds/${req.body.id}/approve`, { as: 'u-priya', body: {} })).status).toBe(202);
      expect(h.eventsOfType('payment.refund_requested').filter((e) => e.paymentId === pid)).toHaveLength(1);
      // payment now refund_requested: no new refund
      expect((await h.req('POST', `/payments/${pid}/refunds`, { as: 'u-maya', body: { reason: 'again' } })).status).toBe(409);

      // reject path
      const ok2 = reconciled();
      await h.publish(...ok2);
      const r2 = await h.req('POST', `/payments/${ok2[0]!.paymentId}/refunds`, { as: 'u-maya', body: { reason: 'duplicate charge' } });
      expect((await h.req('POST', `/refunds/${r2.body.id}/reject`, { as: 'u-tomas', body: {} })).status).toBe(400);
      const rj = await h.req('POST', `/refunds/${r2.body.id}/reject`, { as: 'u-tomas', body: { comment: 'not a duplicate' } });
      expect(rj.body.status).toBe('rejected');
      expect(h.eventsOfType('payment.refund_requested').filter((e) => e.paymentId === ok2[0]!.paymentId)).toHaveLength(0);

      const act = await h.req('GET', `/payments/${pid}/activity`, { as: 'u-hiro' });
      expect(act.body.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['refund.requested', 'refund.approved']));
    });
  });

  describe('config maker-checker', () => {
    it('validates, requires a different reviewer, publishes control.config.updated with version = current + 1', async () => {
      const cfg0 = await h.req('GET', '/config', { as: 'u-sofia' });
      expect(cfg0.body.values['risk.thresholds']).toEqual({ hold: 0.7, reject: 0.92 });
      const invalid = await h.req('POST', '/changes', { as: 'u-sofia', body: { key: 'risk.thresholds', proposedValue: { hold: 0.95, reject: 0.9 }, reason: 'tighten' } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.errors.join(' ')).toContain('hold must be lower than reject');
      expect((await h.req('POST', '/changes', { as: 'u-sofia', body: { key: 'provider.enabled', proposedValue: { orion: false, lyra: false, vega: false }, reason: 'all off' } })).status).toBe(400);

      const cr = await h.req<ChangeRequest>('POST', '/changes', { as: 'u-sofia', body: { key: 'risk.thresholds', proposedValue: { hold: 0.6, reject: 0.9 }, reason: 'fraud wave' } });
      expect(cr.status).toBe(201);
      expect(cr.body).toMatchObject({ status: 'pending', currentValue: { hold: 0.7, reject: 0.92 }, proposedValue: { hold: 0.6, reject: 0.9 } });
      expect(cr.body.id).toMatch(/^CR-\d{6}$/);
      expect((await h.req('POST', '/changes', { as: 'u-ken', body: { key: 'risk.thresholds', proposedValue: { hold: 0.5, reject: 0.9 }, reason: 'second change' } })).status).toBe(409);
      const self = await h.req('POST', `/changes/${cr.body.id}/approve`, { as: 'u-sofia', body: {} });
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('FOUR_EYES');
      expect(h.bus.events.some((e) => e.type === 'control.config.updated')).toBe(false);

      const ap = await h.req<ChangeRequest>('POST', `/changes/${cr.body.id}/approve`, { as: 'u-ken', body: { comment: 'approved for 24h' } });
      expect(ap.status).toBe(200);
      expect(ap.body).toMatchObject({ status: 'approved', appliedVersion: 1, reviewedBy: { userId: 'u-ken' } });
      const evs = h.bus.events.filter((e) => e.type === 'control.config.updated');
      expect(evs).toHaveLength(1);
      expect(evs[0]!.payload).toMatchObject({ key: 'risk.thresholds', value: { hold: 0.6, reject: 0.9 }, version: 1, changeRequestId: cr.body.id, actor: { userId: 'u-sofia' }, approvedBy: { userId: 'u-ken' } });
      const cfg1 = await h.req('GET', '/config', { as: 'u-maya' });
      expect(cfg1.body.values['risk.thresholds']).toEqual({ hold: 0.6, reject: 0.9 });
      expect(cfg1.body.versions['risk.thresholds']).toBe(1);
    });

    it('takes the current version from the log (updates published by others count)', async () => {
      await h.publish(makeControlEvent('control.config.updated', { key: 'routing.weights', value: { success: 0.4, cost: 0.4, speed: 0.2 }, version: 5, changeRequestId: 'CR-EXTERNAL', actor: { userId: 'u-x', name: 'X', role: 'admin' } }, { eventId: newId(), occurredAt: at(), producer: 'orchestrator' }));
      const cr = await h.req<ChangeRequest>('POST', '/changes', { as: 'u-ken', body: { key: 'routing.weights', proposedValue: { success: 0.7, cost: 0.2, speed: 0.1 }, reason: 'reliability first' } });
      expect(cr.body.currentValue).toEqual({ success: 0.4, cost: 0.4, speed: 0.2 });
      const ap = await h.req<ChangeRequest>('POST', `/changes/${cr.body.id}/approve`, { as: 'u-sofia', body: {} });
      expect(ap.body.appliedVersion).toBe(6);
    });

    it('reject needs a comment and a different reviewer; withdraw only by the requester', async () => {
      const cr = await h.req<ChangeRequest>('POST', '/changes', { as: 'u-sofia', body: { key: 'risk.manualReviewAboveUsd', proposedValue: 10000, reason: 'lower bar' } });
      expect((await h.req('POST', `/changes/${cr.body.id}/reject`, { as: 'u-ken', body: {} })).status).toBe(400);
      expect((await h.req('POST', `/changes/${cr.body.id}/withdraw`, { as: 'u-ken', body: {} })).status).toBe(403);
      const rj = await h.req<ChangeRequest>('POST', `/changes/${cr.body.id}/reject`, { as: 'u-ken', body: { comment: 'too low' } });
      expect(rj.body.status).toBe('rejected');
      const cr2 = await h.req<ChangeRequest>('POST', '/changes', { as: 'u-sofia', body: { key: 'risk.manualReviewAboveUsd', proposedValue: 15000, reason: 'lower bar' } });
      const wd = await h.req<ChangeRequest>('POST', `/changes/${cr2.body.id}/withdraw`, { as: 'u-sofia', body: {} });
      expect(wd.body.status).toBe('withdrawn');
      const list = await h.req<ChangeRequest[]>('GET', '/changes?status=rejected', { as: 'u-hiro' });
      expect(list.body.map((c) => c.id)).toContain(cr.body.id);
    });
  });

  describe('reconciliation breaks', () => {
    it('queues unmatched reconciliations; treasury assigns and resolves', async () => {
      const evs = reconciled(newId(), false);
      await h.publish(...evs, ...reconciled());
      const pid = evs[0]!.paymentId;
      const list = await h.req('GET', '/recon/breaks?status=open', { as: 'u-lucas' });
      const b = list.body.find((x: { paymentId: string }) => x.paymentId === pid);
      expect(b).toBeDefined();
      expect(b.breakId).toMatch(/^BRK-\d{6}$/);
      expect(b.breaks[0]).toContain('AMOUNT_MISMATCH');
      expect(b.providerId).toBe('orion');
      expect(list.body).toHaveLength(1);
      expect((await h.req('POST', `/recon/breaks/${b.breakId}/assign`, { as: 'u-maya', body: { userId: 'me' } })).status).toBe(403);
      const as = await h.req('POST', `/recon/breaks/${b.breakId}/assign`, { as: 'u-lucas', body: { userId: 'me' } });
      expect(as.body).toMatchObject({ status: 'investigating', assignee: { userId: 'u-lucas' } });
      expect((await h.req('POST', `/recon/breaks/${b.breakId}/resolve`, { as: 'u-lucas', body: { code: 'NOPE', note: 'x' } })).status).toBe(400);
      const rs = await h.req('POST', `/recon/breaks/${b.breakId}/resolve`, { as: 'u-lucas', body: { code: 'PROVIDER_ADJUSTMENT', note: 'provider credited the difference' } });
      expect(rs.body.status).toBe('resolved');
      expect(rs.body.resolution).toMatchObject({ code: 'PROVIDER_ADJUSTMENT', by: { userId: 'u-lucas' } });
      expect((await h.req('POST', `/recon/breaks/${b.breakId}/resolve`, { as: 'u-lucas', body: { code: 'WRITE_OFF', note: 'again' } })).status).toBe(409);
      const audit = await h.store.auditQuery({ targetType: 'break', targetId: b.breakId });
      expect(audit.rows.map((r) => r.action).sort()).toEqual(['recon.break_assigned', 'recon.break_detected', 'recon.break_resolved']);
    });
  });

  describe('audit trail', () => {
    it('every mutating call writes exactly one or more audit rows', async () => {
      const p = heldPayment(['low']);
      await h.publish(...p.events);
      const caseId = (await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-daniel' })).body[0]!.caseId;
      const calls: [string, string, string, unknown][] = [
        ['u-daniel', 'POST', `/cases/${caseId}/assign`, { userId: 'u-amara' }],
        ['u-amara', 'POST', `/cases/${caseId}/notes`, { text: 'checked' }],
        ['u-amara', 'POST', `/cases/${caseId}/decide`, { decision: 'release', reason: 'benign' }],
        ['u-sofia', 'POST', '/developer/keys', { name: 'audit probe', scopes: ['payments:read'] }],
        ['u-sofia', 'POST', '/developer/webhooks', { url: 'https://example.invalid/hook', events: ['payment.*'] }],
      ];
      for (const [as, method, path, body] of calls) {
        const before = await h.auditCount();
        const r = await h.req(method, path, { as, body });
        expect(r.status, path).toBeLessThan(300);
        expect(await h.auditCount(), path).toBeGreaterThan(before);
      }
      // reads do not write
      const before = await h.auditCount();
      await h.req('GET', '/cases', { as: 'u-daniel' });
      await h.req('GET', '/audit', { as: 'u-hiro' });
      expect(await h.auditCount()).toBe(before);
    });

    it('is append-only at the database level', async () => {
      await expect(h.store.driver.query(`UPDATE ops.audit_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);
      await expect(h.store.driver.query('DELETE FROM ops.audit_log')).rejects.toThrow(/append-only/);
      await expect(h.store.driver.query('TRUNCATE ops.audit_log')).rejects.toThrow(/append-only/);
      expect((await h.store.auditQuery({ action: 'tampered' })).total).toBe(0);
    });

    it('filters with X-Total-Count and exports CSV with escaping and formula-injection protection', async () => {
      const p = heldPayment(['low']);
      await h.publish(...p.events);
      const caseId = (await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-daniel' })).body[0]!.caseId;
      const nasty = '=HYPERLINK("http://evil","click"), then "quote"\nnewline';
      await h.req('POST', `/cases/${caseId}/notes`, { as: 'u-daniel', body: { text: nasty } });

      const f = await h.req('GET', '/audit?actor=u-daniel&action=case.*&limit=2', { as: 'u-hiro' });
      expect(f.status).toBe(200);
      expect(f.body).toHaveLength(2);
      expect(Number(f.headers.get('x-total-count'))).toBeGreaterThan(2);
      expect(f.body.every((r: { actor: { userId: string }; action: string }) => r.actor.userId === 'u-daniel' && r.action.startsWith('case.'))).toBe(true);
      const byTarget = await h.req('GET', `/audit?targetType=case&targetId=${caseId}`, { as: 'u-hiro' });
      expect(byTarget.body.map((r: { action: string }) => r.action)).toEqual(['case.note_added', 'case.opened']);

      const csv = await h.req('GET', `/audit/export.csv?targetId=${caseId}`, { as: 'u-hiro' });
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toContain('text/csv');
      expect(csv.text.split('\r\n')[0]).toBe('id,at,actor_id,actor_name,actor_role,action,target_type,target_id,payment_id,event_id,details');
      expect(csv.text).not.toMatch(/(^|,)=HYPERLINK/m);
      expect(csv.text).toContain('\\""quote\\""');
      expect((await h.store.auditQuery({ action: 'audit.exported' })).total).toBeGreaterThan(0);

      expect(csvCell('=1+2')).toBe("'=1+2");
      expect(csvCell('+cmd')).toBe("'+cmd");
      expect(csvCell('-2')).toBe("'-2");
      expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('=x,"y"')).toBe(`"'=x,""y"""`);
      expect(toCsv(['a'], [[null], [1]])).toBe('a\r\n\r\n1\r\n');
    });
  });

  describe('developer', () => {
    it('API keys: secret shown once, stored hashed with a prefix, revocable', async () => {
      const k = await h.req('POST', '/developer/keys', { as: 'u-ken', body: { name: 'Reporting job', scopes: ['payments:read', 'reports:read'] } });
      expect(k.status).toBe(201);
      expect(k.body.secret).toMatch(/^ctk_test_/);
      expect(k.body.secret.startsWith(k.body.prefix)).toBe(true);
      const list = await h.req('GET', '/developer/keys', { as: 'u-ken' });
      const row = list.body.find((x: { id: string }) => x.id === k.body.id);
      expect(row).toMatchObject({ name: 'Reporting job', prefix: k.body.prefix, revokedAt: null });
      expect(JSON.stringify(list.body)).not.toContain(k.body.secret);
      expect(JSON.stringify(list.body)).not.toContain('secretHash');
      const raw = await h.store.driver.query('SELECT secret_hash FROM ops.api_keys WHERE id = $1', [k.body.id]);
      expect(raw[0]!.secret_hash).not.toBe(k.body.secret);
      expect(raw[0]!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await h.req('POST', '/developer/keys', { as: 'u-ken', body: { name: 'x', scopes: ['root'] } })).status).toBe(400);
      const rv = await h.req('POST', `/developer/keys/${k.body.id}/revoke`, { as: 'u-ken', body: {} });
      expect(rv.body.revokedAt).not.toBeNull();
      expect(rv.body.secret).toBeUndefined();
    });

    it('webhooks: CRUD and simulated deliveries — never an outbound request', async () => {
      let hits = 0;
      const sink = createServer((_req, res) => {
        hits += 1;
        res.end('ok');
      });
      await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
      const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
      try {
        expect((await h.req('POST', '/developer/webhooks', { as: 'u-sofia', body: { url: 'ftp://x', events: ['payment.*'] } })).status).toBe(400);
        expect((await h.req('POST', '/developer/webhooks', { as: 'u-sofia', body: { url: sinkUrl, events: ['payment.bogus'] } })).status).toBe(400);
        const w = await h.req('POST', '/developer/webhooks', { as: 'u-sofia', body: { url: sinkUrl, events: ['payment.reconciled', 'payment.failed'] } });
        expect(w.status).toBe(201);
        expect(w.body.enabled).toBe(true);
        await h.publish(...reconciled(), ...failedPayment());
        const d = await h.req('GET', `/developer/webhooks/deliveries?endpointId=${w.body.id}`, { as: 'u-sofia' });
        expect(d.body.map((x: { eventType: string }) => x.eventType).sort()).toEqual(['payment.failed', 'payment.reconciled']);
        expect(d.body.every((x: { status: string }) => x.status === 'simulated')).toBe(true);

        const t = await h.req('POST', `/developer/webhooks/${w.body.id}/test`, { as: 'u-sofia', body: {} });
        expect(t.status).toBe(201);
        expect(t.body).toMatchObject({ eventType: 'webhook.test', status: 'simulated' });

        const up = await h.req('PUT', `/developer/webhooks/${w.body.id}`, { as: 'u-sofia', body: { events: ['*'], enabled: false } });
        expect(up.body).toMatchObject({ events: ['*'], enabled: false });
        await h.publish(...reconciled());
        const d2 = await h.req('GET', `/developer/webhooks/deliveries?endpointId=${w.body.id}`, { as: 'u-sofia' });
        expect(d2.body).toHaveLength(3); // disabled: nothing new
        const del = await h.req('DELETE', `/developer/webhooks/${w.body.id}`, { as: 'u-sofia' });
        expect(del.status).toBe(200);
        const list = await h.req('GET', '/developer/webhooks', { as: 'u-sofia' });
        expect(list.body.some((x: { id: string }) => x.id === w.body.id)).toBe(false);
        const audit = await h.store.auditQuery({ targetType: 'webhook', targetId: w.body.id });
        expect(audit.rows.map((r) => r.action).sort()).toEqual(['webhook.created', 'webhook.deleted', 'webhook.tested', 'webhook.updated']);
        expect(hits).toBe(0);
      } finally {
        await new Promise<void>((r) => sink.close(() => r()));
      }
    });
  });

  describe('overview', () => {
    it('summarises payments, alerts, cases, recon and pending changes', async () => {
      const o = await h.req('GET', '/overview', { as: 'u-daniel' });
      expect(o.status).toBe(200);
      expect(o.body.payments.today).toBeGreaterThanOrEqual(0);
      expect(o.body.payments.failed).toBeGreaterThan(0);
      expect(o.body.recon.matchRate).toBeGreaterThan(0);
      expect(o.body.recon.matchRate).toBeLessThan(1);
      expect(Object.keys(o.body.alerts.bySeverity).sort()).toEqual(['critical', 'high', 'low', 'medium']);
      expect(o.body.cases.open).toBeGreaterThan(0);
      expect(typeof o.body.changes.pending).toBe('number');
      const h2 = await h.req('GET', '/health');
      expect(h2.body).toMatchObject({ ok: true, service: 'ops', caughtUp: true });
    });
  });
});

describe('restart consistency', () => {
  it('rebuilds from the log, keeps workflow state from the DB, never duplicates system audit rows or events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-restart-'));
    const bus = new InMemoryBus();
    try {
      let store = await OpsStore.open({ dataDir: dir });
      const h = await new Harness(bus, store).start();
      const a = heldPayment(['medium']);
      const b = heldPayment(['high']);
      await h.publish(...a.events, ...b.events);
      const cases1 = (await h.req<CaseView[]>('GET', '/cases', { as: 'u-daniel' })).body;
      const ca = cases1.find((c) => c.paymentId === a.paymentId)!;
      const cb = cases1.find((c) => c.paymentId === b.paymentId)!;
      await h.req('POST', `/cases/${ca.caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'cleared after review' } });
      await h.req('POST', `/cases/${cb.caseId}/decide`, { as: 'u-daniel', body: { decision: 'reject', reason: 'confirmed bad actor' } });
      const auditBefore = await h.auditCount();
      const eventsBefore = bus.events.length;
      await h.ops.close();
      await store.close();

      store = await OpsStore.open({ dataDir: dir });
      const h2 = await new Harness(bus, store).start();
      expect(await h2.auditCount()).toBe(auditBefore + 0); // replay adds no system rows (logins below add some)
      const cases2 = (await h2.req<CaseView[]>('GET', '/cases', { as: 'u-daniel' })).body;
      expect(cases2.map((c) => [c.caseId, c.status]).sort()).toEqual([
        [ca.caseId, 'closed'],
        [cb.caseId, 'pending_approval'],
      ].sort());
      // decisions stay idempotent across the restart; the proposal survives and can be approved
      expect((await h2.req('POST', `/cases/${ca.caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'cleared after review' } })).status).toBe(200);
      const ap = await h2.req<CaseView>('POST', `/cases/${cb.caseId}/approve`, { as: 'u-priya', body: {} });
      expect(ap.body.status).toBe('closed');
      expect(bus.events.length).toBe(eventsBefore + 1);
      expect(bus.events.filter((e) => e.type === 'payment.released')).toHaveLength(1);
      // numbering continues
      const c = heldPayment(['low']);
      await h2.publish(...c.events);
      const cc = (await h2.req<CaseView[]>('GET', `/cases?q=${c.paymentId}`, { as: 'u-daniel' })).body[0]!;
      const seq = (id: string) => Number(id.slice(-6));
      expect(seq(cc.caseId)).toBe(Math.max(seq(ca.caseId), seq(cb.caseId)) + 1);
      await h2.ops.close();
      await store.close();
    } finally {
      await bus.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('repairs workflow state when an ops event reached the log but the DB write did not (crash window)', async () => {
    const bus = new InMemoryBus();
    const store = await OpsStore.open();
    const h = await new Harness(bus, store).start();
    const p = heldPayment(['low']);
    await h.publish(...p.events);
    const c = (await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-daniel' })).body[0]!;
    await h.ops.close();
    // Simulate: the release was published but the process died before closing the case.
    await bus.publish(makeEvent('payment.released', p.paymentId, { actor: { userId: 'u-daniel', name: 'Daniel Okafor', role: 'compliance_analyst' }, reason: 'cleared after review', caseId: c.caseId }, { producer: 'ops', occurredAt: at() }) as AnyEvent);
    await h.start();
    const after = (await h.req<CaseView>('GET', `/cases/${c.caseId}`, { as: 'u-daniel' })).body;
    expect(after.status).toBe('closed');
    expect(after.decision?.decision).toBe('release');
    expect((await store.auditQuery({ action: 'case.reconciled' })).total).toBe(1);
    await h.ops.close();
    await store.close();
    await bus.close();
  });

  it('reopens a closed case when the payment is held again later (and not on replay)', async () => {
    const bus = new InMemoryBus();
    const store = await OpsStore.open();
    const h = await new Harness(bus, store).start();
    const p = heldPayment(['low']);
    await h.publish(...p.events);
    const c = (await h.req<CaseView[]>('GET', `/cases?q=${p.paymentId}`, { as: 'u-daniel' })).body[0]!;
    const first = await h.req<CaseView>('POST', `/cases/${c.caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'cleared after review' } });
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ status: "closed" });
    // restart: replaying the first hold must not reopen
    await h.ops.close();
    await h.start();
    expect((await h.req<CaseView>('GET', `/cases/${c.caseId}`, { as: 'u-daniel' })).body.status).toBe('closed');
    // a new hold after the release reopens it, and a new decision gets a new event id
    const a2 = alert(p.paymentId, 'medium');
    await h.publish(a2.event, ev('payment.held', p.paymentId, { reason: 're-screen', atStage: 'risk', alertIds: [a2.alertId] }, 'risk'));
    const reopened = (await h.req<CaseView>('GET', `/cases/${c.caseId}`, { as: 'u-daniel' })).body;
    expect(reopened.status).toBe('open');
    expect(reopened.alertIds).toHaveLength(2);
    const second = await h.req<CaseView>('POST', `/cases/${c.caseId}/decide`, { as: 'u-daniel', body: { decision: 'release', reason: 'ok again' } });
    expect(second.body.status).toBe('closed');
    expect(bus.events.filter((e) => e.type === 'payment.released' && e.paymentId === p.paymentId)).toHaveLength(2);
    await h.ops.close();
    await store.close();
    await bus.close();
  });
});
