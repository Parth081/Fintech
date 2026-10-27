// Reusable AI "Ask why" panel. Given an AskContext it offers suggested questions as chips, shows the
// answer with the recorded facts it relies on ("from the record: Fraud score 0.04") and a subtle badge
// saying how the answer was produced (grounded / AI / cached). It hides itself when no assistant is
// deployed or reachable (404 / 502 / 503 / network), so screens never show a broken panel.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AskContext, SuggestedQuestion } from '@ct/contracts/browser';
import { chipQuestions, citationChips, citationText, citationTitle, MAX_QUESTION_CHARS, modeBadge } from './assistant';
import { useAskPanel } from './useAskPanel';
import './assistant.css';

export interface AskPanelProps {
  /** What the questions are about; null renders nothing. */
  context: AskContext | null;
  title?: string;
  /** One line under the title, e.g. which payment this is. */
  subtitle?: string;
  /** 'console' (presenter tablet, rem sizes, free-text box) or 'stage' (big screen, em sizes, read-only). */
  variant?: 'console' | 'stage';
  /** Show the free-text question box (default: console yes, stage no). */
  allowFreeText?: boolean;
  /** Max question chips (default 4; stage 0 hides them). */
  maxChips?: number;
  /** Ask automatically once per context: a fixed question, or pick one from the suggestions. */
  autoAsk?: string | ((suggestions: SuggestedQuestion[]) => string | null);
  className?: string;
}

export function AskPanel({ context, title = 'Ask why', subtitle, variant = 'console', allowFreeText, maxChips = 4, autoAsk, className }: AskPanelProps) {
  const { state, ask } = useAskPanel(context);
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const freeText = allowFreeText ?? variant === 'console';

  // Auto-ask (stage "Explained" card): once per context, when its suggestions are in.
  const autoDone = useRef<string | null>(null);
  useEffect(() => {
    if (!autoAsk || !context || state.status !== 'idle' || autoDone.current === state.key) return;
    const q = typeof autoAsk === 'string' ? autoAsk : state.suggestions.length ? autoAsk(state.suggestions) : null;
    if (!q) return;
    autoDone.current = state.key;
    ask(q);
  }, [autoAsk, context, state.status, state.key, state.suggestions, ask]);

  useEffect(() => setDraft(''), [state.key]);

  if (!context || state.status === 'hidden') return null;

  const chips = maxChips > 0 ? chipQuestions(state.suggestions, state.answer, maxChips) : [];
  const loading = state.status === 'loading';
  const answer = state.status === 'answered' ? state.answer : null;
  const badge = answer ? modeBadge(answer.mode) : null;
  const facts = answer ? citationChips(answer.citations, variant === 'stage' ? 4 : 6) : [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || loading) return;
    ask(draft);
    setDraft('');
  };

  return (
    <section className={`ask ask-${variant}${className ? ` ${className}` : ''}`} aria-label={title} aria-busy={loading}>
      <header className="ask-head">
        <span className="ask-spark" aria-hidden="true">
          ✦
        </span>
        <div className="ask-head-text">
          <h2 className="ask-title">{title}</h2>
          {subtitle && <span className="ask-sub">{subtitle}</span>}
        </div>
        {badge && (
          <span className={`ask-mode ask-mode-${answer!.mode}`} title={badge.title}>
            {badge.label}
          </span>
        )}
      </header>

      {(state.question || loading) && (
        <div className="ask-body" aria-live="polite">
          {state.question && <p className="ask-q">“{state.question}”</p>}
          {loading && (
            <div className="ask-loading" role="status">
              <span className="ask-shimmer" />
              <span className="ask-shimmer ask-shimmer-short" />
              <span className="ask-loading-text">Reading the record…</span>
            </div>
          )}
          {answer && <p className="ask-answer">{answer.answer}</p>}
          {facts.length > 0 && (
            <div className="ask-facts">
              <span className="ask-facts-label">From the record</span>
              <ul className="ask-chips ask-cites">
                {facts.map((c, i) => (
                  <li key={`${c.eventId ?? 'agg'}:${c.field}:${i}`} className="ask-cite" title={citationTitle(c)}>
                    {citationText(c)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.status === 'error' && state.error && <p className="ask-error">{state.error}</p>}
        </div>
      )}

      {chips.length > 0 && (
        <div className="ask-chips ask-suggest" role="group" aria-label="Suggested questions">
          {chips.map((q) => (
            <button key={q} type="button" className="ask-chip" disabled={loading} onClick={() => ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {freeText && (
        <form className="ask-form" onSubmit={submit}>
          <label htmlFor={inputId} className="ask-visually-hidden">
            Ask a question about this
          </label>
          <input
            id={inputId}
            className="ask-input"
            type="text"
            value={draft}
            maxLength={MAX_QUESTION_CHARS}
            placeholder="Ask about this payment, the outage or the ledger…"
            onChange={(e) => setDraft(e.target.value)}
            disabled={loading}
            autoComplete="off"
          />
          <button type="submit" className="ask-send" disabled={loading || !draft.trim()}>
            Ask
          </button>
        </form>
      )}
    </section>
  );
}
