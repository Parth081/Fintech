// The assistant's read model: folds the ordered log (payment + control events) into payment states with
// each payment's recorded events (and their decision traces), plus the control timeline and scenario runs.
// Pure in-memory, rebuilt from the earliest offset on every start (ephemeral subscription).
import {
  applyEvent,
  isControlEvent,
  type AnyEvent,
  type BusEvent,
  type ControlEnvelope,
  type ControlEvent,
  type PaymentState,
} from '@ct/contracts';

/** Same cap as the gateway projection: a runaway retry loop cannot grow memory without bound. */
export const MAX_EVENTS_PER_PAYMENT = 64;

export interface LoggedEvent<E> {
  offset: number;
  event: E;
}

export interface PaymentRecord {
  state: PaymentState;
  events: LoggedEvent<AnyEvent>[];
  firstOffset: number;
}

export interface ScenarioRun {
  runId: string;
  scenarioId: string;
  title: string;
  started: LoggedEvent<ControlEnvelope<'control.scenario.started'>>;
  steps: LoggedEvent<ControlEnvelope<'control.scenario.step'>>[];
  ended?: LoggedEvent<ControlEnvelope<'control.scenario.ended'>>;
}

export class FactStore {
  private readonly records = new Map<string, PaymentRecord>();
  /** Payment ids in first-seen (log) order. */
  readonly order: string[] = [];
  readonly control: LoggedEvent<ControlEvent>[] = [];
  readonly runs: ScenarioRun[] = [];
  private readonly seen = new Set<string>();
  rejectedCount = 0;
  lastOffset = -1;
  /** Bumped on every applied event: lets caches detect stale answers. */
  version = 0;

  static fromLog(events: readonly BusEvent[]): FactStore {
    const s = new FactStore();
    events.forEach((e, i) => s.apply(e, i));
    return s;
  }

  apply(event: BusEvent, offset: number): void {
    if (offset > this.lastOffset) this.lastOffset = offset;
    if (!event || typeof event.eventId !== 'string' || this.seen.has(event.eventId)) return;
    if (isControlEvent(event)) {
      this.seen.add(event.eventId);
      this.control.push({ offset, event });
      this.applyRun(event, offset);
      this.version += 1;
      return;
    }
    const e = event as AnyEvent;
    const rec = this.records.get(e.paymentId);
    let next: PaymentState;
    try {
      next = applyEvent(rec?.state, e);
    } catch {
      this.rejectedCount += 1;
      return;
    }
    this.seen.add(e.eventId);
    if (!rec) {
      this.records.set(e.paymentId, { state: next, events: [{ offset, event: e }], firstOffset: offset });
      this.order.push(e.paymentId);
    } else {
      rec.state = next;
      if (rec.events.length >= MAX_EVENTS_PER_PAYMENT) rec.events.splice(1, 1);
      rec.events.push({ offset, event: e });
    }
    this.version += 1;
  }

  private applyRun(e: ControlEvent, offset: number): void {
    switch (e.type) {
      case 'control.scenario.started':
        this.runs.push({ runId: e.payload.runId, scenarioId: e.payload.scenarioId, title: e.payload.title, started: { offset, event: e }, steps: [] });
        break;
      case 'control.scenario.step': {
        const run = this.runs.find((r) => r.runId === e.payload.runId);
        run?.steps.push({ offset, event: e });
        break;
      }
      case 'control.scenario.ended': {
        const run = this.runs.find((r) => r.runId === e.payload.runId);
        if (run && !run.ended) run.ended = { offset, event: e };
        break;
      }
      default:
        break;
    }
  }

  /** The retained log in offset order (payment events are capped per payment). */
  toLog(): BusEvent[] {
    const all: LoggedEvent<BusEvent>[] = [...this.control];
    for (const r of this.records.values()) all.push(...r.events);
    return all.sort((a, b) => a.offset - b.offset).map((x) => x.event);
  }

  payment(id: string): PaymentRecord | undefined {
    return this.records.get(id);
  }

  get paymentCount(): number {
    return this.records.size;
  }

  *payments(): IterableIterator<PaymentRecord> {
    for (const id of this.order) {
      const r = this.records.get(id);
      if (r) yield r;
    }
  }

  /** The current or most recent scenario run (optionally of one scenario). */
  latestRun(scenarioId?: string): ScenarioRun | undefined {
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      const r = this.runs[i]!;
      if (!scenarioId || r.scenarioId === scenarioId) return r;
    }
    return undefined;
  }

  /** Payments first seen inside the run's window [start, end]. */
  paymentsInRun(run: ScenarioRun): PaymentRecord[] {
    const from = run.started.offset;
    const to = run.ended?.offset ?? Number.POSITIVE_INFINITY;
    const out: PaymentRecord[] = [];
    for (const r of this.payments()) if (r.firstOffset > from && r.firstOffset < to) out.push(r);
    return out;
  }

  /** Control events inside the run's window (inclusive). */
  controlInRun(run: ScenarioRun): LoggedEvent<ControlEvent>[] {
    const from = run.started.offset;
    const to = run.ended?.offset ?? Number.POSITIVE_INFINITY;
    return this.control.filter((c) => c.offset >= from && c.offset <= to);
  }
}

/** Latest event of a type in a payment's recorded events. */
export function lastOf<T extends AnyEvent['type']>(rec: PaymentRecord, type: T): Extract<AnyEvent, { type: T }> | undefined {
  for (let i = rec.events.length - 1; i >= 0; i -= 1) {
    const e = rec.events[i]!.event;
    if (e.type === type) return e as Extract<AnyEvent, { type: T }>;
  }
  return undefined;
}

export function allOf<T extends AnyEvent['type']>(rec: PaymentRecord, type: T): Extract<AnyEvent, { type: T }>[] {
  return rec.events.filter((x) => x.event.type === type).map((x) => x.event as Extract<AnyEvent, { type: T }>);
}
