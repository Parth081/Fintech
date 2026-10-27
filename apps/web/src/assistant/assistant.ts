// AI "Ask why" panel: pure logic (unit tested). The assistant NARRATES recorded facts; the panel shows
// its answer next to the facts it relied on ("from the record") and a subtle badge saying how the answer
// was produced. Everything here tolerates a partial or older assistant: bad data is dropped, never thrown.
import { formatMoney, type Answer, type AnswerMode, type AskContext, type Citation, type SuggestedQuestion } from '@ct/contracts/browser';

export const MAX_QUESTION_CHARS = 300;

/** Query value for GET /suggestions?context=… */
export function contextParam(ctx: AskContext): string {
  return ctx.kind === 'payment' ? `payment:${ctx.paymentId}` : ctx.kind;
}

/** Stable key for a context (changes => the panel starts over). */
export const contextKey = (ctx: AskContext | null): string => (ctx ? contextParam(ctx) : '');

/** Trim, collapse whitespace and cap at MAX_QUESTION_CHARS. Empty -> null. */
export function cleanQuestion(q: string): string | null {
  const t = q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS).trim();
  return t ? t : null;
}

/**
 * HTTP statuses that mean "there is no assistant here" (not deployed, gateway proxy says upstream down):
 * the panel hides itself instead of showing an error. 0 = network error (gateway unreachable).
 */
export function hidesPanel(status: number): boolean {
  return status === 0 || status === 404 || status === 501 || status === 502 || status === 503 || status === 504;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function parseSuggestions(raw: unknown): SuggestedQuestion[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.suggestions) ? raw.suggestions : [];
  const out: SuggestedQuestion[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (!isObj(s) || typeof s.text !== 'string' || !s.text.trim()) continue;
    const text = s.text.trim();
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ id: typeof s.id === 'string' ? s.id : `s${out.length}`, text, intent: typeof s.intent === 'string' ? s.intent : 'unknown' });
  }
  return out;
}

const MODES: readonly AnswerMode[] = ['grounded', 'llm', 'cached'];

function parseCitation(c: unknown): Citation | null {
  if (!isObj(c) || typeof c.field !== 'string' || typeof c.label !== 'string') return null;
  const out: Citation = { eventId: typeof c.eventId === 'string' ? c.eventId : null, field: c.field, value: c.value, label: c.label };
  if (typeof c.eventType === 'string') out.eventType = c.eventType;
  if (typeof c.source === 'string') out.source = c.source;
  return out;
}

/** Defensive parse of POST /ask. null when it is not an answer at all. */
export function parseAnswer(raw: unknown, fallbackQuestion = '', fallbackContext: AskContext = { kind: 'system' }): Answer | null {
  if (!isObj(raw) || typeof raw.answer !== 'string' || !raw.answer.trim()) return null;
  const mode = MODES.includes(raw.mode as AnswerMode) ? (raw.mode as AnswerMode) : 'grounded';
  const citations = Array.isArray(raw.citations) ? raw.citations.map(parseCitation).filter((c): c is Citation => c !== null) : [];
  const followUps = Array.isArray(raw.followUps) ? raw.followUps.filter((f): f is string => typeof f === 'string' && f.trim() !== '').slice(0, 4) : [];
  return {
    question: typeof raw.question === 'string' ? raw.question : fallbackQuestion,
    context: isObj(raw.context) && typeof raw.context.kind === 'string' ? (raw.context as AskContext) : fallbackContext,
    answer: raw.answer.trim(),
    citations,
    mode,
    verified: raw.verified === true,
    intent: typeof raw.intent === 'string' ? raw.intent : 'unknown',
    followUps,
    latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
  };
}

function isMoney(v: unknown): v is { amountMinor: number; currency: string } {
  return isObj(v) && typeof v.amountMinor === 'number' && Number.isSafeInteger(v.amountMinor) && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency);
}

/** A recorded value as the chip shows it: numbers and strings verbatim, money formatted, short JSON otherwise. */
export function formatCitationValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '—';
  if (typeof v === 'string') return v.length > 48 ? `${v.slice(0, 47)}…` : v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (isMoney(v)) return formatMoney(v);
  if (Array.isArray(v)) return v.length <= 3 ? v.map(formatCitationValue).join(', ') : `${v.length} items`;
  try {
    const s = JSON.stringify(v);
    return s.length > 48 ? `${s.slice(0, 47)}…` : s;
  } catch {
    return '—';
  }
}

/** "Fraud score 0.04" */
export function citationText(c: Citation): string {
  return `${c.label} ${formatCitationValue(c.value)}`.trim();
}

/** Tooltip: where the fact comes from. */
export function citationTitle(c: Citation): string {
  const where = c.eventId ? `${c.eventType ?? 'event'} ${c.eventId} · ${c.field}` : c.source ? `computed: ${c.source}` : c.field;
  return `From the record: ${where}`;
}

/** Citations worth showing as chips: unique by label+value, at most `max`. */
export function citationChips(cs: Citation[], max = 6): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of cs) {
    const k = citationText(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

export interface ModeBadge {
  label: string;
  title: string;
}

/** Subtle badge: how this answer was produced. */
export function modeBadge(mode: AnswerMode): ModeBadge {
  switch (mode) {
    case 'llm':
      return { label: 'AI', title: 'Phrased by Claude from the recorded facts; every number was checked against them' };
    case 'cached':
      return { label: 'Cached', title: 'A pre-generated, verified answer (the model is not reachable right now)' };
    default:
      return { label: 'Grounded', title: 'Built directly from the recorded facts (works offline)' };
  }
}

/** Questions offered as chips: answer follow-ups first (if any), then suggestions, without the one just asked. */
export function chipQuestions(suggestions: SuggestedQuestion[], answer: Answer | null, max = 4): string[] {
  const asked = answer?.question.trim().toLowerCase();
  const out: string[] = [];
  for (const t of [...(answer?.followUps ?? []), ...suggestions.map((s) => s.text)]) {
    const k = t.trim().toLowerCase();
    if (!k || k === asked || out.some((o) => o.toLowerCase() === k)) continue;
    out.push(t.trim());
    if (out.length >= max) break;
  }
  return out;
}

// ---- panel state -----------------------------------------------------------------------------

export type AskStatus = 'idle' | 'loading' | 'answered' | 'error' | 'hidden';

export interface AskState {
  key: string;
  status: AskStatus;
  suggestions: SuggestedQuestion[];
  question: string | null;
  answer: Answer | null;
  error: string | null;
  /** Increments per question; stale responses (older seq) are ignored. */
  seq: number;
}

export type AskEvent =
  | { type: 'context'; key: string }
  | { type: 'suggestions'; key: string; suggestions: SuggestedQuestion[] }
  | { type: 'ask'; question: string }
  | { type: 'answer'; seq: number; answer: Answer }
  | { type: 'failed'; seq: number | null; status: number; error: string }
  | { type: 'clear' };

export const initialAsk = (key = ''): AskState => ({ key, status: 'idle', suggestions: [], question: null, answer: null, error: null, seq: 0 });

export function askReducer(s: AskState, ev: AskEvent): AskState {
  switch (ev.type) {
    case 'context':
      return ev.key === s.key ? s : { ...initialAsk(ev.key), seq: s.seq, status: s.status === 'hidden' ? 'hidden' : 'idle' };
    case 'suggestions':
      // A successful suggestions call also proves the assistant is (back) up.
      return ev.key === s.key ? { ...s, suggestions: ev.suggestions, status: s.status === 'hidden' ? 'idle' : s.status } : s;
    case 'ask':
      if (s.status === 'hidden') return s;
      return { ...s, status: 'loading', question: ev.question, error: null, seq: s.seq + 1 };
    case 'answer':
      return ev.seq === s.seq && s.status === 'loading' ? { ...s, status: 'answered', answer: ev.answer } : s;
    case 'failed':
      if (ev.seq !== null && ev.seq !== s.seq) return s;
      if (hidesPanel(ev.status)) return { ...s, status: 'hidden' };
      return ev.seq === null ? s : { ...s, status: 'error', error: ev.error };
    case 'clear':
      return { ...s, status: s.status === 'hidden' ? 'hidden' : 'idle', question: null, answer: null, error: null };
    default:
      return s;
  }
}

/** Friendly error line (never a stack trace on a booth screen). */
export function errorText(status: number, error: string): string {
  if (status === 429) return 'Lots of questions right now. Try again in a moment.';
  if (status === 400) return 'Could not ask that one. Try a shorter question about the payments on screen.';
  if (/timed out/i.test(error)) return 'That took too long. Try again.';
  return 'The explainer could not answer just now.';
}
