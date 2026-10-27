// Console data hooks.
//   const { data, error, loading, refresh } = useApi((signal) => opsApi.overview(signal), [], { intervalMs: 10_000 });
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ConsoleApiError, errorMessage } from '../lib/http';


export interface ApiState<T> {
  data: T | null;
  error: string | null;
  /** The error object (ConsoleApiError for API failures). */
  errorObj: unknown;
  /** True until the first response (or error) for the current deps. */
  loading: boolean;
  /** True while any request is in flight (incl. background refreshes). */
  fetching: boolean;
  updatedAt: number | null;
  refresh(): void;
}

/**
 * Fetch on mount and whenever `deps` change; optionally poll (paused while the tab is hidden). Keeps the
 * last good data on poll errors; clears it when deps change.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: { intervalMs?: number; enabled?: boolean } = {},
): ApiState<T> {
  const { intervalMs = 0, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [fetching, setFetching] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const depsKey = JSON.stringify(deps);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (lastKey.current !== depsKey) {
      lastKey.current = depsKey;
      setData(null);
      setError(null);
      setLoading(true);
    }
    let disposed = false;
    let timer: number | null = null;
    let ctrl: AbortController | null = null;
    const run = async () => {
      if (disposed) return;
      if (intervalMs > 0 && typeof document !== 'undefined' && document.hidden) {
        timer = window.setTimeout(() => void run(), intervalMs);
        return;
      }
      ctrl = new AbortController();
      setFetching(true);
      try {
        const d = await fetcherRef.current(ctrl.signal);
        if (disposed) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (disposed || ctrl.signal.aborted) return;
        setError(err);
      } finally {
        if (!disposed) {
          setFetching(false);
          setLoading(false);
        }
      }
      if (!disposed && intervalMs > 0) timer = window.setTimeout(() => void run(), intervalMs);
    };
    void run();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      ctrl?.abort();
    };
  }, [depsKey, intervalMs, enabled, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error: error === null ? null : errorMessage(error), errorObj: error, loading, fetching, updatedAt, refresh };
}

/** True when the error is a 403 (render a permission state rather than a failure). */
export function isForbidden(err: unknown): boolean {
  return err instanceof ConsoleApiError && err.kind === 'forbidden';
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** State persisted in localStorage (per-browser conveniences: saved views, columns, theme). */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

/** Calls `onOutside` on pointer-down outside `ref` or on Escape while `active`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [ref, active]);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
