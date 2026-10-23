// Generic stage runner. Restart- and redelivery-safe:
// - a local projection of every payment is rebuilt from an EPHEMERAL subscription (from earliest);
// - triggers arrive through a NON-ephemeral group subscription (group = stage name), so committed
//   offsets survive restarts;
// - before acting on a delivered trigger the runner waits until the projection has applied at least
//   that offset, and acts only if the projected state shows the produced step has not happened yet;
// - produced eventIds are deterministic (trigger eventId + stage + type), so even a racing
//   duplicate would be dropped by the state machine.
import { performance } from 'node:perf_hooks';
import {
  canApply,
  deterministicId,
  isControlEvent,
  type BusEvent,
  SCHEMA_VERSION,
  type AnyEvent,
  type PaymentState,
} from '@ct/contracts';
import type { DeliveryMeta, EventBus, Subscription } from '@ct/event-bus';
import { Projection, StoppedError } from './projection';
import { RULE_VERSION, STAGE_NAMES, STAGE_STEPS, type Outcome, type PipelineStage, type StageServices, type Step } from './steps';

export interface StageOptions {
  bus: EventBus;
  /** Artificial delay before acting (measured from the trigger's occurredAt). 0 in tests. */
  stageDelayMs?: number;
  /** Delay between payment.sent and payment.settled. */
  settlementDelayMs?: number;
  /** Fallback only: quiet period used when the bus cannot report head(). */
  catchUpQuietMs?: number;
  /** Services injected into steps (ledger store, simulation settings...). */
  services?: StageServices;
  log?: (line: string) => void;
}

export interface StageHandle {
  stop(): Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new StoppedError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StoppedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function buildEvent(stage: PipelineStage, trigger: AnyEvent, outcome: Outcome, now: string, latencyMs: number): AnyEvent {
  return {
    eventId: deterministicId(trigger.eventId, stage, outcome.type),
    type: outcome.type,
    schemaVersion: SCHEMA_VERSION,
    paymentId: trigger.paymentId,
    occurredAt: now,
    correlationId: trigger.paymentId,
    causationId: trigger.eventId,
    producer: stage,
    payload: outcome.payload,
    trace: {
      stage,
      decision: outcome.decision,
      reasonCodes: outcome.reasonCodes,
      inputs: outcome.inputs,
      ruleVersion: outcome.ruleVersion ?? RULE_VERSION,
      latencyMs,
    },
  } as AnyEvent;
}

export async function startStage(name: PipelineStage, options: StageOptions): Promise<StageHandle> {
  const steps = STAGE_STEPS[name];
  if (!steps) throw new Error(`unknown stage "${name}"`);
  const { bus } = options;
  const stageDelayMs = options.stageDelayMs ?? 0;
  const settlementDelayMs = options.settlementDelayMs ?? 0;
  const log = options.log ?? (() => {});
  const projection = new Projection();
  const abort = new AbortController();
  const published = new Set<string>();

  /** The event this step would produce now, if (and only if) it is a valid, not-yet-done transition. */
  const services = options.services ?? {};
  const plan = async (step: Step, trigger: AnyEvent, offset: number, state: PaymentState | undefined) => {
    if (!state || !state.history.some((h) => h.eventId === trigger.eventId)) return null; // trigger itself was invalid
    const now = new Date().toISOString();
    const t0 = performance.now();
    const control = projection.control.at(offset); // only control events before the trigger
    const outcome = await step.produce(trigger, state, { now, services, view: { states: projection.states }, control });
    if (!outcome) return null;
    const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
    const event = buildEvent(name, trigger, outcome, now, latencyMs);
    if (published.has(event.eventId)) return null;
    if (state.history.some((h) => h.eventId === event.eventId)) return null; // already happened
    if (!canApply(state, event)) return null; // payment moved on (or step not applicable): never publish invalid transitions
    return event;
  };

  /** Presenter pause (control.demo.paused): hold before acting; never changes what is decided. */
  const waitWhilePaused = async () => {
    while (projection.control.current().paused) await abortableSleep(100, abort.signal);
  };

  const handle = async (event: BusEvent, meta: DeliveryMeta) => {
    if (isControlEvent(event)) return; // control events are read through the projection
    const trigger = event;
    const relevant = steps.filter((s) => s.trigger === trigger.type);
    if (relevant.length === 0) return;
    await projection.waitFor(meta.offset);
    for (const step of relevant) {
      if (!(await plan(step, trigger, meta.offset, projection.states.get(trigger.paymentId)))) continue; // idempotent by contract
      const speed = projection.control.current().speed; // presenter pacing overrides the process defaults
      const delay = step.delay === 'settlement' ? speed?.settlementDelayMs ?? settlementDelayMs : speed?.stageDelayMs ?? stageDelayMs;
      const triggeredAt = Date.parse(trigger.occurredAt);
      const wait = Number.isFinite(triggeredAt) ? Math.min(delay, triggeredAt + delay - Date.now()) : delay;
      await abortableSleep(wait, abort.signal);
      if (abort.signal.aborted) throw new StoppedError();
      await waitWhilePaused();
      const event = await plan(step, trigger, meta.offset, projection.states.get(trigger.paymentId)); // re-check after the delay
      if (!event) continue;
      await options.bus.publish(event);
      published.add(event.eventId);
      log(`[${name}] ${trigger.type} -> ${event.type} payment=${event.paymentId}`);
    }
  };

  let projectionSub: Subscription | undefined;
  let triggerSub: Subscription | undefined;
  try {
    projectionSub = await bus.subscribe(
      { group: `${name}-projection-${process.pid}-${Math.random().toString(36).slice(2, 10)}`, from: 'earliest', ephemeral: true },
      (event, meta) => projection.apply(event, meta.offset),
    );
    // Catch up to the end of the log before acting on any trigger, so a restarted stage never re-acts
    // on a trigger whose output is already in the log.
    let head: number | undefined;
    try {
      head = await bus.head();
    } catch {
      head = undefined; // bus without head(): fall back to a quiet-period heuristic
    }
    if (head === undefined) await projection.settle(options.catchUpQuietMs ?? 100);
    else if (head > 0) await projection.waitFor(head - 1);
    triggerSub = await bus.subscribe({ group: name, from: 'earliest' }, async (event, meta) => {
      try {
        await handle(event, meta);
      } catch (err) {
        if (!(err instanceof StoppedError)) log(`[${name}] error handling ${event.type} ${event.eventId}: ${(err as Error).message}`);
        throw err; // not committed; the bus redelivers
      }
    });
  } catch (err) {
    abort.abort();
    projection.stop();
    await projectionSub?.unsubscribe();
    throw err;
  }

  let stopping: Promise<void> | undefined;
  return {
    stop: () =>
      (stopping ??= (async () => {
        abort.abort();
        projection.stop();
        await triggerSub?.unsubscribe();
        await projectionSub?.unsubscribe();
      })()),
  };
}

export async function startAllStages(options: StageOptions): Promise<StageHandle> {
  const handles = await Promise.all(STAGE_NAMES.map((n) => startStage(n, options)));
  return {
    stop: async () => {
      await Promise.all(handles.map((h) => h.stop()));
    },
  };
}
