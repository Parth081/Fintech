// Pure presenter/control-plane logic (unit tested): scenario progress, breaker wording, presets,
// provider status rows and the reset state machine.
import { PROVIDERS, type BreakerView, type OrchestratorState, type PacePreset, type ProviderOutage, type ScenarioInfo, type ScenarioStepInfo } from '@ct/contracts/browser';
import type { GatewayControlView, Health } from './types';

// ---- presets --------------------------------------------------------------------------

export const AMBIENT_PRESETS = [
  { id: 'off', label: 'Off', rate: 0 },
  { id: 'calm', label: 'Calm', rate: 2 },
  { id: 'busy', label: 'Busy', rate: 8 },
] as const;
export type AmbientPresetId = (typeof AMBIENT_PRESETS)[number]['id'];

/** The preset matching the orchestrator's current rate (null for a custom rate). */
export function ambientPresetFor(ambient: OrchestratorState['ambient'] | undefined): AmbientPresetId | null {
  if (!ambient) return null;
  const rate = ambient.running ? ambient.rate : 0;
  return AMBIENT_PRESETS.find((p) => p.rate === rate)?.id ?? null;
}

export const PACE_PRESETS: readonly { id: PacePreset; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'slow', label: 'Slow-motion' },
  { id: 'fast', label: 'Fast' },
];

// ---- scenario progress ------------------------------------------------------------------

export interface ScenarioProgress {
  scenarioId: string;
  title: string;
  elapsedMs: number;
  durationMs: number;
  /** 0..1 */
  fraction: number;
  steps: ScenarioStepInfo[];
  current: ScenarioStepInfo | null;
  currentIndex: number;
  next: ScenarioStepInfo | null;
  /** Time until the next step, null when there is none. */
  nextInMs: number | null;
  /** What the presenter can say now. */
  narration: string | null;
}

/**
 * Where the active run is now. `elapsedMs` from the orchestrator is extrapolated from the time it
 * was received (frozen while paused) and clamped to the scenario's duration. The current step is
 * the one the orchestrator reports (authoritative), else the last step whose time has passed.
 */
export function scenarioProgress(view: Pick<GatewayControlView, 'orchestrator' | 'control'>, receivedAtMs: number, nowMs: number): ScenarioProgress | null {
  const orch = view.orchestrator;
  const run = orch?.activeRun ?? null;
  const logScenario = view.control.scenario;
  if (!run && !logScenario) return null;
  const scenarioId = run?.scenarioId ?? logScenario!.scenarioId;
  const info: ScenarioInfo | undefined = orch?.scenarios.find((s) => s.id === scenarioId);
  const steps = info ? [...info.steps].sort((a, b) => a.atMs - b.atMs) : [];
  const durationMs = info?.durationMs ?? 0;
  const paused = orch?.paused ?? view.control.paused;
  let elapsed: number;
  if (run) elapsed = run.elapsedMs + (paused ? 0 : Math.max(0, nowMs - receivedAtMs));
  else elapsed = Math.max(0, nowMs - Date.parse(logScenario!.startedAt));
  if (!Number.isFinite(elapsed)) elapsed = 0;
  if (durationMs > 0) elapsed = Math.min(elapsed, durationMs);

  const reportedStepId = run?.stepId ?? (logScenario?.scenarioId === scenarioId ? logScenario.step?.stepId : undefined) ?? null;
  let currentIndex = reportedStepId ? steps.findIndex((s) => s.id === reportedStepId) : -1;
  if (currentIndex < 0) {
    for (let i = 0; i < steps.length; i++) if (steps[i]!.atMs <= elapsed) currentIndex = i;
  }
  let current = currentIndex >= 0 ? steps[currentIndex]! : null;
  // A step only known from the log (orchestrator down or step list missing).
  if (!current && logScenario?.step && logScenario.scenarioId === scenarioId) {
    current = { id: logScenario.step.stepId, atMs: elapsed, title: logScenario.step.title, narration: logScenario.step.narration };
  }
  const next = currentIndex + 1 < steps.length ? steps[currentIndex + 1]! : null;
  const logNarration = logScenario?.step && logScenario.step.stepId === current?.id ? logScenario.step.narration : undefined;
  return {
    scenarioId,
    title: info?.title ?? logScenario?.title ?? scenarioId,
    elapsedMs: elapsed,
    durationMs,
    fraction: durationMs > 0 ? Math.min(1, elapsed / durationMs) : 0,
    steps,
    current,
    currentIndex,
    next,
    nextInMs: next ? Math.max(0, next.atMs - elapsed) : null,
    narration: current?.narration ?? logNarration ?? null,
  };
}

/** Audience banner text: title + current step, never the presenter narration. */
export function bannerFor(view: Pick<GatewayControlView, 'control' | 'orchestrator'> | null): { title: string; step: string | null } | null {
  const s = view?.control.scenario;
  if (!s) return null;
  let step = s.step?.title ?? null;
  if (!step) {
    const run = view?.orchestrator?.activeRun;
    const info = view?.orchestrator?.scenarios.find((x) => x.id === s.scenarioId);
    if (run?.runId === s.runId && run.stepId) step = info?.steps.find((x) => x.id === run.stepId)?.title ?? null;
  }
  return { title: s.title, step };
}

// ---- breakers / providers -----------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'dim';

export const BREAKER_LABEL: Record<BreakerView['state'], string> = { closed: 'Closed', open: 'Open', 'half-open': 'Half-open' };

export function breakerTone(state: BreakerView['state'] | undefined): Tone {
  if (state === 'open') return 'bad';
  if (state === 'half-open') return 'warn';
  if (state === 'closed') return 'ok';
  return 'dim';
}

/** One plain-English line for a breaker. */
export function breakerSentence(b: BreakerView | undefined): string {
  if (!b) return 'No breaker data yet';
  const base =
    b.state === 'open'
      ? 'Tripped: traffic is routed around this provider'
      : b.state === 'half-open'
        ? 'Testing recovery with a few probe payments'
        : 'Healthy: taking traffic';
  // The breaker engine already writes a plain-English reason; fall back to a generic line.
  return b.reason.trim() ? b.reason : base;
}

export interface ProviderStatusRow {
  providerId: string;
  name: string;
  breaker?: BreakerView;
  outage?: ProviderOutage;
  tone: Tone;
}

/** Known providers first (catalogue order), then any others the breakers or outages mention. */
export function providerStatusRows(view: Pick<GatewayControlView, 'breakers' | 'control'> | null): ProviderStatusRow[] {
  const ids: string[] = PROVIDERS.map((p) => p.id);
  for (const b of view?.breakers ?? []) if (!ids.includes(b.providerId)) ids.push(b.providerId);
  for (const id of Object.keys(view?.control.outages ?? {})) if (!ids.includes(id)) ids.push(id);
  return ids.map((providerId) => {
    const breaker = view?.breakers.find((b) => b.providerId === providerId);
    const outage = view?.control.outages[providerId];
    const tone: Tone = breaker ? breakerTone(breaker.state) : outage ? 'bad' : 'dim';
    const row: ProviderStatusRow = { providerId, name: PROVIDERS.find((p) => p.id === providerId)?.name ?? providerId, tone };
    if (breaker) row.breaker = breaker;
    if (outage) row.outage = outage;
    return row;
  });
}

export function outageSentence(o: ProviderOutage): string {
  const mode = o.mode === 'down' ? 'down (rejects everything)' : `degraded (${Math.round((o.failureRate ?? 0) * 100)}% rejected)`;
  return `${mode}${o.reason ? `: ${o.reason}` : ''}`;
}

/** Most recent payment re-routed away from a provider that failed it (null if none yet). */
export function explanationTarget(view: Pick<GatewayControlView, 'reroutes'> | null): GatewayControlView['reroutes'][number] | null {
  return view?.reroutes[0] ?? null;
}

// ---- reset state machine ------------------------------------------------------------------

export const RESET_GIVE_UP_MS = 60_000;

export type ResetState =
  | { phase: 'idle' }
  | { phase: 'confirm' }
  | { phase: 'resetting'; startedAtMs: number; beforeInstance: string | null; sawDown: boolean; postOk: boolean }
  | { phase: 'back'; startedAtMs: number; tookMs: number }
  | { phase: 'failed'; error: string };

export type ResetEvent =
  | { type: 'ask' }
  | { type: 'cancel' }
  | { type: 'start'; nowMs: number; beforeInstance: string | null }
  /** The POST finished. ok=false with an HTTP status = the gateway answered with an error (e.g. 503). */
  | { type: 'post'; ok: boolean; status?: number; error?: string }
  /** A /health poll: null = gateway unreachable. */
  | { type: 'health'; health: Health | null; nowMs: number }
  | { type: 'dismiss' };

export function resetReducer(state: ResetState, ev: ResetEvent): ResetState {
  switch (ev.type) {
    case 'ask':
      return state.phase === 'resetting' ? state : { phase: 'confirm' };
    case 'cancel':
      return state.phase === 'confirm' ? { phase: 'idle' } : state;
    case 'start':
      return { phase: 'resetting', startedAtMs: ev.nowMs, beforeInstance: ev.beforeInstance, sawDown: false, postOk: false };
    case 'post':
      if (state.phase !== 'resetting') return state;
      if (ev.ok) return { ...state, postOk: true };
      // An answer from the gateway with an error status: the reset did not happen.
      if (ev.status !== undefined && ev.status > 0) return { phase: 'failed', error: ev.error ?? `HTTP ${ev.status}` };
      // Network error: expected when the launcher restarts the gateway mid-request. Keep waiting.
      return state;
    case 'health': {
      if (state.phase !== 'resetting') return state;
      const h = ev.health;
      if (!h) {
        if (ev.nowMs - state.startedAtMs > RESET_GIVE_UP_MS) return { phase: 'failed', error: 'The system did not come back within 60 s' };
        return { ...state, sawDown: true };
      }
      const restarted = state.beforeInstance !== null && h.instanceId !== undefined && h.instanceId !== state.beforeInstance;
      if (h.replayed && (restarted || state.sawDown || state.postOk)) {
        return { phase: 'back', startedAtMs: state.startedAtMs, tookMs: ev.nowMs - state.startedAtMs };
      }
      if (ev.nowMs - state.startedAtMs > RESET_GIVE_UP_MS) return { phase: 'failed', error: 'The system did not come back within 60 s' };
      return state;
    }
    case 'dismiss':
      return state.phase === 'back' || state.phase === 'failed' ? { phase: 'idle' } : state;
    default:
      return state;
  }
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}
