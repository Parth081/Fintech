// Same-origin calls the kiosk makes (all through the gateway). Nothing here touches browser storage.
import type { AnalyticsEvent, Answer, Lead, LeadInput, SuggestedQuestion } from '@ct/contracts/browser';
import type { PaymentDetail } from '../lib/types';
import type { KioskPaymentRequest } from './payment';

export class KioskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'KioskApiError';
  }
}

async function call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 8000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(rest.body ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new KioskApiError(err instanceof Error && err.name === 'TimeoutError' ? 'Request timed out' : 'Service unreachable', 0);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let details: string[] = [];
    try {
      const body = (await res.json()) as { error?: unknown; details?: unknown };
      if (typeof body.error === 'string') message = body.error;
      if (Array.isArray(body.details)) details = body.details.filter((d): d is string => typeof d === 'string');
    } catch {
      /* not JSON */
    }
    throw new KioskApiError(message, res.status, details);
  }
  return (await res.json()) as T;
}

const newKey = () => {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return `kiosk-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/** POST /api/payments with an Idempotency-Key so a double tap never sends twice. */
export async function createPayment(body: KioskPaymentRequest, idempotencyKey: string = newKey()): Promise<string> {
  const res = await call<{ paymentId?: unknown }>('/api/payments', { method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': idempotencyKey } });
  if (typeof res.paymentId !== 'string') throw new KioskApiError('No payment id returned', 502);
  return res.paymentId;
}

export const fetchPayment = (id: string, signal?: AbortSignal) => call<PaymentDetail>(`/api/payments/${encodeURIComponent(id)}`, { signal });

/** True when the service behind the gateway answers its health check. */
export async function serviceUp(prefix: '/api/assistant' | '/api/booth'): Promise<boolean> {
  try {
    const body = await call<{ ok?: unknown }>(`${prefix}/health`, { timeoutMs: 3000 });
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function fetchSuggestions(paymentId: string): Promise<SuggestedQuestion[]> {
  const list = await call<unknown>(`/api/assistant/suggestions?context=${encodeURIComponent(`payment:${paymentId}`)}`, { timeoutMs: 6000 });
  if (!Array.isArray(list)) return [];
  return list.filter(
    (q): q is SuggestedQuestion =>
      typeof q === 'object' && q !== null && typeof (q as SuggestedQuestion).text === 'string' && typeof (q as SuggestedQuestion).intent === 'string',
  );
}

export const askAssistant = (question: string, paymentId: string) =>
  call<Answer>('/api/assistant/ask', {
    method: 'POST',
    body: JSON.stringify({ question, context: { kind: 'payment', paymentId } }),
    timeoutMs: 25_000,
  });

export const submitLead = (lead: LeadInput) => call<Lead>('/api/booth/leads', { method: 'POST', body: JSON.stringify(lead) });

/** Analytics sender for the batcher: true when the booth accepted the batch. */
export async function sendAnalytics(events: AnalyticsEvent[]): Promise<boolean> {
  try {
    await call<{ accepted: number }>('/api/booth/analytics', { method: 'POST', body: JSON.stringify({ events }), timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}
