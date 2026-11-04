// Tiny HTTP helper shared by the verify:m6 modules. Never throws: a transport failure is status 0.
export interface HttpResult<T = unknown> {
  /** 0 = no HTTP answer (connection refused / reset / timeout). */
  status: number;
  body: T;
  headers: Headers | null;
  text: string;
  error?: string;
}

export async function http<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<HttpResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, headers: res.headers, text };
  } catch (err) {
    return { status: 0, body: undefined as T, headers: null, text: '', error: (err as Error).message };
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Statuses that mean "the service behind the gateway is restarting" rather than "the request is wrong". */
export const isTransient = (status: number): boolean => status === 0 || status === 502 || status === 503 || status === 504;

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
