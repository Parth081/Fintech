// HTTP / WS control data for the main stage. /api/control/state is new in M3: a 404 (older gateway)
// means "no breaker info", never an error on screen. The same view also arrives on the WebSocket
// ({kind:'control', view}); whichever copy is newer (gateway clock `atMs`) wins.
import { INITIAL_CONTROL_STATE, type BreakerView, type ControlState, type OrchestratorState } from '@ct/contracts/browser';

export interface StageControl {
  /** False when the gateway has no control endpoint (404). */
  available: boolean;
  breakers: BreakerView[];
  control: ControlState;
  orchestrator: OrchestratorState | null;
  /** Gateway clock when the view was computed (0 = unknown). */
  atMs: number;
  /** Routing decisions per provider over the gateway's traffic window (~60 s), null when not reported. */
  traffic: Record<string, number> | null;
}

export const NO_CONTROL: StageControl = { available: false, breakers: [], control: INITIAL_CONTROL_STATE, orchestrator: null, atMs: 0, traffic: null };

const STATES = new Set(['closed', 'open', 'half-open']);

function isBreaker(x: unknown): x is BreakerView {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Record<string, unknown>;
  return typeof b.providerId === 'string' && typeof b.state === 'string' && STATES.has(b.state);
}

const sum = (xs: unknown): number => (Array.isArray(xs) ? xs.reduce((t: number, n) => t + (typeof n === 'number' && Number.isFinite(n) ? n : 0), 0) : 0);

/**
 * Routing decisions per provider from a TrafficView: first attempts + re-routes into the provider,
 * summed over all buckets (the gateway keeps 12 x 5 s = the last minute). null if malformed.
 */
export function parseTraffic(raw: unknown): Record<string, number> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const providers = (raw as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return null;
  const out: Record<string, number> = {};
  for (const p of providers) {
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    if (typeof o.providerId !== 'string') continue;
    out[o.providerId] = sum(o.firstAttempt) + sum(o.rerouted);
  }
  return out;
}

/** Defensive parse of a (Gateway)ControlView: tolerate gaps, never throw. */
export function parseControlView(raw: unknown): StageControl | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const breakers = Array.isArray(o.breakers)
    ? o.breakers.filter(isBreaker).map((b) => ({
        ...b,
        since: typeof b.since === 'string' ? b.since : null,
        failureRate: typeof b.failureRate === 'number' ? b.failureRate : 0,
        attempts: typeof b.attempts === 'number' ? b.attempts : 0,
        reason: typeof b.reason === 'string' ? b.reason : '',
      }))
    : [];
  const c = typeof o.control === 'object' && o.control !== null ? (o.control as Partial<ControlState>) : {};
  const control: ControlState = {
    ...INITIAL_CONTROL_STATE,
    ...c,
    outages: typeof c.outages === 'object' && c.outages !== null ? c.outages : {},
    scenario: c.scenario && typeof c.scenario === 'object' && typeof c.scenario.title === 'string' ? c.scenario : null,
  };
  const orchestrator = typeof o.orchestrator === 'object' && o.orchestrator !== null ? (o.orchestrator as OrchestratorState) : null;
  const atMs = typeof o.atMs === 'number' && Number.isFinite(o.atMs) ? o.atMs : 0;
  return { available: true, breakers, control, orchestrator, atMs, traffic: parseTraffic(o.traffic) };
}

/** The more recent of two control views (by gateway clock; ties and unknown clocks prefer `b`, the later arrival). */
export function newerControl(a: StageControl | null, b: StageControl | null): StageControl | null {
  if (!a) return b;
  if (!b) return a;
  if (a.atMs > 0 && b.atMs > 0 && a.atMs > b.atMs) return a;
  return b;
}

export async function fetchStageControl(signal?: AbortSignal): Promise<StageControl> {
  const res = await fetch('/api/control/state', { signal, headers: { accept: 'application/json' } });
  if (res.status === 404 || res.status === 501) return NO_CONTROL;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseControlView(await res.json().catch(() => null));
  return parsed ?? NO_CONTROL;
}
