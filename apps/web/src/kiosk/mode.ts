// Kiosk: watch the gateway's /health for the system mode. In safe mode (recorded backup run) the send flow
// is replaced by a friendly "demo paused" screen; the booth service and lead data are untouched.
import { useEffect, useState } from 'react';
import { modeInfo } from '../lib/mode';

export const MODE_POLL_MS = 5000;

/** True when /health reports safe mode. Network errors keep the previous answer (a blip never flips the screen). */
export function useSafeMode(): boolean {
  const [safe, setSafe] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch('/health', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (alive) setSafe(modeInfo(body as { mode?: unknown }).safe);
      } catch {
        /* keep last */
      }
    };
    void check();
    const t = setInterval(() => void check(), MODE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return safe;
}
