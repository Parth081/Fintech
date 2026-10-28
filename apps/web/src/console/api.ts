// Console API layer: typed fetch helpers with the session token.
//  - Authorization: Bearer <token> from sessionStorage on every request.
//  - Errors are ConsoleApiError: 401 -> the session is cleared and the shell returns to sign-in;
//    403 -> "You don't have permission: <perm>".
//  - Paged lists read X-Total-Count (apiPage / opsPage).
// Other console modules (risk, treasury, config) use these helpers; don't call fetch directly.
import type {
  ApiKeyView,
  AuditEntry,
  CaseView,
  AlertView,
  ChangeRequest,
  DemoUser,
  OpsOverview,
  Permission,
  ReconBreak,
  Role,
  Session,
  WebhookDelivery,
  WebhookEndpoint,
  JournalView,
} from '@ct/contracts/browser';
import type { IsoMessage, PaymentDetail, PaymentSummary, ProviderView, Stats } from '../lib/types';
import type { PaymentTrend } from '../../../../services/gateway/src/api-types';
import { buildQuery, ConsoleApiError, errorFromResponse, parseTotal } from './lib/http';

export { ConsoleApiError, buildQuery } from './lib/http';
export type { ApiErrorKind } from './lib/http';

// ---------------------------------------------------------------------------------------------- token

const TOKEN_KEY = 'ct.console.session';
/** Fired on window when any request comes back 401 (the SessionProvider signs out). */
export const UNAUTHORIZED_EVENT = 'ct:console-unauthorized';

export function loadStoredSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s?.token === 'string' && s.user && Array.isArray(s.permissions) ? s : null;
  } catch {
    return null;
  }
}

export function storeSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session lives in memory only */
  }
}

export function getToken(): string | null {
  return loadStoredSession()?.token ?? null;
}

// ---------------------------------------------------------------------------------------------- core

export type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Permission named in the 403 message when the server does not say. */
  permission?: Permission;
  /** Don't broadcast 401 (used by the sign-in page). */
  quiet401?: boolean;
  accept?: string;
  timeoutMs?: number;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Low-level fetch: adds the bearer token, maps errors. Returns the Response on 2xx. */
export async function apiFetch(path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: opts.accept ?? 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)].filter((s): s is AbortSignal => !!s);
  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    throw new ConsoleApiError(timeout ? 'The request timed out' : 'The gateway is unreachable', 0, 'network');
  }
  if (res.ok) return res;
  const error = errorFromResponse(res.status, await readBody(res), opts.permission);
  if (error.kind === 'unauthorized' && !opts.quiet401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  throw error;
}

export async function apiGet<T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  const res = await apiFetch(path, opts);
  return (await readBody(res)) as T;
}

export async function apiPost<T>(path: string, body: unknown = {}, opts: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  const res = await apiFetch(path, { ...opts, method: 'POST', body });
  return (await readBody(res)) as T;
}

export async function apiText(path: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<string> {
  const res = await apiFetch(path, { accept: 'text/csv, text/plain, */*', ...opts });
  return res.text();
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** GET a list with limit/offset; total from X-Total-Count. */
export async function apiPage<T>(path: string, query: Query = {}, opts: Omit<RequestOptions, 'method' | 'body' | 'query'> = {}): Promise<Page<T>> {
  const res = await apiFetch(path, { ...opts, query });
  const data = await readBody(res);
  const items = Array.isArray(data) ? (data as T[]) : [];
  return { items, total: parseTotal(res.headers.get('x-total-count'), items.length) };
}

// ---------------------------------------------------------------------------------------------- ops service

/** Path on the ops service through the gateway: ops('/cases') -> '/api/ops/cases'. */
export const ops = (path: string) => `/api/ops${path.startsWith('/') ? path : `/${path}`}`;
export const opsGet = <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiGet<T>(ops(path), opts);
export const opsPost = <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiPost<T>(ops(path), body ?? {}, opts);
export const opsPage = <T>(path: string, query?: Query, opts?: Omit<RequestOptions, 'method' | 'body' | 'query'>) => apiPage<T>(ops(path), query, opts);
const enc = encodeURIComponent;

export type UserWithPermissions = DemoUser & { permissions?: Permission[] };
export interface RefundRequest {
  id: string;
  paymentId: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | (string & {});
  reason: string;
  requestedBy?: { userId: string; name: string; role: string };
  requestedAt?: string;
  reviewedBy?: { userId: string; name: string; role: string };
  reviewedAt?: string;
  reviewComment?: string;
  eventId?: string;
  amount?: { amountMinor: number; currency: string };
}
export interface CreatedApiKey extends ApiKeyView {
  secret: string;
}

export const opsApi = {
  // auth
  demoUsers: (signal?: AbortSignal) => opsGet<DemoUser[]>('/auth/users', { signal, quiet401: true }),
  login: (userId: string) => opsPost<Session>('/auth/login', { userId }, { quiet401: true }),
  logout: () => opsPost<{ ok: boolean }>('/auth/logout', {}, { quiet401: true }),
  me: (signal?: AbortSignal) => opsGet<Session>('/me', { signal }),
  overview: (signal?: AbortSignal) => opsGet<OpsOverview>('/overview', { signal }),
  // risk
  alerts: (query: Query, signal?: AbortSignal) => opsPage<AlertView>('/alerts', query, { signal }),
  cases: (query: Query, signal?: AbortSignal) => opsPage<CaseView>('/cases', query, { signal }),
  caseById: (id: string, signal?: AbortSignal) => opsGet<CaseView & { alerts: AlertView[] }>(`/cases/${enc(id)}`, { signal }),
  // payments (operator actions)
  retry: (paymentId: string, reason: string) => opsPost<{ eventId: string }>(`/payments/${enc(paymentId)}/retry`, { reason }, { permission: 'payments.retry' }),
  requestRefund: (paymentId: string, reason: string) =>
    opsPost<RefundRequest>(`/payments/${enc(paymentId)}/refunds`, { reason }, { permission: 'payments.refund.request' }),
  refunds: (query: Query, signal?: AbortSignal) => opsPage<RefundRequest>('/refunds', query, { signal }),
  approveRefund: (id: string, comment: string) => opsPost<RefundRequest>(`/refunds/${enc(id)}/approve`, { comment }, { permission: 'payments.refund.approve' }),
  rejectRefund: (id: string, comment: string) => opsPost<RefundRequest>(`/refunds/${enc(id)}/reject`, { comment }, { permission: 'payments.refund.approve' }),
  withdrawRefund: (id: string) => opsPost<RefundRequest>(`/refunds/${enc(id)}/withdraw`, {}, { permission: 'payments.refund.request' }),
  paymentAlerts: (paymentId: string, signal?: AbortSignal) => opsPage<AlertView>('/alerts', { paymentId, limit: 50 }, { signal }),
  activity: (paymentId: string, signal?: AbortSignal) => opsGet<AuditEntry[]>(`/payments/${enc(paymentId)}/activity`, { signal }),
  // config / recon
  changes: (query: Query, signal?: AbortSignal) => opsPage<ChangeRequest>('/changes', query, { signal }),
  breaks: (query: Query, signal?: AbortSignal) => opsPage<ReconBreak>('/recon/breaks', query, { signal }),
  // audit
  audit: (query: Query, signal?: AbortSignal) => opsPage<AuditEntry>('/audit', query, { signal, permission: 'audit.read' }),
  auditCsv: (query: Query) => apiText(ops('/audit/export.csv'), { query, permission: 'audit.read' }),
  users: (signal?: AbortSignal) => opsGet<UserWithPermissions[]>('/users', { signal, permission: 'users.read' }),
  // developer
  apiKeys: (signal?: AbortSignal) => opsGet<ApiKeyView[]>('/developer/keys', { signal, permission: 'developer.manage' }),
  createApiKey: (name: string, scopes: string[]) => opsPost<CreatedApiKey>('/developer/keys', { name, scopes }, { permission: 'developer.manage' }),
  revokeApiKey: (id: string) => opsPost<ApiKeyView>(`/developer/keys/${enc(id)}/revoke`, {}, { permission: 'developer.manage' }),
  webhooks: (signal?: AbortSignal) => opsGet<WebhookEndpoint[]>('/developer/webhooks', { signal, permission: 'developer.manage' }),
  createWebhook: (url: string, events: string[]) => opsPost<WebhookEndpoint>('/developer/webhooks', { url, events }, { permission: 'developer.manage' }),
  deliveries: (signal?: AbortSignal) => opsGet<WebhookDelivery[]>('/developer/webhooks/deliveries', { signal, permission: 'developer.manage' }),
  testWebhook: (id: string) => opsPost<WebhookDelivery>(`/developer/webhooks/${enc(id)}/test`, {}, { permission: 'developer.manage' }),
  setWebhookEnabled: (id: string, enabled: boolean) =>
    opsPost<WebhookEndpoint>(`/developer/webhooks/${enc(id)}/${enabled ? 'enable' : 'disable'}`, {}, { permission: 'developer.manage' }),
  deleteWebhook: (id: string) => apiFetch(ops(`/developer/webhooks/${enc(id)}`), { method: 'DELETE', permission: 'developer.manage' }).then(() => undefined),
};

// ---------------------------------------------------------------------------------------------- gateway (read side)

export interface PaymentListQuery {
  status?: string[];
  corridor?: string;
  provider?: string;
  currency?: string;
  q?: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}


export const gatewayApi = {
  payments: (q: PaymentListQuery, signal?: AbortSignal) =>
    apiPage<PaymentSummary>('/api/payments', { ...q, status: q.status, limit: q.limit ?? 25, offset: q.offset ?? 0 }, { signal }),
  payment: (id: string, signal?: AbortSignal) => apiGet<PaymentDetail>(`/api/payments/${enc(id)}`, { signal }),
  messages: (id: string, signal?: AbortSignal) => apiGet<IsoMessage[]>(`/api/payments/${enc(id)}/messages`, { signal }),
  journals: (paymentId: string, signal?: AbortSignal) => apiGet<JournalView[]>('/api/ledger/journals', { query: { paymentId }, signal }),
  stats: (signal?: AbortSignal) => apiGet<Stats>('/api/stats', { signal }),
  trend: (minutes: number, signal?: AbortSignal) => apiGet<PaymentTrend>('/api/payments/trend', { query: { minutes }, signal }),
  providers: (signal?: AbortSignal) => apiGet<ProviderView[]>('/api/providers', { signal }),
};

export type { Role, PaymentTrend };
