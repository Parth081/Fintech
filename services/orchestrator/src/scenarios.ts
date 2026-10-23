// Scenario scripts as typed data: what the presenter sees (ScenarioInfo) plus the actions each step takes.
// Narration is written for a non-technical audience: it is what the presenter can say at that moment.
import type { ScenarioInfo, ScenarioStepInfo } from '@ct/contracts';

export type ScenarioAction =
  | { kind: 'outage.start'; providerId: string; mode: 'down' | 'degraded'; failureRate?: number; reason: string }
  | { kind: 'outage.end'; providerId: string }
  /** Ambient payments per second while the scenario runs (the pre-scenario rate is restored at the end). */
  | { kind: 'ambient.rate'; rate: number };

export interface ScenarioStep extends ScenarioStepInfo {
  actions?: ScenarioAction[];
}

export interface ScenarioScript {
  id: string;
  title: string;
  description: string;
  /** When control.scenario.ended (outcome 'completed') is published, measured from the start. */
  durationMs: number;
  steps: ScenarioStep[];
}

export function scenarioInfo(s: ScenarioScript): ScenarioInfo {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    durationMs: s.durationMs,
    steps: s.steps.map(({ id, atMs, title, narration }) => ({ id, atMs, title, ...(narration !== undefined ? { narration } : {}) })),
  };
}

/** Throws if a script is malformed: steps out of order, past the end, duplicate ids, or an outage left open. */
export function validateScript(s: ScenarioScript): void {
  const ids = new Set<string>();
  let last = -1;
  const open = new Set<string>();
  for (const step of s.steps) {
    if (ids.has(step.id)) throw new Error(`${s.id}: duplicate step id "${step.id}"`);
    ids.add(step.id);
    if (step.atMs < last) throw new Error(`${s.id}: step "${step.id}" is out of order`);
    if (step.atMs > s.durationMs) throw new Error(`${s.id}: step "${step.id}" is after the end`);
    last = step.atMs;
    for (const a of step.actions ?? []) {
      if (a.kind === 'outage.start') open.add(a.providerId);
      if (a.kind === 'outage.end') open.delete(a.providerId);
      if (a.kind === 'ambient.rate' && !(a.rate >= 0 && a.rate <= 50)) throw new Error(`${s.id}: ambient rate ${a.rate} out of range`);
    }
  }
  if (open.size > 0) throw new Error(`${s.id}: outage left open at the end (${[...open].join(', ')})`);
}

/** Ambient rate used during the scenarios: high enough that the breaker sees failures within a few seconds. */
export const SCENARIO_AMBIENT_RATE = 7;

export const PROVIDER_OUTAGE: ScenarioScript = {
  id: 'provider-outage',
  title: 'Provider outage: Orion goes down',
  description:
    'Our busiest payment partner, Orion, stops working in the middle of the day. The circuit breaker notices, traffic moves to Lyra and Vega, Orion is tested carefully when it comes back, and the ledger proves nothing was lost.',
  durationMs: 72_000,
  steps: [
    {
      id: 'baseline',
      atMs: 0,
      title: 'Normal day',
      narration:
        'Payments are flowing normally between the US and India, the UK and the Philippines, and Germany and Brazil. Most of them travel through Provider Orion, our fastest partner.',
      actions: [{ kind: 'ambient.rate', rate: SCENARIO_AMBIENT_RATE }],
    },
    {
      id: 'orion-down',
      atMs: 10_000,
      title: 'Orion goes down',
      narration: 'Orion just failed. Every payment we hand to it is now being refused. Watch the circuit breaker on Orion.',
      actions: [{ kind: 'outage.start', providerId: 'orion', mode: 'down', reason: 'Scenario: Orion is not responding' }],
    },
    {
      id: 'rerouting',
      atMs: 18_000,
      title: 'Breaker trips, traffic re-routes',
      narration:
        'The circuit breaker has tripped. We stop sending payments to Orion and send them through Lyra and Vega instead. Payments Orion refused are retried elsewhere, so customers are not left waiting.',
    },
    {
      id: 'orion-recovers',
      atMs: 35_000,
      title: 'Orion comes back',
      narration: 'Orion is working again. But we do not trust it straight away: one good minute does not make a healthy partner.',
      actions: [{ kind: 'outage.end', providerId: 'orion' }],
    },
    {
      id: 'half-open',
      atMs: 42_000,
      title: 'Testing Orion carefully',
      narration: 'The breaker is now half-open: only a few test payments go to Orion. If they get through, Orion earns its traffic back.',
    },
    {
      id: 'back-to-normal',
      atMs: 55_000,
      title: 'Back to normal',
      narration: 'Orion passed its tests. The breaker has closed and traffic is flowing back to Orion as usual.',
    },
    {
      id: 'summary',
      atMs: 63_000,
      title: 'What the ledger proves',
      narration:
        'Every payment is accounted for. The ledger still balances to the cent: money that left a customer either reached the recipient or was returned. Nothing was lost and nothing was counted twice.',
    },
  ],
};

export const PROVIDER_DEGRADED: ScenarioScript = {
  id: 'provider-degraded',
  title: 'Partial failure: Orion gets unreliable',
  description:
    'Orion does not go down completely; it starts refusing about four in ten payments. The circuit breaker handles partial failure the same way as a full outage.',
  durationMs: 48_000,
  steps: [
    {
      id: 'baseline',
      atMs: 0,
      title: 'Normal day',
      narration: 'Traffic is normal. This time Orion will not fail completely. It will just become unreliable, which is harder to spot.',
      actions: [{ kind: 'ambient.rate', rate: SCENARIO_AMBIENT_RATE }],
    },
    {
      id: 'orion-degraded',
      atMs: 8_000,
      title: 'Orion becomes unreliable',
      narration: 'Orion is now refusing about six in every ten payments. Some still get through, so it does not look completely broken at first glance.',
      actions: [{ kind: 'outage.start', providerId: 'orion', mode: 'degraded', failureRate: 0.6, reason: 'Scenario: Orion is refusing 60% of payments' }],
    },
    {
      id: 'breaker-opens',
      atMs: 16_000,
      title: 'Breaker counts the failures',
      narration:
        'The circuit breaker keeps count. Once too many payments fail, it opens and sends traffic to Lyra and Vega. Refused payments are retried with another partner.',
    },
    {
      id: 'orion-healthy',
      atMs: 30_000,
      title: 'Orion is healthy again',
      narration: 'Orion has recovered. After a few successful test payments it gets its traffic back.',
      actions: [{ kind: 'outage.end', providerId: 'orion' }],
    },
    {
      id: 'summary',
      atMs: 40_000,
      title: 'Partial failure handled',
      narration: 'A partial failure was handled just like a full outage. The ledger balances: every refused payment was retried or returned, never lost.',
    },
  ],
};

export const SCENARIOS: readonly ScenarioScript[] = [PROVIDER_OUTAGE, PROVIDER_DEGRADED];
