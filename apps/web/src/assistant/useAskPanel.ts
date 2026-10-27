// State for one AskPanel: suggestions for the context, one question at a time, stale answers dropped.
// Hidden while the assistant is not deployed / unreachable (404, 502, …); retries quietly so the panel
// appears on its own once the assistant comes up.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AskContext } from '@ct/contracts/browser';
import { askAssistant, AssistantError, fetchSuggestions } from './api';
import { askReducer, cleanQuestion, contextKey, errorText, initialAsk, type AskState } from './assistant';

const RETRY_HIDDEN_MS = 30_000;

export interface AskPanelModel {
  state: AskState;
  ask(question: string): void;
  clear(): void;
}

export function useAskPanel(context: AskContext | null): AskPanelModel {
  const key = contextKey(context);
  const [state, dispatch] = useReducer(askReducer, key, initialAsk);
  const ctxRef = useRef(context);
  ctxRef.current = context;
  const seqRef = useRef(state.seq);
  seqRef.current = state.seq;
  const askAbort = useRef<AbortController | null>(null);

  // New context: start over and load its suggestions (and retry while hidden).
  useEffect(() => {
    dispatch({ type: 'context', key });
    askAbort.current?.abort();
    const ctx = ctxRef.current;
    if (!ctx) return;
    let disposed = false;
    let timer: number | null = null;
    let ctrl: AbortController | null = null;
    const load = async () => {
      ctrl = new AbortController();
      try {
        const suggestions = await fetchSuggestions(ctx, ctrl.signal);
        if (!disposed) dispatch({ type: 'suggestions', key, suggestions });
      } catch (err) {
        if (disposed || ctrl.signal.aborted) return;
        const status = err instanceof AssistantError ? err.status : 0;
        dispatch({ type: 'failed', seq: null, status, error: err instanceof Error ? err.message : String(err) });
        timer = window.setTimeout(() => void load(), RETRY_HIDDEN_MS);
      }
    };
    void load();
    return () => {
      disposed = true;
      ctrl?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [key]);

  useEffect(() => () => askAbort.current?.abort(), []);

  const ask = useCallback((question: string) => {
    const ctx = ctxRef.current;
    const q = cleanQuestion(question);
    if (!ctx || !q) return;
    askAbort.current?.abort();
    const ctrl = new AbortController();
    askAbort.current = ctrl;
    const seq = seqRef.current + 1;
    dispatch({ type: 'ask', question: q });
    askAssistant(q, ctx, ctrl.signal).then(
      (answer) => dispatch({ type: 'answer', seq, answer }),
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        const status = err instanceof AssistantError ? err.status : 0;
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'failed', seq, status, error: errorText(status, msg) });
      },
    );
  }, []);

  const clear = useCallback(() => {
    askAbort.current?.abort();
    dispatch({ type: 'clear' });
  }, []);

  return { state, ask, clear };
}
