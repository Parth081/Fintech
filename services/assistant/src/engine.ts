// The assistant: classify -> grounded draft (always) -> optional LLM phrasing -> verify -> answer.
// Returned answers are always verified: an LLM answer with any unmatched number is discarded for the
// grounded one, and a grounded answer that somehow fails verification is replaced by a number-free reply.
import type { Answer, AskContext, SuggestedQuestion } from '@ct/contracts';
import { toCitation, type Fact } from './facts';
import { OFF_TOPIC_TEXT, groundedDraft } from './grounded';
import { classify, isActionRequest, normalizeQuestion, type Intent } from './intents';
import { LlmFailure, phraseWithLlm, type LlmClient, type LlmFailureKind } from './llm';
import type { FactStore } from './store';
import { followUpsFor, scenarioQuestions, suggestionsFor } from './suggestions';
import { verifyAnswer } from './verify';

export const MAX_QUESTION_CHARS = 300;
export const ACTION_NOTICE = 'I only explain what was recorded: I cannot release, reject, retry, refund or change anything, and nothing here was changed by this question. This is what the record shows.';
export const MAX_ANSWER_WORDS = 150; // LLM answers above this are discarded (target ~120)

export type LlmHealth = 'available' | 'unavailable' | 'disabled';

export interface AssistantOptions {
  store: FactStore;
  /** 'auto' uses Claude when a client is available; 'off' = grounded/cached only (offline booth). */
  llmMode?: 'auto' | 'off';
  /** null/undefined = no credentials resolved. */
  llm?: LlmClient | null;
  /** Milliseconds clock (latency, cooldowns). */
  now?: () => number;
  llmDeadlineMs?: number;
  log?: (line: string) => void;
}

interface CacheEntry {
  answer: Pick<Answer, 'answer' | 'citations' | 'intent'>;
  /** Grounded text when cached: the entry is valid only while the recorded facts are unchanged. */
  groundedText: string;
  source: 'llm' | 'grounded';
}

const COOLDOWN_MS: Partial<Record<LlmFailureKind, number>> = { auth: 10 * 60_000, network: 60_000, rate_limit: 30_000 };

export function contextKey(c: AskContext): string {
  return c.kind === 'payment' ? `payment:${c.paymentId}` : c.kind;
}

export function parseContext(raw: unknown): AskContext | null {
  if (typeof raw === 'string') {
    if (raw === 'scenario' || raw === 'system') return { kind: raw };
    const m = /^payment:([A-Za-z0-9._:-]{1,128})$/.exec(raw);
    return m ? { kind: 'payment', paymentId: m[1]! } : null;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { kind?: unknown; paymentId?: unknown };
    if (o.kind === 'scenario' || o.kind === 'system') return { kind: o.kind };
    if (o.kind === 'payment' && typeof o.paymentId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(o.paymentId)) return { kind: 'payment', paymentId: o.paymentId };
  }
  return null;
}

export class Assistant {
  readonly store: FactStore;
  private readonly llmMode: 'auto' | 'off';
  private readonly llm: LlmClient | null;
  private readonly now: () => number;
  private readonly deadlineMs: number | undefined;
  private readonly log: (line: string) => void;
  private cooldownUntil = 0;
  private readonly cache = new Map<string, CacheEntry>();
  lastLlmFailure: LlmFailureKind | null = null;

  constructor(opts: AssistantOptions) {
    this.store = opts.store;
    this.llmMode = opts.llmMode ?? 'auto';
    this.llm = opts.llm ?? null;
    this.now = opts.now ?? Date.now;
    this.deadlineMs = opts.llmDeadlineMs;
    this.log = opts.log ?? (() => {});
  }

  health(): LlmHealth {
    if (this.llmMode === 'off') return 'disabled';
    if (!this.llm || this.now() < this.cooldownUntil) return 'unavailable';
    return 'available';
  }

  suggestions(context: AskContext): SuggestedQuestion[] {
    return suggestionsFor(this.store, context);
  }

  /** Pre-answer the scripted scenario questions (served as 'cached' when the model is unreachable). */
  warmCache(): number {
    if (!this.store.latestRun()) return 0;
    let n = 0;
    const context: AskContext = { kind: 'scenario' };
    for (const s of scenarioQuestions(this.store)) {
      const key = `${contextKey(context)}|${normalizeQuestion(s.text)}`;
      if (this.cache.get(key)?.source === 'llm') continue;
      const g = this.grounded(s.text, context, s.intent as Intent);
      this.cache.set(key, { answer: { answer: g.text, citations: g.facts.map(toCitation), intent: s.intent }, groundedText: g.text, source: 'grounded' });
      n += 1;
    }
    return n;
  }

  /** Verified grounded draft (number-free fallback if verification ever fails). */
  private grounded(question: string, context: AskContext, intent: Intent): { text: string; facts: Fact[] } {
    const d = groundedDraft(this.store, intent, context);
    const v = verifyAnswer(d.text, d.facts);
    if (v.verified) return d;
    this.log(`[assistant] grounded answer for ${intent} failed verification (${v.unmatched.map((t) => t.raw).join(', ')}); withheld`);
    return { text: 'I can see the record for that, but I could not confirm every number in my answer, so I will not guess. Try one of the suggested questions.', facts: [] };
  }

  private isSuggested(context: AskContext, question: string): boolean {
    const n = normalizeQuestion(question);
    return suggestionsFor(this.store, context).some((s) => normalizeQuestion(s.text) === n);
  }

  async ask(questionRaw: string, context: AskContext): Promise<Answer> {
    const t0 = this.now();
    const question = questionRaw.trim().slice(0, MAX_QUESTION_CHARS);
    const status = context.kind === 'payment' ? this.store.payment(context.paymentId)?.state.status : undefined;
    const cls = classify(question, context, status ? { status } : {});
    const finish = (a: Omit<Answer, 'question' | 'context' | 'followUps' | 'latencyMs' | 'verified'>): Answer => ({
      question,
      context,
      ...a,
      verified: true,
      followUps: followUpsFor(this.store, context, a.intent, question),
      latencyMs: Math.max(0, this.now() - t0),
    });

    if (cls.offTopic) return finish({ answer: OFF_TOPIC_TEXT, citations: [], mode: 'grounded', intent: 'unknown' });

    const action = isActionRequest(question);
    const g0 = this.grounded(question, context, cls.intent);
    // Read-only by design: an instruction to act is answered with what the record shows, after saying so.
    const g = action ? { text: `${ACTION_NOTICE} ${g0.text}`, facts: g0.facts } : g0;
    const grounded = () => finish({ answer: g.text, citations: g.facts.map(toCitation), mode: 'grounded', intent: cls.intent });
    const key = `${contextKey(context)}|${normalizeQuestion(question)}`;
    const cached = () => {
      const c = this.cache.get(key);
      if (!c || c.groundedText !== g.text) return null;
      return finish({ answer: c.answer.answer, citations: c.answer.citations, mode: 'cached', intent: c.answer.intent });
    };

    if (this.llmMode === 'off' || action || cls.intent === 'needs_payment' || cls.intent === 'unknown') return grounded();
    if (!this.llm || this.now() < this.cooldownUntil) return cached() ?? grounded();

    try {
      const opts: { deadlineMs?: number; now: () => number } = { now: this.now };
      if (this.deadlineMs !== undefined) opts.deadlineMs = this.deadlineMs;
      const draft = await phraseWithLlm(this.llm, this.store, question, context, cls.intent, opts);
      const words = draft.text.split(/\s+/).filter(Boolean).length;
      const v = verifyAnswer(draft.text, draft.facts);
      if (!v.verified || words > MAX_ANSWER_WORDS) {
        throw new LlmFailure('unverified', v.verified ? `too long (${words} words)` : `unmatched: ${v.unmatched.map((t) => t.raw).join(', ')}`);
      }
      this.lastLlmFailure = null;
      const citations = (v.matched.length ? v.matched : g.facts).map(toCitation);
      const answer = finish({ answer: draft.text, citations, mode: 'llm', intent: cls.intent });
      if (this.isSuggested(context, question)) {
        this.cache.set(key, { answer: { answer: answer.answer, citations, intent: cls.intent }, groundedText: g.text, source: 'llm' });
      }
      return answer;
    } catch (err) {
      const f = err instanceof LlmFailure ? err : new LlmFailure('other', 'unexpected');
      this.lastLlmFailure = f.kind;
      const cool = COOLDOWN_MS[f.kind];
      if (cool) this.cooldownUntil = this.now() + cool;
      this.log(`[assistant] LLM answer not used (${f.kind}: ${f.message}); serving ${f.kind === 'unverified' ? 'grounded' : 'cached/grounded'}`);
      if (f.kind === 'unverified' || f.kind === 'refusal') return grounded();
      return cached() ?? grounded();
    }
  }
}
