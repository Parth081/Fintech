// Pure HTTP helpers for the console API layer (error mapping, query strings, paging headers).

export type ApiErrorKind = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'unavailable' | 'network' | 'other';

export class ConsoleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: ApiErrorKind,
    /** For 403: the permission the server said was missing (if it said). */
    readonly permission?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ConsoleApiError';
  }
}

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 0) return 'network';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'other';
}

/** Build the error a response body describes. Body is the parsed JSON (or text, or undefined). */
export function errorFromResponse(status: number, body: unknown, fallbackPermission?: string): ConsoleApiError {
  const kind = kindForStatus(status);
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  const serverMsg = str(o.message) ?? str(o.error) ?? (typeof body === 'string' ? str(body.slice(0, 200)) : undefined);
  const detail = str(o.detail);
  if (kind === 'forbidden') {
    const perm = str(o.permission) ?? str(o.required) ?? str(o.missing) ?? fallbackPermission;
    return new ConsoleApiError(`You don't have permission: ${perm ?? 'this action'}`, status, kind, perm, body);
  }
  if (kind === 'unauthorized') return new ConsoleApiError('Your session has ended. Sign in again.', status, kind, undefined, body);
  if (kind === 'unavailable') {
    const what = serverMsg ?? 'Service unavailable';
    return new ConsoleApiError(detail ? `${what} (${detail})` : what, status, kind, undefined, body);
  }
  const msg = serverMsg ? (detail ? `${serverMsg}: ${detail}` : serverMsg) : `Request failed (HTTP ${status})`;
  return new ConsoleApiError(msg, status, kind, undefined, body);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Query string from a params object: empty/null/undefined values are left out; arrays become comma lists. */
export function buildQuery(params: Record<string, string | number | boolean | readonly string[] | null | undefined> | undefined): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) qs.set(k, v.join(','));
      continue;
    }
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** X-Total-Count header -> number (falls back to the page length when absent or bad). */
export function parseTotal(header: string | null, fallback: number): number {
  if (header === null || header.trim() === '') return fallback;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Paging maths for tables. */
export function pageInfo(offset: number, limit: number, total: number): { page: number; pages: number; from: number; to: number; hasPrev: boolean; hasNext: boolean } {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const page = Math.min(pages, Math.floor(offset / Math.max(1, limit)) + 1);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return { page, pages, from, to, hasPrev: offset > 0, hasNext: offset + limit < total };
}
