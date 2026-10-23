// Presenter console (#/presenter): built for a tablet in the presenter's hand. Large touch targets,
// high contrast, portrait and landscape. Commands go to the orchestrator through the gateway.
import { useCallback, useEffect, useReducer, useState } from 'react';
import type { PacePreset, ScenarioInfo } from '@ct/contracts/browser';
import type { LiveFeed } from '../hooks/useLiveFeed';
import { useNow } from '../hooks/useNow';
import { usePoll } from '../hooks/usePoll';
import {
  ApiError,
  fetchHealth,
  fetchTrialBalance,
  focusPayment,
  requestReset,
  setAmbient,
  setPace,
  setPaused,
  startScenario,
  stopScenario,
} from '../lib/api';
import {
  AMBIENT_PRESETS,
  ambientPresetFor,
  BREAKER_LABEL,
  breakerSentence,
  explanationTarget,
  formatCountdown,
  outageSentence,
  PACE_PRESETS,
  providerStatusRows,
  resetReducer,
  scenarioProgress,
  type ScenarioProgress,
} from '../lib/control';
import { formatCount, formatDuration, providerName, shortId } from '../lib/format';
import type { ConnectionStatus } from '../lib/types';

interface Props {
  live: LiveFeed;
  /** Open the payment drawer on this device. */
  onOpenPayment(paymentId: string): void;
}

const CONNECTION_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  polling: 'Polling',
  offline: 'Gateway offline',
};

export function PresenterConsole({ live, onOpenPayment }: Props) {
  const now = useNow(250);
  const ledger = usePoll(fetchTrialBalance, 2000);
  const view = live.control?.view ?? null;
  const orch = view?.orchestrator ?? null;
  const progress = view && live.control ? scenarioProgress(view, live.control.receivedAt, now) : null;
  const running = (orch?.activeRun ?? null) !== null || view?.control.scenario != null;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [reset, dispatchReset] = useReducer(resetReducer, { phase: 'idle' });

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(t);
  }, [message]);

  const command = useCallback(
    async (key: string, fn: () => Promise<unknown>, ok?: string) => {
      setBusy(key);
      try {
        const result = await fn();
        if (result && typeof result === 'object' && 'scenarios' in result) live.patchOrchestrator(result as never);
        if (ok) setMessage({ tone: 'ok', text: ok });
        live.refreshControl(true);
      } catch (err) {
        setMessage({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(null);
      }
    },
    [live],
  );

  // ---- reset --------------------------------------------------------------------------
  const beginReset = useCallback(async () => {
    let before: string | null = null;
    try {
      before = (await fetchHealth(AbortSignal.timeout(1500))).instanceId ?? null;
    } catch {
      /* unknown: rely on seeing the gateway go away */
    }
    dispatchReset({ type: 'start', nowMs: Date.now(), beforeInstance: before });
    requestReset().then(
      () => dispatchReset({ type: 'post', ok: true }),
      (err: unknown) =>
        dispatchReset({ type: 'post', ok: false, status: err instanceof ApiError ? err.status : 0, error: err instanceof Error ? err.message : String(err) }),
    );
  }, []);

  const resetting = reset.phase === 'resetting';
  useEffect(() => {
    if (!resetting) return;
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      let health = null;
      try {
        health = await fetchHealth(AbortSignal.timeout(1500));
      } catch {
        health = null;
      }
      if (disposed) return;
      dispatchReset({ type: 'health', health, nowMs: Date.now() });
      timer = window.setTimeout(() => void poll(), 500);
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [resetting]);

  const back = reset.phase === 'back';
  const { refreshControl } = live;
  const { refresh: refreshLedger } = ledger;
  useEffect(() => {
    if (!back) return;
    refreshControl(true);
    refreshLedger();
    const t = window.setTimeout(() => dispatchReset({ type: 'dismiss' }), 5000);
    return () => window.clearTimeout(t);
  }, [back, refreshControl, refreshLedger]);

  // ---- render ---------------------------------------------------------------------------
  const target = explanationTarget(view);
  const ambientPreset = ambientPresetFor(orch?.ambient);
  const paused = orch?.paused ?? view?.control.paused ?? false;
  const stats = live.feed.stats;
  const rows = providerStatusRows(view);
  const outages = Object.values(view?.control.outages ?? {});
  const orchDown = view !== null && orch === null;

  return (
    <div className="pc">
      <header className="pc-top">
        <div>
          <h1 className="pc-title">Presenter</h1>
          <span className="pc-sub">Control Tower · simulation · synthetic data</span>
        </div>
        <div className="pc-top-right">
          <a className="btn pc-link" href="#/stage" target="_blank" rel="noopener">
            Open big screen ↗
          </a>
          <span className={`conn conn-${live.connection}`} role="status">
            <span className="conn-dot" aria-hidden="true" />
            {CONNECTION_TEXT[live.connection]}
          </span>
        </div>
      </header>

      {!view && <div className="pc-alert pc-alert-bad">Waiting for the gateway… (is the system running?)</div>}
      {orchDown && (
        <div className="pc-alert pc-alert-bad" role="alert">
          <strong>Orchestrator unreachable.</strong> Scenarios, traffic and pace controls are unavailable. Start the stack with <code>npm start</code>.
          {view?.orchestratorError && <div className="pc-alert-detail">{view.orchestratorError}</div>}
        </div>
      )}
      {message && (
        <div className={`pc-alert pc-alert-${message.tone}`} role="status" onClick={() => setMessage(null)}>
          {message.text}
        </div>
      )}

      <div className="pc-grid">
        <div className="pc-col">
          {progress ? (
            <NowPanel
              progress={progress}
              paused={paused}
              busy={busy === 'stop'}
              disabled={orchDown}
              onStop={() => void command('stop', stopScenario, 'Scenario stopped')}
            />
          ) : null}
          <section className="pc-card">
            <h2 className="pc-h2">Scenarios</h2>
            {!orch && <p className="empty">{orchDown ? 'Unavailable while the orchestrator is down.' : 'Loading…'}</p>}
            {orch && orch.scenarios.length === 0 && <p className="empty">No scenarios defined.</p>}
            <div className="pc-scenarios">
              {orch?.scenarios.map((s) => (
                <ScenarioCard
                  key={s.id}
                  info={s}
                  active={orch.activeRun?.scenarioId === s.id}
                  anyRunning={running}
                  busy={busy === `start:${s.id}` || busy === 'stop'}
                  onStart={() => void command(`start:${s.id}`, () => startScenario(s.id), `Started: ${s.title}`)}
                  onStop={() => void command('stop', stopScenario, 'Scenario stopped')}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="pc-col">
          <section className="pc-card" aria-label="Live status">
            <h2 className="pc-h2">Live status</h2>
            <div className="pc-providers">
              {rows.map((r) => (
                <div key={r.providerId} className={`pc-provider tone-${r.tone}`}>
                  <div className="pc-provider-head">
                    <span className="pc-provider-name">{r.name.replace(/^Provider\s+/i, '')}</span>
                    <span className={`pc-pill tone-${r.tone}`}>{r.breaker ? BREAKER_LABEL[r.breaker.state] : '—'}</span>
                  </div>
                  <div className="pc-provider-reason">{breakerSentence(r.breaker)}</div>
                  {r.outage && <div className="pc-outage">⚠ Outage: {outageSentence(r.outage)}</div>}
                </div>
              ))}
            </div>
            {view?.breakerError && <p className="tl-meta">Breaker engine unavailable: {view.breakerError}</p>}
            <div className="pc-kpis">
              <Kpi label="Active outage" value={outages.length === 0 ? 'None' : outages.map((o) => providerName(o.providerId).replace(/^Provider\s+/i, '')).join(', ')} tone={outages.length ? 'bad' : 'ok'} />
              <Kpi label="In flight" value={formatCount(stats?.inFlight)} tone="info" />
              <Kpi label="Reconciled" value={formatCount(stats?.reconciled)} tone="ok" />
              <Kpi
                label="Ledger"
                value={ledger.data ? (ledger.data.balanced ? 'Balanced' : 'Unbalanced') : ledger.error ? 'Unavailable' : '…'}
                tone={ledger.data ? (ledger.data.balanced ? 'ok' : 'bad') : 'dim'}
              />
            </div>
          </section>

          <section className="pc-card" aria-label="Controls">
            <h2 className="pc-h2">Controls</h2>
            <div className="pc-control">
              <span className="pc-label">Ambient traffic</span>
              <div className="pc-seg" role="group" aria-label="Ambient traffic">
                {AMBIENT_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`pc-seg-btn${ambientPreset === p.id ? ' pc-seg-on' : ''}`}
                    aria-pressed={ambientPreset === p.id}
                    disabled={!orch || busy !== null}
                    onClick={() => void command(`ambient:${p.id}`, () => setAmbient(p.rate))}
                  >
                    {p.label}
                    <small>{p.rate}/s</small>
                  </button>
                ))}
              </div>
              {orch && ambientPreset === null && <span className="tl-meta">Custom: {orch.ambient.rate}/s</span>}
            </div>
            <div className="pc-control">
              <span className="pc-label">Pace</span>
              <div className="pc-seg" role="group" aria-label="Pace">
                {PACE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`pc-seg-btn${orch?.pace === p.id ? ' pc-seg-on' : ''}`}
                    aria-pressed={orch?.pace === p.id}
                    disabled={!orch || busy !== null}
                    onClick={() => void command(`pace:${p.id}`, () => setPace(p.id as PacePreset))}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="pc-actions">
              <button
                type="button"
                className={`btn pc-big ${paused ? 'pc-resume' : 'pc-pause'}`}
                disabled={!orch || busy !== null}
                onClick={() => void command('pause', () => setPaused(!paused))}
              >
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <button
                type="button"
                className="btn pc-big pc-explain"
                disabled={!target}
                onClick={() => {
                  if (!target) return;
                  onOpenPayment(target.paymentId);
                  focusPayment(target.paymentId).catch(() => setMessage({ tone: 'bad', text: 'Could not open it on the big screen' }));
                }}
              >
                Jump to explanation
                <small>
                  {target
                    ? `${shortId(target.paymentId)} · ${providerName(target.fromProviderId).replace(/^Provider\s+/i, '')} → ${providerName(target.toProviderId).replace(/^Provider\s+/i, '')}`
                    : 'No re-routed payment yet'}
                </small>
              </button>
              <button type="button" className="btn pc-big pc-quiet" onClick={() => void focusPayment(null).catch(() => undefined)}>
                Close drawer on big screen
              </button>
            </div>
            <div className="pc-reset-row">
              <button
                type="button"
                className="btn pc-big pc-reset"
                disabled={!view?.resetAvailable || reset.phase === 'resetting'}
                onClick={() => dispatchReset({ type: 'ask' })}
              >
                ⟲ RESET DEMO
              </button>
              {view && !view.resetAvailable && (
                <p className="pc-note">
                  Reset is unavailable: this stack was not started with <code>npm start</code> (e.g. Docker). Restart the containers instead.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>

      {reset.phase === 'confirm' && (
        <div className="reset-overlay" role="alertdialog" aria-modal="true" aria-labelledby="reset-q">
          <div className="reset-box">
            <h2 id="reset-q">Reset the demo?</h2>
            <p>Stops all traffic, wipes every payment and the ledger, and restarts all services. Takes about 10 seconds.</p>
            <div className="reset-buttons">
              <button type="button" className="btn pc-big" onClick={() => dispatchReset({ type: 'cancel' })}>
                Cancel
              </button>
              <button type="button" className="btn pc-big pc-reset" onClick={() => void beginReset()}>
                Reset now
              </button>
            </div>
          </div>
        </div>
      )}
      {reset.phase === 'resetting' && (
        <div className="reset-overlay" role="alertdialog" aria-live="assertive" aria-label="Resetting">
          <div className="reset-box">
            <div className="reset-spinner" aria-hidden="true" />
            <h2>Resetting… ({Math.max(0, Math.floor((now - reset.startedAtMs) / 1000))}s)</h2>
            <p>{reset.sawDown ? 'Services are restarting. Reconnecting automatically…' : 'Stopping services and wiping data…'}</p>
          </div>
        </div>
      )}
      {reset.phase === 'back' && (
        <div className="reset-overlay" role="alertdialog" aria-live="assertive" onClick={() => dispatchReset({ type: 'dismiss' })}>
          <div className="reset-box reset-ok">
            <h2>✓ System is back</h2>
            <p>
              Reset took {formatDuration(reset.tookMs)}. Ledger:{' '}
              {ledger.data
                ? ledger.data.balanced
                  ? `balanced (${formatCount(ledger.data.journals)} journals)`
                  : 'UNBALANCED'
                : ledger.error
                  ? 'unavailable'
                  : 'checking…'}
            </p>
            <button type="button" className="btn pc-big" onClick={() => dispatchReset({ type: 'dismiss' })}>
              OK
            </button>
          </div>
        </div>
      )}
      {reset.phase === 'failed' && (
        <div className="reset-overlay" role="alertdialog" aria-live="assertive">
          <div className="reset-box reset-bad">
            <h2>Reset failed</h2>
            <p>{reset.error}</p>
            <div className="reset-buttons">
              <button type="button" className="btn pc-big" onClick={() => dispatchReset({ type: 'dismiss' })}>
                Close
              </button>
              <button type="button" className="btn pc-big pc-reset" onClick={() => void beginReset()}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'bad' | 'warn' | 'info' | 'dim' }) {
  return (
    <div className={`pc-kpi tone-${tone}`}>
      <span className="pc-kpi-value">{value}</span>
      <span className="pc-kpi-label">{label}</span>
    </div>
  );
}

function NowPanel({ progress, paused, busy, disabled, onStop }: { progress: ScenarioProgress; paused: boolean; busy: boolean; disabled: boolean; onStop(): void }) {
  const p = progress;
  return (
    <section className="pc-card pc-now" aria-label="Running scenario">
      <div className="pc-now-head">
        <div>
          <span className="pc-label">Running{paused ? ' · PAUSED' : ''}</span>
          <h2 className="pc-now-title">{p.title}</h2>
        </div>
        <button type="button" className="btn pc-big pc-stop" disabled={busy || disabled} onClick={onStop}>
          ■ Stop
        </button>
      </div>
      <div className="pc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.fraction * 100)}>
        <span className="pc-progress-fill" style={{ width: `${(p.fraction * 100).toFixed(1)}%` }} />
        {p.durationMs > 0 &&
          p.steps.map((s, i) => (
            <span
              key={s.id}
              className={`pc-progress-mark${i <= p.currentIndex ? ' pc-mark-done' : ''}`}
              style={{ left: `${Math.min(100, (s.atMs / p.durationMs) * 100)}%` }}
              title={s.title}
            />
          ))}
      </div>
      <div className="pc-progress-time tl-meta">
        {formatCountdown(p.elapsedMs)}
        {p.durationMs > 0 ? ` / ${formatCountdown(p.durationMs)}` : ''}
      </div>
      <div className="pc-step">
        <span className="pc-label">Now{p.steps.length ? ` · step ${Math.max(1, p.currentIndex + 1)} of ${p.steps.length}` : ''}</span>
        <h3 className="pc-step-title">{p.current?.title ?? 'Starting…'}</h3>
      </div>
      <p className="pc-narration" aria-live="polite">
        {p.narration ?? <span className="tl-meta">(no narration for this step)</span>}
      </p>
      {p.next && (
        <div className="pc-next">
          <span className="pc-next-count">{p.nextInMs !== null ? formatCountdown(p.nextInMs) : ''}</span>
          <span>
            <span className="pc-label">Next</span> {p.next.title}
          </span>
        </div>
      )}
    </section>
  );
}

function ScenarioCard({
  info,
  active,
  anyRunning,
  busy,
  onStart,
  onStop,
}: {
  info: ScenarioInfo;
  active: boolean;
  anyRunning: boolean;
  busy: boolean;
  onStart(): void;
  onStop(): void;
}) {
  return (
    <div className={`pc-scenario${active ? ' pc-scenario-active' : ''}`}>
      <div className="pc-scenario-text">
        <h3>{info.title}</h3>
        <p>{info.description}</p>
        <span className="tl-meta">
          {formatCountdown(info.durationMs)} · {info.steps.length} steps
        </span>
      </div>
      {active ? (
        <button type="button" className="btn pc-big pc-stop" disabled={busy} onClick={onStop}>
          ■ Stop
        </button>
      ) : (
        <button type="button" className="btn pc-big pc-start" disabled={busy || anyRunning} onClick={onStart}>
          ▶ Start
        </button>
      )}
    </div>
  );
}
