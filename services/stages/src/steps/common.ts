// Shared types for pipeline steps. Each stage lives in its own file in this folder.
import { deterministicId, type AnyEvent, type ControlState, type EventType, type PayloadMap, type PaymentState, type StageName } from '@ct/contracts';

export const RULE_VERSION = 'stub-v1';

export type PipelineStage = Exclude<StageName, 'payment-api' | 'ops'>;

export const STAGE_NAMES: readonly PipelineStage[] = [
  'screening',
  'risk',
  'fx',
  'routing',
  'settlement',
  'ledger',
  'reconciliation',
];

export function isStageName(value: string): value is PipelineStage {
  return (STAGE_NAMES as readonly string[]).includes(value);
}

/** What a step decided. The runner wraps it into an envelope with ids, trace and timing. */
export type Outcome = {
  [K in EventType]: {
    type: K;
    payload: PayloadMap[K];
    decision: string;
    reasonCodes: string[];
    inputs: Record<string, unknown>;
    /** Overrides RULE_VERSION in the trace (e.g. "fx-engine-v2"). */
    ruleVersion?: string;
  };
}[EventType];

/**
 * Services a step may need, injected by the process that runs it (CLI or tests). Each is optional;
 * a step that needs a missing service throws a clear error. Owners add fields here as M2 lands.
 */
export interface StageServices {
  /** Posts a journal idempotently (ledger service). See services/ledger. */
  ledger?: {
    postSettlement(input: { paymentId: string; causationEventId: string; state: PaymentState }): Promise<{
      journalId: string;
      entries: PayloadMap['ledger.posted']['entries'];
    }>;
    /** M4: post the refund (reversal) journal for a refund_requested payment, idempotent per payment. */
    postRefund?(input: { paymentId: string; causationEventId: string; state: PaymentState }): Promise<{
      journalId: string;
      entries: PayloadMap['payment.refunded']['entries'];
    }>;
  };
  /** Simulation seed and failure scaling (from serviceConfig). */
  sim?: { seed: string; providerFailureScale: number };
}

export interface StepContext {
  /** occurredAt the produced event will carry (ISO). */
  now: string;
  services: StageServices;
  /** Read-only view of every projected payment (e.g. for provider health). Do not mutate. */
  view: {
    states: ReadonlyMap<string, PaymentState>;
    /**
     * M4: log offset of a payment event the projection applied (undefined if unknown). Lets a step bound
     * "history before the trigger" by log position, which is identical on every replay. Optional so unit
     * tests can build a context by hand.
     */
    offsetOf?(eventId: string): number | undefined;
  };
  /**
   * Control state (provider outages, scenario) as of the trigger's position in the log: only control
   * events published BEFORE the trigger count, so live runs and replays decide identically. (M3)
   */
  control: ControlState;
  /**
   * M4: control state as of an arbitrary earlier log offset (control events strictly before it). Used by
   * multi-event decisions (the risk stage's alert chain) to keep reading the configuration as of the
   * FIRST trigger of the chain. Optional (falls back to `control`).
   */
  controlAt?(offset: number): ControlState;
}

export interface Step {
  trigger: EventType;
  /** Which configured delay to wait before acting. */
  delay: 'stage' | 'settlement';
  /**
   * Decide what to produce. May be async. Must be idempotent: called again for the same trigger
   * (after a restart or redelivery) it must return the same outcome, and any side effect it performs
   * (e.g. a ledger insert) must not happen twice.
   */
  produce(trigger: AnyEvent, state: PaymentState, ctx: StepContext): Outcome | null | Promise<Outcome | null>;
}

export const shortRef = (...parts: string[]) => deterministicId(...parts).replace(/-/g, '').slice(0, 12).toUpperCase();
