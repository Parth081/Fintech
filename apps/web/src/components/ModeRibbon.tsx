import { modeInfo, RIBBON_TEXT, ribbonDetail } from '../lib/mode';

/**
 * Calm, persistent ribbon while the recorded backup run plays. Fixed to the top centre so it never
 * disturbs a layout, and it never covers the SIMULATION label (which sits at the right of each header).
 */
export function ModeRibbon({ source }: { source: { mode?: unknown; recording?: unknown } | null | undefined }) {
  const info = modeInfo(source);
  if (!info.safe) return null;
  return (
    <div className="mode-ribbon" role="status" aria-live="polite">
      <strong>{RIBBON_TEXT}</strong>
      <span>{ribbonDetail(info)}</span>
    </div>
  );
}
