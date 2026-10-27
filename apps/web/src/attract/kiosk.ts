// Optional kiosk module (apps/web/src/kiosk/Kiosk.tsx, built by another team). Resolved at build time with
// import.meta.glob, so the app still builds and runs when the file does not exist yet.
import type { ComponentType } from 'react';

const modules = import.meta.glob('../kiosk/Kiosk.tsx');
const loader = modules['../kiosk/Kiosk.tsx'];

export const KIOSK_AVAILABLE = loader !== undefined;
export const KIOSK_HASH = '#/kiosk';

/** Loader for React.lazy, or null when there is no kiosk in this build. */
export const loadKiosk: (() => Promise<{ default: ComponentType }>) | null = loader
  ? () =>
      loader().then((m) => {
        const mod = m as { Kiosk?: ComponentType; default?: ComponentType };
        const C = mod.Kiosk ?? mod.default;
        if (!C) throw new Error('kiosk module has no Kiosk export');
        return { default: C };
      })
  : null;

export function isKioskHash(hash: string): boolean {
  return /^#\/?kiosk(?:[/?]|$)/.test(hash);
}
