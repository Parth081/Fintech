// Same-origin HTTP helpers (served by the gateway, or proxied by the vite dev server).
import type { AccountBalance, JournalView, OrchestratorState, PacePreset, TrialBalance } from '@ct/contracts/browser';
import type {
  FxCorridorRates,
  GatewayControlView,
  Health,
  IsoMessage,
  PaymentDetail,
  PaymentSummary,
  ProviderView,
  ServerMessage,
  StatementRef,
  Stats,
  Throughput,
} from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; detail?: unknown };
    const msg = body.error ?? body.message;
    if (typeof msg === 'string') return typeof body.detail === 'string' ? `${msg}: ${body.detail}` : msg;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json()) as T;
}

export const fetchPayments = (limit = 50, signal?: AbortSignal) =>
  getJson<PaymentSummary[]>(`/api/payments?limit=${limit}`, signal);

export interface PaymentQuery {
  status?: string;
  corridor?: string;
  provider?: string;
  offset?: number;
  limit?: number;
}

/** Query string for GET /api/payments (empty values left out). */
export function paymentQueryString(q: PaymentQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(q.limit ?? 50));
  if (q.offset) params.set('offset', String(q.offset));
  if (q.status) params.set('status', q.status);
  if (q.corridor) params.set('corridor', q.corridor);
  if (q.provider) params.set('provider', q.provider);
  return params.toString();
}

/** Filtered page; total comes from the X-Total-Count header. */
export async function fetchPaymentsPage(q: PaymentQuery, signal?: AbortSignal): Promise<{ items: PaymentSummary[]; total: number }> {
  const res = await fetch(`/api/payments?${paymentQueryString(q)}`, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  const items = (await res.json()) as PaymentSummary[];
  const total = Number(res.headers.get('x-total-count') ?? items.length);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

export const fetchMessages = (id: string, signal?: AbortSignal) =>
  getJson<IsoMessage[]>(`/api/payments/${encodeURIComponent(id)}/messages`, signal);
export const fetchThroughput = (signal?: AbortSignal) => getJson<Throughput>('/api/throughput', signal);
export const fetchFxRates = (signal?: AbortSignal) => getJson<FxCorridorRates[]>('/api/fx/rates', signal);
export const fetchProviders = (signal?: AbortSignal) => getJson<ProviderView[]>('/api/providers', signal);
export const fetchStatements = (signal?: AbortSignal) => getJson<StatementRef[]>('/api/statements', signal);
export const fetchTrialBalance = (signal?: AbortSignal) => getJson<TrialBalance>('/api/ledger/trial-balance', signal);
export const fetchAccounts = (signal?: AbortSignal) => getJson<AccountBalance[]>('/api/ledger/accounts', signal);
export const fetchAccount = (accountId: string, signal?: AbortSignal) =>
  getJson<AccountBalance>(`/api/ledger/accounts/${encodeURIComponent(accountId)}`, signal);
export const fetchJournals = (paymentId: string, signal?: AbortSignal) =>
  getJson<JournalView[]>(`/api/ledger/journals?paymentId=${encodeURIComponent(paymentId)}`, signal);

/** camt.053 XML for one provider statement. */
export async function fetchStatementXml(providerId: string, date: string, currency?: string, signal?: AbortSignal): Promise<string> {
  const q = currency ? `?currency=${encodeURIComponent(currency)}` : '';
  const res = await fetch(`/api/statements/${encodeURIComponent(providerId)}/${encodeURIComponent(date)}${q}`, { signal });
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return res.text();
}
export const fetchStats = (signal?: AbortSignal) => getJson<Stats>('/api/stats', signal);
export const fetchDetail = (id: string, signal?: AbortSignal) =>
  getJson<PaymentDetail>(`/api/payments/${encodeURIComponent(id)}`, signal);

/** POST /api/payments/sample. Resolves with the new paymentId. */
export async function sendSample(body: Record<string, unknown> = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/payments/sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Gateway unreachable', 0);
  }
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  const data = (await res.json().catch(() => ({}))) as { paymentId?: unknown };
  return typeof data.paymentId === 'string' ? data.paymentId : '';
}

function isMessage(m: unknown): boolean {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  const hasStats = typeof o.stats === 'object' && o.stats !== null;
  if (o.kind === 'snapshot') return Array.isArray(o.payments) && hasStats;
  if (o.kind === 'update') return Array.isArray(o.payments) && typeof o.counts === 'object' && o.counts !== null && hasStats;
  if (o.kind === 'stats') return hasStats;
  if (o.kind === 'control') return typeof o.view === 'object' && o.view !== null && typeof (o.view as Record<string, unknown>).control === 'object';
  if (o.kind === 'reset') return typeof o.startedAt === 'string';
  if (o.kind === 'focus') return o.paymentId === null || typeof o.paymentId === 'string';
  return false;
}

/** Parse one WS frame (a message or an array of messages). Invalid frames yield []. */
export function parseFrame(data: string): ServerMessage[] {
  try {
    const parsed = JSON.parse(data) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (m): m is ServerMessage =>
        isMessage(m),
    );
  } catch {
    return [];
  }
}

// ---- M3 control plane ---------------------------------------------------------------------

export const fetchHealth = (signal?: AbortSignal) => getJson<Health>('/health', signal);
export const fetchControl = (fresh = false, signal?: AbortSignal) =>
  getJson<GatewayControlView>(`/api/control/state${fresh ? '?fresh=1' : ''}`, signal);

async function postJson<T>(path: string, body: unknown, timeoutMs = 8000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(err instanceof Error && err.name === 'TimeoutError' ? 'Request timed out' : 'Gateway unreachable', 0);
  }
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return (await res.json().catch(() => ({}))) as T;
}

const orch = (path: string) => `/api/control/orchestrator${path}`;
export const startScenario = (id: string) => postJson<{ runId: string }>(orch(`/scenarios/${encodeURIComponent(id)}/start`), {});
export const stopScenario = () => postJson<{ stopped: boolean }>(orch('/scenarios/stop'), {});
export const setAmbient = (rate: number) => postJson<OrchestratorState>(orch('/ambient'), { rate });
export const setPace = (preset: PacePreset) => postJson<OrchestratorState>(orch('/pace'), { preset });
export const setPaused = (paused: boolean) => postJson<OrchestratorState>(orch('/pause'), { paused });
/** Long timeout: the launcher stops, wipes and restarts everything (and usually kills this request). */
export const requestReset = () => postJson<{ ok: boolean; durationMs?: number }>('/api/control/reset', {}, 25_000);
/** Ask every screen to open (or close) a payment's drawer. */
export const focusPayment = (paymentId: string | null) => postJson<{ ok: boolean; screens: number }>('/api/control/focus', { paymentId });

/** Exponential backoff with jitter, capped. attempt starts at 0. */
export function backoffMs(attempt: number, base = 500, cap = 10_000, random = Math.random): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}
