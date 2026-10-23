// M3: HTTP APIs used by the presenter console. Shared by orchestrator, launcher, gateway and UI.
import type { ControlState } from './control';

/** One provider's circuit breaker as the screens show it. Computed by @ct/market breakerStates(). */
export interface BreakerView {
  providerId: string;
  state: 'closed' | 'open' | 'half-open';
  /** ISO time the breaker entered this state (null if never tripped). */
  since: string | null;
  /** Failure rate over the breaker's window (0..1) and how many attempts it saw. */
  failureRate: number;
  attempts: number;
  /** Plain-English reason, e.g. "5 of the last 6 instructions rejected". */
  reason: string;
}

export interface ScenarioStepInfo {
  id: string;
  atMs: number; // offset from scenario start
  title: string;
  narration?: string; // what the presenter can say at this moment
}

export interface ScenarioInfo {
  id: string; // e.g. "provider-outage"
  title: string;
  description: string;
  durationMs: number;
  steps: ScenarioStepInfo[];
}

export type PacePreset = 'normal' | 'slow' | 'fast';

export interface OrchestratorState {
  ambient: { rate: number; running: boolean; sent: number };
  pace: PacePreset;
  paused: boolean;
  scenarios: ScenarioInfo[];
  activeRun: { runId: string; scenarioId: string; startedAt: string; elapsedMs: number; stepId: string | null } | null;
}

/**
 * Orchestrator (default http://127.0.0.1:7074):
 *   GET  /health                       -> { ok: true }
 *   GET  /state                        -> OrchestratorState
 *   POST /scenarios/:id/start {seed?}  -> { runId }          409 if a run is active
 *   POST /scenarios/stop               -> { stopped: boolean }
 *   POST /ambient { rate }             -> OrchestratorState   (payments/second, 0..50)
 *   POST /pace { preset }              -> OrchestratorState   (publishes control.demo.speed)
 *   POST /pause { paused }             -> OrchestratorState   (publishes control.demo.paused)
 *
 * Launcher control (http://127.0.0.1:7079, only when started by `npm start`):
 *   GET  /status                       -> { services: { name, running }[], startedAt }
 *   POST /reset                        -> { ok: true, durationMs }   stops everything, wipes data, starts again
 *
 * Gateway (http://127.0.0.1:7072) adds for the UI:
 *   GET  /api/control/state            -> ControlView
 *   *    /api/control/orchestrator/*   -> proxied to the orchestrator
 *   POST /api/control/reset            -> proxied to the launcher (503 when LAUNCHER_CONTROL_URL is empty)
 */
export interface ControlView {
  control: ControlState; // from the event log
  breakers: BreakerView[];
  orchestrator: OrchestratorState | null; // null when the orchestrator is unreachable
  resetAvailable: boolean;
}
