import { useCallback, useEffect, useRef, useState } from 'react';

export interface Poll<T> {
  data: T | null;
  error: string | null;
  /** Time of the last successful fetch. */
  updatedAt: number | null;
  refresh(): void;
}

/**
 * Fetch now and every `intervalMs` (0 = once) while mounted; refetch when `key` changes.
 * Keeps the last good data on errors so a blip does not blank the big screen.
 * Pauses while the tab is hidden.
 */
export function usePoll<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs: number, key: string = ''): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    setData(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let ctrl: AbortController | null = null;
    const run = async () => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.hidden && intervalMs > 0) {
        timer = window.setTimeout(() => void run(), intervalMs);
        return;
      }
      ctrl = new AbortController();
      try {
        const d = await fetcherRef.current(ctrl.signal);
        if (disposed) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (disposed || ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      if (!disposed && intervalMs > 0) timer = window.setTimeout(() => void run(), intervalMs);
    };
    void run();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      ctrl?.abort();
    };
  }, [intervalMs, key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, updatedAt, refresh };
}
