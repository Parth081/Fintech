// "Ask why" sheet: suggestion chips for this payment, answers with citation chips, and an optional on-screen
// keyboard for a free-text question (max 300 characters). Typed text is never sent to analytics.
import { useEffect, useState } from 'react';
import type { Answer, SuggestedQuestion } from '@ct/contracts/browser';
import { askAssistant, fetchSuggestions } from './api';
import { citationValue, rankSuggestions, visibleAnswer, type KioskStep } from './explain';
import { applyKey, finalQuestion, KEY_ROWS, QUESTION_MAX, type KeyboardState } from './keyboard';
import type { AnalyticsData } from './analytics';

interface Props {
  paymentId: string;
  step: KioskStep | undefined;
  onClose: () => void;
  onAsked: (data: AnalyticsData) => void;
}

// Suggestions per payment survive closing and reopening the sheet (memory only).
const suggestionCache = new Map<string, SuggestedQuestion[]>();

const KEY_LABEL: Record<string, string> = { shift: '⇧', back: '⌫', space: 'space', clear: 'clear' };

export function AskPanel({ paymentId, step, onClose, onAsked }: Props) {
  const [suggestions, setSuggestions] = useState<SuggestedQuestion[] | null>(suggestionCache.get(paymentId) ?? null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [typing, setTyping] = useState(false);
  const [kb, setKb] = useState<KeyboardState>({ text: '', shift: false });

  useEffect(() => {
    if (suggestionCache.has(paymentId)) return;
    let alive = true;
    fetchSuggestions(paymentId)
      .then((list) => {
        suggestionCache.set(paymentId, list);
        if (alive) setSuggestions(list);
      })
      .catch(() => alive && setSuggestions([]));
    return () => {
      alive = false;
    };
  }, [paymentId]);

  const ask = async (question: string, source: 'chip' | 'typed', intent?: string) => {
    const q = finalQuestion(question);
    if (!q || asking) return;
    setAsking(q);
    setFailed(false);
    setTyping(false);
    // Suggestion text is ours and safe to count; typed text might contain anything, so only its length is sent.
    onAsked(source === 'chip' ? { text: q, source, ...(intent ? { intent } : {}) } : { source, length: q.length });
    try {
      const a = await askAssistant(q, paymentId);
      setAnswer(a);
      if (!visibleAnswer(a)) setFailed(true);
    } catch {
      setAnswer(null);
      setFailed(true);
    } finally {
      setAsking(null);
    }
  };

  const chips = rankSuggestions(suggestions ?? [], step?.intent, 4);
  const shown = visibleAnswer(answer);
  const followUps = shown && answer ? answer.followUps.slice(0, 3) : [];

  return (
    <div className="kiosk-sheet-backdrop" onClick={onClose}>
      <section className="kiosk-sheet" role="dialog" aria-modal="true" aria-label="Ask why" onClick={(e) => e.stopPropagation()}>
        <header className="kiosk-sheet-head">
          <div>
            <span className="kiosk-dim">Ask about</span>
            <h2>{step?.title ?? 'this payment'}</h2>
          </div>
          <button type="button" className="kiosk-ghost" onClick={onClose} aria-label="Close">
            Close ✕
          </button>
        </header>

        {asking && (
          <div className="kiosk-answer is-loading">
            <p className="kiosk-q">“{asking}”</p>
            <span className="kiosk-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        {!asking && shown && answer && (
          <div className="kiosk-answer">
            <p className="kiosk-q">“{answer.question}”</p>
            <p className="kiosk-a">{shown}</p>
            {answer.citations.length > 0 && (
              <div className="kiosk-cites" aria-label="Based on these recorded facts">
                <span className="kiosk-dim">Based on the recorded facts:</span>
                {answer.citations.slice(0, 6).map((c, i) => (
                  <span key={`${c.eventId ?? 'agg'}-${c.field}-${i}`} className="kiosk-cite" title={c.source ?? c.field}>
                    {c.label}: <b>{citationValue(c.value)}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {!asking && failed && <p className="kiosk-note">I can't answer that one reliably right now. Try one of these, or ask someone on the team.</p>}

        {!typing && (
          <div className="kiosk-suggest">
            {suggestions === null && <span className="kiosk-dim">Loading questions…</span>}
            {(followUps.length ? followUps.map((text) => ({ id: text, text, intent: '' })) : chips).map((s) => (
              <button key={s.id} type="button" className="kiosk-chip" disabled={!!asking} onClick={() => void ask(s.text, 'chip', s.intent || undefined)}>
                {s.text}
              </button>
            ))}
            <button type="button" className="kiosk-chip kiosk-chip-ghost" disabled={!!asking} onClick={() => setTyping(true)}>
              ⌨ Type my own question
            </button>
          </div>
        )}

        {typing && (
          <div className="kiosk-kb">
            <div className="kiosk-kb-input" aria-live="polite">
              {kb.text || <span className="kiosk-dim">Type a question about this payment…</span>}
              <span className="kiosk-caret" aria-hidden="true" />
              <span className="kiosk-kb-count">
                {kb.text.length}/{QUESTION_MAX}
              </span>
            </div>
            {KEY_ROWS.map((row, r) => (
              <div className="kiosk-kb-row" key={r}>
                {row.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`kiosk-key key-${k.length > 1 ? k : 'char'}${k === 'shift' && kb.shift ? ' is-on' : ''}`}
                    onClick={() => setKb((s) => applyKey(s, k))}
                  >
                    {KEY_LABEL[k] ?? (kb.shift ? k.toUpperCase() : k)}
                  </button>
                ))}
              </div>
            ))}
            <div className="kiosk-actions">
              <button type="button" className="kiosk-ghost" onClick={() => setTyping(false)}>
                Back to suggestions
              </button>
              <button type="button" className="kiosk-primary" disabled={!finalQuestion(kb.text)} onClick={() => void ask(kb.text, 'typed')}>
                Ask
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
