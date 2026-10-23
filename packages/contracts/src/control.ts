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
  /**
   * M4: an approved configuration change (maker-checker in the ops console). Stages read the config as of
   * the trigger's position in the log, exactly like outages, so changes apply deterministically.
   */
  'control.config.updated': { key: ConfigKey; value: unknown; version: number; changeRequestId: string; actor: { userId: string; name: string; role: string }; approvedBy?: { userId: string; name: string; role: string } };
  /** M4: an FX market shock (the currency-spike scenario). Applied by the FX stage via @ct/market shocks. */
  'control.fx_shock.started': { shockId: string; corridorId: string; driftBps: number; noiseMultiplier: number; rampMs: number; reason: string; runId?: string };
  'control.fx_shock.ended': { shockId: string; runId?: string };
}

/**
 * M4 configuration keys and their value shapes. Defaults live in DEFAULT_CONFIG; a stage that reads a key
 * gets the latest approved value before its trigger, else the default.
 */
export interface ConfigValues {
  /** Decision engine: combined risk score thresholds (0..1). >= hold -> held for review; >= reject -> rejected. */
  'risk.thresholds': { hold: number; reject: number };
  /** Payments at or above this amount (in USD-equivalent major units) always need review. 0 = off. */
  'risk.manualReviewAboveUsd': number;
  /** Routing weights (sum need not be 1; normalised by the router). */
  'routing.weights': { success: number; cost: number; speed: number };
  /** Provider switched off by an operator (never routed to while false). */
  'provider.enabled': Record<string, boolean>;
  /** Operator-forced breaker state, overriding the automatic one. null/absent = automatic. */
  'provider.forcedBreaker': Record<string, 'open' | null>;
}
export type ConfigKey = keyof ConfigValues;

export const DEFAULT_CONFIG: ConfigValues = {
  'risk.thresholds': { hold: 0.7, reject: 0.92 },
  'risk.manualReviewAboveUsd': 25_000,
  'routing.weights': { success: 0.5, cost: 0.3, speed: 0.2 },
  'provider.enabled': { orion: true, lyra: true, vega: true },
  'provider.forcedBreaker': {},
};

export type ControlEventType = keyof ControlPayloadMap;

export const CONTROL_EVENT_TYPES: readonly ControlEventType[] = [
  'control.provider_outage.started',
  'control.provider_outage.ended',
  'control.scenario.started',
  'control.scenario.step',
  'control.scenario.ended',
  'control.demo.speed',
  'control.demo.paused',
  'control.config.updated',
  'control.fx_shock.started',
  'control.fx_shock.ended',
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
  /** M4: effective configuration (defaults overlaid with approved updates) and versions per key. */
  config: ConfigValues;
  configVersions: Partial<Record<ConfigKey, number>>;
  /** M4: active FX shocks by shockId. */
  fxShocks: Readonly<Record<string, { shockId: string; corridorId: string; driftBps: number; noiseMultiplier: number; rampMs: number; reason: string; since: string }>>;
  /** Offset of the last control event applied (-1 = none). */
  lastOffset: number;
}

export const INITIAL_CONTROL_STATE: ControlState = { outages: {}, scenario: null, speed: null, paused: false, config: DEFAULT_CONFIG, configVersions: {}, fxShocks: {}, lastOffset: -1 };

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
    case 'control.config.updated': {
      const prevVersion = state.configVersions[e.payload.key] ?? 0;
      if (e.payload.version <= prevVersion) return next; // stale or duplicate update
      return {
        ...next,
        config: { ...state.config, [e.payload.key]: e.payload.value } as ConfigValues,
        configVersions: { ...state.configVersions, [e.payload.key]: e.payload.version },
      };
    }
    case 'control.fx_shock.started':
      return { ...next, fxShocks: { ...state.fxShocks, [e.payload.shockId]: { ...e.payload, since: e.occurredAt } } };
    case 'control.fx_shock.ended': {
      const { [e.payload.shockId]: _gone, ...rest } = state.fxShocks;
      return { ...next, fxShocks: rest };
    }
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
