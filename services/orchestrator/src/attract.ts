// M5 attract loop: what the big screen plays by itself when nobody is touching anything. A condensed
// provider-outage story (calm traffic -> Orion fails -> traffic re-routed -> Orion recovers -> ledger
// balanced -> invitation to try it) that repeats every 90 s. It runs through the same scenario engine as
// the presenter scenarios (same control events, deterministic ids), under the scenario id "attract".
// Pure data + types: no node imports (the web tests import the step ids).
import type { OrchestratorState, ScenarioInfo } from '@ct/contracts';
import { SCENARIO_AMBIENT_RATE, type ScenarioScript } from './scenarios';

export const ATTRACT_SCENARIO_ID = 'attract' as const;

/** Default idle time before the loop starts by itself (CLI; env ATTRACT_IDLE_MS, 0 = never automatically). */
export const DEFAULT_ATTRACT_IDLE_MS = 120_000;

export const ATTRACT_LOOP: ScenarioScript = {
  id: ATTRACT_SCENARIO_ID,
  title: 'Booth loop: an outage, handled by itself',
  description:
    'Plays by itself when nobody is using the demo: calm traffic, Orion fails, traffic re-routes, Orion recovers, and the ledger still balances. Repeats every 90 seconds.',
  durationMs: 90_000,
  steps: [
    {
      id: 'flow',
      atMs: 0,
      title: 'Payments flowing across 3 corridors',
      narration: 'Real-time cross-border payments: US to India, UK to the Philippines, Germany to Brazil. Most go through Orion, our fastest partner.',
      actions: [{ kind: 'ambient.rate', rate: SCENARIO_AMBIENT_RATE }],
    },
    {
      id: 'orion-down',
      atMs: 14_000,
      title: 'Orion just failed',
      narration: 'Our busiest payment partner stopped answering. Every payment handed to it is refused.',
      actions: [{ kind: 'outage.start', providerId: 'orion', mode: 'down', reason: 'Booth loop: Orion is not responding' }],
    },
    {
      id: 'rerouted',
      atMs: 22_000,
      title: 'Traffic re-routed — nothing lost',
      narration: 'The circuit breaker tripped on its own. Payments now go through Lyra and Vega, and refused ones are retried elsewhere.',
    },
    {
      id: 'orion-back',
      atMs: 38_000,
      title: 'Orion is back — on probation',
      narration: 'Orion works again, but it has to earn its traffic back: only a few test payments go to it at first.',
      actions: [{ kind: 'outage.end', providerId: 'orion' }],
    },
    {
      id: 'recovered',
      atMs: 58_000,
      title: 'Recovered automatically',
      narration: 'Orion passed its tests and traffic is flowing back. Nobody had to touch anything.',
    },
    {
      id: 'ledger',
      atMs: 68_000,
      title: 'Ledger still balanced to the cent',
      narration: 'Every payment is accounted for: debits equal credits. Nothing was lost and nothing was counted twice.',
    },
    {
      id: 'invite',
      atMs: 80_000,
      title: 'Your turn: try it yourself',
      narration: 'Send a payment, break a provider, and ask the AI why it happened.',
    },
  ],
};

/** Attract-mode part of GET /state (additive field `attract` on OrchestratorState). */
export interface AttractState {
  /** Loop allowed: it is playing, or will start by itself after `idleMs` without activity. */
  enabled: boolean;
  /** The loop is on screen now (a cycle is running or the next one is about to start). */
  playing: boolean;
  /** Idle time before the loop starts by itself (0 = only when enabled by hand). */
  idleMs: number;
  /** Time since the last presenter command, kiosk touch or presenter scenario end. */
  idleForMs: number;
  /** When the loop will start by itself (null = it will not, e.g. disabled, playing, scenario running, paused). */
  startsInMs: number | null;
  /** Cycles started since the loop last began playing (1 during the first). */
  cycle: number;
  run: { runId: string; startedAt: string; elapsedMs: number; stepId: string | null } | null;
  /** Why the loop last stopped. */
  lastStop: 'disabled' | 'touch' | 'presenter' | 'ended-elsewhere' | null;
  script: ScenarioInfo;
}

/** GET /state as served since M5: the contract's OrchestratorState plus `attract` (additive). */
export interface OrchestratorStateWithAttract extends OrchestratorState {
  attract: AttractState;
}

/** Idle time from the environment value ATTRACT_IDLE_MS (ms; 0 = never by itself). Invalid -> default. */
export function attractIdleFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTRACT_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_ATTRACT_IDLE_MS;
}
