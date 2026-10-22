// Same-origin HTTP helpers (served by the gateway, or proxied by the vite dev server).
import type { PaymentDetail, PaymentSummary, ServerMessage, Stats } from './types';

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

/** Parse one WS frame (a message or an array of messages). Invalid frames yield []. */
export function parseFrame(data: string): ServerMessage[] {
  try {
    const parsed = JSON.parse(data) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (m): m is ServerMessage =>
        typeof m === 'object' && m !== null && ((m as { kind?: unknown }).kind === 'snapshot' || (m as { kind?: unknown }).kind === 'event'),
    );
  } catch {
    return [];
  }
}

/** Exponential backoff with jitter, capped. attempt starts at 0. */
export function backoffMs(attempt: number, base = 500, cap = 10_000, random = Math.random): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}
