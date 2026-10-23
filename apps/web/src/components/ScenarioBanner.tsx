import { bannerFor } from '../lib/control';
import type { GatewayControlView } from '../lib/types';

/** Audience banner across the top of every view while a scenario runs (title + step, never the narration). */
export function ScenarioBanner({ view }: { view: GatewayControlView | null }) {
  const b = bannerFor(view);
  if (!b) return null;
  const paused = view?.orchestrator?.paused ?? view?.control.paused ?? false;
  return (
    <div className="scenario-banner" role="status" aria-live="polite">
      <span className="scenario-banner-tag">Scenario</span>
      <strong className="scenario-banner-title">{b.title}</strong>
      {b.step && (
        <span key={b.step} className="scenario-banner-step">
          {b.step}
        </span>
      )}
      {paused && <span className="scenario-banner-paused">Paused</span>}
    </div>
  );
}

/** Full-screen notice on audience screens while the demo resets. */
export function ResetNotice({ startedAt, now }: { startedAt: string; now: number }) {
  const s = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  return (
    <div className="reset-overlay reset-overlay-audience" role="alertdialog" aria-live="assertive" aria-label="Resetting the demo">
      <div className="reset-box">
        <div className="reset-spinner" aria-hidden="true" />
        <h2>Resetting the demo… ({s}s)</h2>
        <p>Fresh, empty, balanced ledger in a few seconds.</p>
      </div>
    </div>
  );
}
