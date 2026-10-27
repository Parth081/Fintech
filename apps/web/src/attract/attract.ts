// Attract loop on the screens (pure, unit tested): parse the orchestrator's additive `attract` state, the
// big-screen story card for each beat of the loop, and the presenter's status line.
import type { ControlState, OrchestratorState } from '@ct/contracts/browser';
// Type-only: nothing from the orchestrator ends up in the bundle.
import type { AttractState } from '../../../../services/orchestrator/src/attract';

export type { AttractState };

export const ATTRACT_ID = 'attract';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Defensive parse of OrchestratorState.attract (absent on an older orchestrator -> null). */
export function parseAttract(orch: OrchestratorState | null | undefined): AttractState | null {
  const raw = isObj(orch) ? (orch as unknown as Record<string, unknown>).attract : undefined;
  if (!isObj(raw) || typeof raw.enabled !== 'boolean' || typeof raw.playing !== 'boolean') return null;
  const run = isObj(raw.run) && typeof raw.run.runId === 'string' ? raw.run : null;
  const script = isObj(raw.script) && Array.isArray(raw.script.steps) ? (raw.script as unknown as AttractState['script']) : { id: ATTRACT_ID, title: 'Booth loop', description: '', durationMs: 90_000, steps: [] };
  const lastStop = raw.lastStop === 'disabled' || raw.lastStop === 'touch' || raw.lastStop === 'presenter' || raw.lastStop === 'ended-elsewhere' ? raw.lastStop : null;
  return {
    enabled: raw.enabled,
    playing: raw.playing,
    idleMs: num(raw.idleMs) ?? 0,
    idleForMs: num(raw.idleForMs) ?? 0,
    startsInMs: num(raw.startsInMs),
    cycle: num(raw.cycle) ?? 0,
    run: run
      ? { runId: run.runId as string, startedAt: typeof run.startedAt === 'string' ? run.startedAt : '', elapsedMs: num(run.elapsedMs) ?? 0, stepId: typeof run.stepId === 'string' ? run.stepId : null }
      : null,
    lastStop,
    script,
  };
}

/** True while the attract loop owns the screen (from the log, which every screen sees, or the orchestrator). */
export function attractOnScreen(control: Pick<ControlState, 'scenario'> | null | undefined, attract: AttractState | null): boolean {
  if (control?.scenario) return control.scenario.scenarioId === ATTRACT_ID;
  return attract?.playing === true && attract.run !== null;
}

export type StoryTone = 'calm' | 'alert' | 'recover' | 'ok' | 'invite';

export interface StoryBeat {
  stepId: string;
  /** Big headline (what anyone in the aisle should read in two seconds). */
  headline: string;
  /** One calm supporting line. */
  sub: string;
  tone: StoryTone;
}

/** The story beats, keyed by the loop's step ids (services/orchestrator/src/attract.ts). */
export const STORY_BEATS: readonly StoryBeat[] = [
  { stepId: 'flow', headline: 'Payments flowing across 3 corridors', sub: 'US → India · UK → Philippines · Germany → Brazil, in real time', tone: 'calm' },
  { stepId: 'orion-down', headline: 'Orion just failed', sub: 'Our busiest payment partner stopped answering', tone: 'alert' },
  { stepId: 'rerouted', headline: 'Traffic re-routed — nothing lost', sub: 'The circuit breaker tripped by itself: Lyra and Vega take over', tone: 'recover' },
  { stepId: 'orion-back', headline: 'Orion is back — on probation', sub: 'It earns its traffic back with a few test payments first', tone: 'recover' },
  { stepId: 'recovered', headline: 'Recovered automatically', sub: 'Nobody touched a thing', tone: 'ok' },
  { stepId: 'ledger', headline: 'Ledger still balanced to the cent', sub: 'Debits equal credits: nothing lost, nothing counted twice', tone: 'ok' },
  { stepId: 'invite', headline: 'Your turn: try it yourself', sub: 'Send a payment, break a provider, ask the AI why', tone: 'invite' },
];

export interface StoryCard extends StoryBeat {
  /** 0-based beat index and count (progress dots). */
  index: number;
  count: number;
}

/**
 * The card for the loop's current step. stepId from the log (control.scenario.step) wins, else the
 * orchestrator's run; an unknown step falls back to its title. null when the loop is not on screen.
 */
export function storyCard(
  control: Pick<ControlState, 'scenario'> | null | undefined,
  attract: AttractState | null,
): StoryCard | null {
  if (!attractOnScreen(control, attract)) return null;
  const logStep = control?.scenario?.scenarioId === ATTRACT_ID ? control.scenario.step : undefined;
  const stepId = logStep?.stepId ?? attract?.run?.stepId ?? STORY_BEATS[0]!.stepId;
  const index = STORY_BEATS.findIndex((b) => b.stepId === stepId);
  if (index >= 0) return { ...STORY_BEATS[index]!, index, count: STORY_BEATS.length };
  const title = logStep?.title ?? attract?.script.steps.find((s) => s.id === stepId)?.title ?? 'Live payments';
  return { stepId, headline: title, sub: '', tone: 'calm', index: 0, count: STORY_BEATS.length };
}

/** Show the "Touch the screen" call to action: always while the loop plays (strongest on the last beat). */
export function showCta(card: StoryCard | null): boolean {
  return card !== null;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

export interface AttractStatus {
  tone: 'ok' | 'info' | 'dim' | 'warn';
  label: string;
  detail: string;
}

/** Presenter status line for the attract loop. */
export function attractStatus(a: AttractState | null, presenterRunning: boolean, paused: boolean): AttractStatus {
  if (!a) return { tone: 'dim', label: 'Unavailable', detail: 'This orchestrator has no attract loop.' };
  if (a.playing) {
    const step = a.run?.stepId ? STORY_BEATS.find((b) => b.stepId === a.run!.stepId)?.headline ?? a.run.stepId : 'starting';
    return { tone: 'ok', label: 'Playing', detail: `Cycle ${Math.max(1, a.cycle)} · ${step}. Any command or kiosk touch stops it.` };
  }
  if (!a.enabled) return { tone: 'dim', label: 'Off', detail: 'The big screen will not play the loop by itself.' };
  if (presenterRunning) return { tone: 'info', label: 'Waiting', detail: 'A scenario is running; the loop waits until it ends and the booth goes quiet.' };
  if (paused) return { tone: 'warn', label: 'Waiting', detail: 'The demo is paused.' };
  if (a.startsInMs !== null) return { tone: 'info', label: 'Armed', detail: `Starts by itself in ${clock(a.startsInMs)} if nobody touches anything.` };
  return { tone: 'info', label: 'On', detail: 'Plays when switched on (no idle start configured).' };
}

/** POST /attract {enabled} through the gateway's orchestrator proxy. Resolves with the orchestrator state. */
export async function setAttract(enabled: boolean): Promise<OrchestratorState> {
  return post('/api/control/orchestrator/attract', { enabled });
}

/** POST /attract/touch: someone is at the booth (kiosk interaction). Never throws. */
export async function touchAttract(): Promise<void> {
  try {
    await post('/api/control/orchestrator/attract/touch', {});
  } catch {
    /* best effort */
  }
}

async function post(path: string, body: unknown): Promise<OrchestratorState> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error('Gateway unreachable');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === 'string') msg = b.error;
    } catch {
      /* not JSON */
    }
    throw new Error(res.status === 404 ? 'This orchestrator has no attract loop' : msg);
  }
  return (await res.json()) as OrchestratorState;
}
