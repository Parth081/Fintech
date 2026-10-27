// Assistant HTTP calls through the gateway (/api/assistant/* -> services/assistant). Same origin only.
import type { Answer, AskContext, SuggestedQuestion } from '@ct/contracts/browser';
import { cleanQuestion, contextParam, parseAnswer, parseSuggestions } from './assistant';

/** status 0 = network error (gateway unreachable); 408 = timed out. */
export class AssistantError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AssistantError';
  }
}

async function request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal && 'any' in AbortSignal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: combined, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  } catch (err) {
    if (signal?.aborted) throw err;
    // A timeout is not "no assistant here" (408: the panel shows a retryable error instead of hiding).
    if (err instanceof Error && err.name === 'TimeoutError') throw new AssistantError('Request timed out', 408);
    throw new AssistantError('Gateway unreachable', 0);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === 'string') msg = b.error;
    } catch {
      /* not JSON */
    }
    throw new AssistantError(msg, res.status);
  }
  return res.json().catch(() => null);
}

export async function fetchSuggestions(ctx: AskContext, signal?: AbortSignal): Promise<SuggestedQuestion[]> {
  const raw = await request(`/api/assistant/suggestions?context=${encodeURIComponent(contextParam(ctx))}`, { method: 'GET' }, 8000, signal);
  return parseSuggestions(raw);
}

/** POST /api/assistant/ask. An LLM-phrased answer can take a while: 35 s (the gateway proxy allows 30 s). */
export async function askAssistant(question: string, ctx: AskContext, signal?: AbortSignal): Promise<Answer> {
  const q = cleanQuestion(question);
  if (!q) throw new AssistantError('empty question', 400);
  const raw = await request('/api/assistant/ask', { method: 'POST', body: JSON.stringify({ question: q, context: ctx }) }, 35_000, signal);
  const answer = parseAnswer(raw, q, ctx);
  if (!answer) throw new AssistantError('malformed answer', 500);
  return answer;
}
