// Control events (M3): scenario and demo controls that travel on the SAME ordered log as payment events,
// so every service sees an outage at exactly the same point relative to the payments it affects.
// Replays and restarts therefore make identical decisions.
import { SCHEMA_VERSION } from './events';
import type { AnyEvent } from './events';

/** Control events use this fixed id in the paymentId field (the broker and Kafka key by paymentId). */
export const CONTROL_STREAM_ID = '__control__' as const;

export type ControlProducer = 'orchestrator' | 'presenter';

export interface ControlPayloadMap {
  /** A provider stops working. 'down' = rejects every instruction; 'degraded' = rejects with failureRate. */
  'control.provider_outage.started': { providerId: string; mode: 'down' | 'degraded'; failureRate?: number; reason: string; runId?: string };
  'control.provider_outage.ended': { providerId: string; runId?: string };
  /** A scripted scenario run (e.g. "provider-outage") starts, reaches a named step, or ends. */
  'control.scenario.started': { runId: string; scenarioId: string; title: string; seed: string };
  'control.scenario.step': { runId: string; scenarioId: string; stepId: string; title: string; narration?: string };
  'control.scenario.ended': { runId: string; scenarioId: string; outcome: 'completed' | 'stopped' };
  /** Presentation pacing. Changes delays only, never decisions. null = back to the process defaults. */
  'control.demo.speed': { stageDelayMs: number | null; settlementDelayMs: number | null; label: string };
  'control.demo.paused': { paused: boolean };
}

export type ControlEventType = keyof ControlPayloadMap;

export const CONTROL_EVENT_TYPES: readonly ControlEventType[] = [
  'control.provider_outage.started',
  'control.provider_outage.ended',
  'control.scenario.started',
  'control.scenario.step',
  'control.scenario.ended',
  'control.demo.speed',
  'control.demo.paused',
];

export interface ControlEnvelope<T extends ControlEventType = ControlEventType> {
  eventId: string;
  type: T;
  schemaVersion: typeof SCHEMA_VERSION;
  paymentId: typeof CONTROL_STREAM_ID;
  occurredAt: string;
  producer: ControlProducer;
  payload: ControlPayloadMap[T];
}

export type ControlEvent = { [K in ControlEventType]: ControlEnvelope<K> }[ControlEventType];

/** Everything that travels on the event log. */
export type BusEvent = AnyEvent | ControlEvent;

export function isControlEvent(e: { type: string }): e is ControlEvent {
  return e.type.startsWith('control.');
}

export function makeControlEvent<T extends ControlEventType>(
  type: T,
  payload: ControlPayloadMap[T],
  opts: { eventId: string; occurredAt: string; producer: ControlProducer },
): ControlEnvelope<T> {
  return { eventId: opts.eventId, type, schemaVersion: SCHEMA_VERSION, paymentId: CONTROL_STREAM_ID, occurredAt: opts.occurredAt, producer: opts.producer, payload };
}

// ---------------------------------------------------------------------------------------------
// Control state: a pure fold over control events in log order.

export interface ProviderOutage {
  providerId: string;
  mode: 'down' | 'degraded';
  failureRate?: number;
  reason: string;
  since: string; // occurredAt of the start event
  runId?: string;
}

export interface ControlState {
  outages: Readonly<Record<string, ProviderOutage>>;
  scenario: { runId: string; scenarioId: string; title: string; startedAt: string; step?: { stepId: string; title: string; narration?: string; at: string } } | null;
  speed: { stageDelayMs: number | null; settlementDelayMs: number | null; label: string } | null;
  paused: boolean;
  /** Offset of the last control event applied (-1 = none). */
  lastOffset: number;
}

export const INITIAL_CONTROL_STATE: ControlState = { outages: {}, scenario: null, speed: null, paused: false, lastOffset: -1 };

export function applyControl(state: ControlState, e: ControlEvent, offset: number): ControlState {
  const next: ControlState = { ...state, lastOffset: offset };
  switch (e.type) {
    case 'control.provider_outage.started':
      return { ...next, outages: { ...state.outages, [e.payload.providerId]: { ...e.payload, since: e.occurredAt } } };
    case 'control.provider_outage.ended': {
      const { [e.payload.providerId]: _gone, ...rest } = state.outages;
      return { ...next, outages: rest };
    }
    case 'control.scenario.started':
      return { ...next, scenario: { runId: e.payload.runId, scenarioId: e.payload.scenarioId, title: e.payload.title, startedAt: e.occurredAt } };
    case 'control.scenario.step':
      if (!state.scenario || state.scenario.runId !== e.payload.runId) return next;
      return { ...next, scenario: { ...state.scenario, step: { stepId: e.payload.stepId, title: e.payload.title, narration: e.payload.narration, at: e.occurredAt } } };
    case 'control.scenario.ended':
      return state.scenario?.runId === e.payload.runId ? { ...next, scenario: null } : next;
    case 'control.demo.speed':
      return { ...next, speed: e.payload.stageDelayMs === null && e.payload.settlementDelayMs === null ? null : e.payload };
    case 'control.demo.paused':
      return { ...next, paused: e.payload.paused };
    default:
      return next;
  }
}

/**
 * Control state as of a log offset: folds only control events strictly BEFORE `offset`. Steps use this
 * with their trigger's offset, so a decision never depends on a control event published after the trigger
 * (which a live run would not have seen) — live runs and replays decide identically.
 */
export class ControlTimeline {
  private readonly entries: { offset: number; event: ControlEvent }[] = [];
  private latest: ControlState = INITIAL_CONTROL_STATE;

  apply(event: ControlEvent, offset: number): void {
    if (this.entries.some((x) => x.event.eventId === event.eventId)) return;
    this.entries.push({ offset, event });
    this.entries.sort((a, b) => a.offset - b.offset);
    this.latest = this.entries.reduce((s, x) => applyControl(s, x.event, x.offset), INITIAL_CONTROL_STATE);
  }

  /** State including every control event applied so far (for pacing and display). */
  current(): ControlState {
    return this.latest;
  }

  /** State from control events with offset < `offset`. */
  at(offset: number): ControlState {
    let s = INITIAL_CONTROL_STATE;
    for (const x of this.entries) {
      if (x.offset >= offset) break;
      s = applyControl(s, x.event, x.offset);
    }
    return s;
  }
}
