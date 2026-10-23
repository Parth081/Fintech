// Pure analysis for `npm run verify:m3` (Gate 2): one provider-outage scenario run, read from the event
// log. Everything here works on log entries only, so it is unit-tested on synthetic logs.
//
// What is checked per run (see m3.ts for the I/O and the README for the story):
//   (a) the run's control events appear in order and the outage is closed at the end
//   (b) the provider's breaker opened during the outage, within `breakerBoundMs` of the outage start
//   (c) once the breaker was open, no FIRST-attempt payment was routed to the provider until it went
//       half-open
//   (d) the provider got traffic again after it recovered
// (e)-(g) reuse analyze.ts (terminal statuses, duplicates, state machine, ledger, gateway).
import { ControlTimeline, type AnyEvent, type BusEvent, type ControlEvent } from '@ct/contracts';
import type { Check } from './analyze';

export const EXCLUDED_CIRCUIT_OPEN = 'CIRCUIT_OPEN';
export const EXCLUDED_CIRCUIT_HALF_OPEN = 'CIRCUIT_HALF_OPEN';
export const PROBE_REASON = 'CIRCUIT_HALF_OPEN_PROBE';

/** Default bound for (b): the breaker must be seen open at most this long after the outage started. */
export const DEFAULT_BREAKER_BOUND_MS = 10_000;

export type BreakerStateName = 'closed' | 'open' | 'half-open';

/** One payment.routed decision, reduced to what the M3 checks need. */
export interface RoutedFact {
  offset: number;
  eventId: string;
  paymentId: string;
  atMs: number;
  /** Time the routing decision was based on (trace.inputs.breakerAsOf), else the event time. */
  decidedAtMs: number;
  providerId: string;
  attempt: number;
  /** excludedReason per provider from payload.scoring (only providers that were excluded). */
  excluded: Record<string, string>;
  reasonCodes: string[];
  /** Breaker state per provider as routing recorded it in its decision trace (trace.inputs.breakers). */
  tracedBreakers: Record<string, string>;
}

export interface SettledFact {
  offset: number;
  paymentId: string;
  providerId: string;
  atMs: number;
}

/** Collects control events, routing decisions and settlements from the log (feed it in offset order). */
export class ScenarioLog {
  readonly controls: { offset: number; event: ControlEvent }[] = [];
  readonly routed: RoutedFact[] = [];
  readonly settled: SettledFact[] = [];
  readonly sendFailed: { offset: number; paymentId: string; providerId: string; atMs: number }[] = [];
  private readonly seen = new Set<string>();

  apply(offset: number, event: AnyEvent | BusEvent): void {
    if (this.seen.has(event.eventId)) return;
    this.seen.add(event.eventId);
    if (event.type.startsWith('control.')) {
      this.controls.push({ offset, event: event as ControlEvent });
      return;
    }
    const e = event as AnyEvent;
    const atMs = Date.parse(e.occurredAt);
    if (e.type === 'payment.routed') {
      const excluded: Record<string, string> = {};
      for (const s of e.payload.scoring ?? []) if (!s.eligible && s.excludedReason) excluded[s.providerId] = s.excludedReason;
      const inputs = e.trace?.inputs as { breakerAsOf?: unknown; breakers?: Record<string, { state?: unknown; admission?: unknown }> } | undefined;
      const asOf = inputs?.breakerAsOf;
      const tracedBreakers: Record<string, string> = {};
      for (const [id, b] of Object.entries(inputs?.breakers ?? {})) {
        if (typeof b?.state === 'string') tracedBreakers[id] = typeof b.admission === 'string' ? `${b.state}/${b.admission}` : b.state;
      }
      const decided = typeof asOf === 'string' ? Date.parse(asOf) : Number.NaN;
      this.routed.push({
        offset,
        eventId: e.eventId,
        paymentId: e.paymentId,
        atMs,
        decidedAtMs: Number.isFinite(decided) ? decided : atMs,
        providerId: e.payload.providerId,
        attempt: e.payload.attempt ?? 1,
        excluded,
        reasonCodes: e.trace?.reasonCodes ?? [],
        tracedBreakers,
      });
    } else if (e.type === 'payment.settled') {
      this.settled.push({ offset, paymentId: e.paymentId, providerId: e.payload.providerId, atMs });
    } else if (e.type === 'payment.send_failed') {
      this.sendFailed.push({ offset, paymentId: e.paymentId, providerId: e.payload.providerId, atMs });
    }
  }

  /** Control events of one scenario run (runId in the payload), in log order. */
  runControls(runId: string): { offset: number; event: ControlEvent }[] {
    return this.controls.filter((c) => (c.event.payload as { runId?: string }).runId === runId);
  }
}

export interface RunTimeline {
  runId: string;
  providerId: string | null;
  scenarioStartedAt: number | null;
  scenarioEndedAt: number | null;
  scenarioEndedOffset: number | null;
  outageStartedAt: number | null;
  outageStartedOffset: number | null;
  outageEndedAt: number | null;
  outageEndedOffset: number | null;
  outcome: 'completed' | 'stopped' | null;
}

export function runTimeline(log: ScenarioLog, runId: string): RunTimeline {
  const t: RunTimeline = {
    runId,
    providerId: null,
    scenarioStartedAt: null,
    scenarioEndedAt: null,
    scenarioEndedOffset: null,
    outageStartedAt: null,
    outageStartedOffset: null,
    outageEndedAt: null,
    outageEndedOffset: null,
    outcome: null,
  };
  for (const { offset, event } of log.runControls(runId)) {
    const at = Date.parse(event.occurredAt);
    switch (event.type) {
      case 'control.scenario.started':
        t.scenarioStartedAt ??= at;
        break;
      case 'control.scenario.ended':
        t.scenarioEndedAt ??= at;
        t.scenarioEndedOffset ??= offset;
        t.outcome ??= event.payload.outcome;
        break;
      case 'control.provider_outage.started':
        if (t.outageStartedAt === null) {
          t.providerId = event.payload.providerId;
          t.outageStartedAt = at;
          t.outageStartedOffset = offset;
        }
        break;
      case 'control.provider_outage.ended':
        if (event.payload.providerId === t.providerId && t.outageEndedAt === null) {
          t.outageEndedAt = at;
          t.outageEndedOffset = offset;
        }
        break;
      default:
        break;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// (a) control events in order, outage closed at the end

export function checkControlSequence(log: ScenarioLog, runId: string, expectedSteps?: readonly string[]): Check {
  const evs = log.runControls(runId);
  const problems: string[] = [];
  const types = evs.map((c) => c.event.type);
  const first = types[0];
  const last = types.at(-1);
  if (first !== 'control.scenario.started') problems.push(`first control event is ${first ?? 'missing'}, expected control.scenario.started`);
  if (last !== 'control.scenario.ended') problems.push(`last control event is ${last ?? 'missing'}, expected control.scenario.ended`);
  const count = (t: string) => types.filter((x) => x === t).length;
  if (count('control.scenario.started') !== 1) problems.push(`${count('control.scenario.started')} scenario.started event(s)`);
  if (count('control.scenario.ended') !== 1) problems.push(`${count('control.scenario.ended')} scenario.ended event(s)`);
  const tl = runTimeline(log, runId);
  if (tl.outcome !== null && tl.outcome !== 'completed') problems.push(`scenario ended with outcome "${tl.outcome}"`);
  if (tl.outageStartedOffset === null) problems.push('no control.provider_outage.started for this run');
  if (tl.outageEndedOffset === null) problems.push('no control.provider_outage.ended for this run');
  if (tl.outageStartedOffset !== null && tl.outageEndedOffset !== null && tl.outageEndedOffset < tl.outageStartedOffset) {
    problems.push('outage ended before it started');
  }
  // Offsets must increase (they do by construction of the log) and times must not go backwards.
  for (let i = 1; i < evs.length; i++) {
    if (Date.parse(evs[i]!.event.occurredAt) < Date.parse(evs[i - 1]!.event.occurredAt)) {
      problems.push(`${evs[i]!.event.type} at offset ${evs[i]!.offset} is stamped before the event before it`);
    }
  }
  const steps = evs.filter((c) => c.event.type === 'control.scenario.step').map((c) => (c.event.payload as { stepId: string }).stepId);
  if (expectedSteps && expectedSteps.length > 0) {
    // Every published step must be a known step, in script order, each at most once.
    let idx = -1;
    for (const s of steps) {
      const at = expectedSteps.indexOf(s);
      if (at < 0) problems.push(`unknown step "${s}"`);
      else if (at <= idx) problems.push(`step "${s}" out of order or repeated`);
      else idx = at;
    }
    const missing = expectedSteps.filter((s) => !steps.includes(s));
    // The first step (atMs 0) may be folded into scenario.started by the orchestrator.
    if (missing.length > 1 || (missing.length === 1 && missing[0] !== expectedSteps[0])) problems.push(`steps never published: ${missing.join(', ')}`);
  }
  // The control state folded over the whole log: no outage left open, no scenario still running.
  const timeline = new ControlTimeline();
  for (const c of log.controls) timeline.apply(c.event, c.offset);
  const end = timeline.current();
  const open = Object.keys(end.outages);
  if (open.length > 0) problems.push(`outage(s) still open at the end: ${open.join(', ')}`);
  if (end.scenario !== null) problems.push(`scenario ${end.scenario.runId} still active at the end`);
  return {
    id: 'a.control-sequence',
    title: "The scenario's control events appear in order; the outage is closed at the end",
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${evs.length} control events (${steps.length} steps): ${compactTypes(types)}` : problems.join('; '),
    examples: problems.length ? evs.map((c) => ({ offset: c.offset, type: c.event.type, at: c.event.occurredAt })).slice(0, 20) : undefined,
  };
}

function compactTypes(types: string[]): string {
  const short = types.map((t) => t.replace('control.', '').replace('provider_outage.', 'outage.').replace('scenario.', ''));
  return short.join(' > ');
}

// ---------------------------------------------------------------------------------------------
// (b) breaker opened during the outage, within the bound

export interface BreakerOpenFinding {
  /** First routing decision that excluded the provider with CIRCUIT_OPEN after the outage started. */
  firstOpen: RoutedFact | null;
  /** firstOpen.atMs - outage start. */
  delayMs: number | null;
}

export function findBreakerOpen(log: ScenarioLog, tl: RunTimeline): BreakerOpenFinding {
  if (!tl.providerId || tl.outageStartedOffset === null) return { firstOpen: null, delayMs: null };
  const p = tl.providerId;
  const firstOpen = log.routed.find((r) => r.offset > tl.outageStartedOffset! && r.excluded[p] === EXCLUDED_CIRCUIT_OPEN) ?? null;
  return { firstOpen, delayMs: firstOpen && tl.outageStartedAt !== null ? firstOpen.atMs - tl.outageStartedAt : null };
}

export function checkBreakerOpened(log: ScenarioLog, tl: RunTimeline, boundMs = DEFAULT_BREAKER_BOUND_MS): Check {
  const f = findBreakerOpen(log, tl);
  const p = tl.providerId ?? '(provider)';
  let ok = f.firstOpen !== null && f.delayMs !== null && f.delayMs <= boundMs;
  // It must have opened DURING the outage (before the outage ended).
  if (f.firstOpen && tl.outageEndedOffset !== null && f.firstOpen.offset > tl.outageEndedOffset) ok = false;
  return {
    id: 'b.breaker-opened',
    title: `${p}'s breaker opened during the outage, within ${(boundMs / 1000).toFixed(0)} s of the outage start (routing excluded it with CIRCUIT_OPEN)`,
    ok,
    detail: f.firstOpen
      ? `first CIRCUIT_OPEN exclusion ${(f.delayMs! / 1000).toFixed(1)} s after the outage started (payment ${f.firstOpen.paymentId}, offset ${f.firstOpen.offset})` +
        (tl.outageEndedOffset !== null && f.firstOpen.offset > tl.outageEndedOffset ? ' - AFTER the outage ended' : '')
      : `no routing decision excluded ${p} with CIRCUIT_OPEN after the outage started`,
  };
}

// ---------------------------------------------------------------------------------------------
// (c) no first-attempt payment to the provider while its breaker was open

export interface OpenRespectOptions {
  /**
   * Breaker state of a provider at a time, recomputed independently from the final log (m3.ts uses
   * @ct/market breakerFor over the final payment states). Optional: without it only the log-observed
   * window is used.
   */
  breakerStateAt?: (providerId: string, atMs: number) => BreakerStateName;
}

export interface OpenRespectFinding {
  /** [from, to) offsets in which routing showed the breaker open, until the first half-open sign. */
  window: { fromOffset: number; toOffset: number | null; fromMs: number; toMs: number | null } | null;
  /** First-attempt routes to the provider that broke the rule. */
  violations: (RoutedFact & { why: string })[];
  /** Routing decisions inside the window (for the report). */
  decisionsInWindow: number;
  /** Re-tries (attempt > 1) routed to the provider inside the window (informational). */
  retriesToProviderInWindow: number;
}

/**
 * The open window starts at the first CIRCUIT_OPEN exclusion and ends at the first sign of half-open:
 * a decision that excluded the provider with CIRCUIT_HALF_OPEN or sent it a probe (reason code
 * CIRCUIT_HALF_OPEN_PROBE). Inside it, any first-attempt route to the provider is a violation.
 * Additionally, if `breakerStateAt` is given, any first-attempt route to the provider whose decision
 * time falls while the recomputed breaker was open is a violation (catches a premature "probe").
 */
export function findOpenViolations(log: ScenarioLog, tl: RunTimeline, opts: OpenRespectOptions = {}): OpenRespectFinding {
  const p = tl.providerId;
  const { firstOpen } = findBreakerOpen(log, tl);
  if (!p || !firstOpen) return { window: null, violations: [], decisionsInWindow: 0, retriesToProviderInWindow: 0 };
  const after = log.routed.filter((r) => r.offset >= firstOpen.offset);
  const halfOpenSign = after.find(
    (r) => r.excluded[p] === EXCLUDED_CIRCUIT_HALF_OPEN || (r.providerId === p && r.reasonCodes.includes(PROBE_REASON)),
  );
  const toOffset = halfOpenSign?.offset ?? null;
  const inWindow = after.filter((r) => toOffset === null || r.offset < toOffset);
  const violations: (RoutedFact & { why: string })[] = [];
  for (const r of inWindow) {
    // Decisions are made at decidedAtMs; one decided before the first open decision may land later in the log.
    if (r.providerId === p && r.attempt <= 1 && r.decidedAtMs >= firstOpen.decidedAtMs) {
      violations.push({ ...r, why: 'routed to the provider while routing showed its breaker open' });
    }
  }
  if (opts.breakerStateAt) {
    for (const r of log.routed) {
      if (r.offset < firstOpen.offset || r.providerId !== p || r.attempt > 1) continue;
      if (violations.some((v) => v.eventId === r.eventId)) continue;
      if (opts.breakerStateAt(p, r.decidedAtMs) === 'open') violations.push({ ...r, why: 'the breaker recomputed from the log was open at the decision time' });
    }
  }
  return {
    window: { fromOffset: firstOpen.offset, toOffset, fromMs: firstOpen.atMs, toMs: halfOpenSign?.atMs ?? null },
    violations,
    decisionsInWindow: inWindow.length,
    retriesToProviderInWindow: inWindow.filter((r) => r.providerId === p && r.attempt > 1).length,
  };
}

export function checkNoTrafficWhileOpen(log: ScenarioLog, tl: RunTimeline, opts: OpenRespectOptions = {}): Check {
  const p = tl.providerId ?? '(provider)';
  const f = findOpenViolations(log, tl, opts);
  const w = f.window;
  return {
    id: 'c.no-traffic-while-open',
    title: `While ${p}'s breaker was open, no first-attempt payment was routed to ${p} until it went half-open`,
    ok: w !== null && f.violations.length === 0 && w.toOffset !== null,
    detail: w
      ? `open window ${w.toMs !== null ? `${((w.toMs - w.fromMs) / 1000).toFixed(1)} s` : '(never went half-open)'}, ` +
        `${f.decisionsInWindow} routing decision(s) in it, ${f.violations.length} violation(s)` +
        (f.retriesToProviderInWindow ? `, ${f.retriesToProviderInWindow} retry route(s) to ${p}` : '')
      : 'the breaker was never seen open',
    examples: f.violations.length
      ? f.violations.slice(0, 20).map((v) => ({
          paymentId: v.paymentId,
          offset: v.offset,
          at: new Date(v.atMs).toISOString(),
          decidedAt: new Date(v.decidedAtMs).toISOString(),
          why: v.why,
          routingSaw: v.tracedBreakers[p] ?? null,
          reasonCodes: v.reasonCodes,
        }))
      : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// (d) traffic back after recovery

export interface RecoveryFinding {
  firstAttemptRoutes: number;
  probes: number;
  settled: number;
  firstSettledAfterMs: number | null;
}

/** Routes to and settlements by the provider after the outage ended. */
export function findRecovery(log: ScenarioLog, tl: RunTimeline): RecoveryFinding {
  const p = tl.providerId;
  if (!p || tl.outageEndedOffset === null) return { firstAttemptRoutes: 0, probes: 0, settled: 0, firstSettledAfterMs: null };
  const routes = log.routed.filter((r) => r.offset > tl.outageEndedOffset! && r.providerId === p && r.attempt <= 1);
  const routedIds = new Set(routes.map((r) => r.paymentId));
  // Settled by the provider, for a payment routed to it after the outage ended (not a straggler).
  const settled = log.settled.filter((s) => s.offset > tl.outageEndedOffset! && s.providerId === p && routedIds.has(s.paymentId));
  return {
    firstAttemptRoutes: routes.length,
    probes: routes.filter((r) => r.reasonCodes.includes(PROBE_REASON)).length,
    settled: settled.length,
    firstSettledAfterMs: settled[0] && tl.outageEndedAt !== null ? settled[0].atMs - tl.outageEndedAt : null,
  };
}

/** Ready for (d): the provider settled at least one non-probe first-attempt payment routed after the outage. */
export function recoveryComplete(log: ScenarioLog, tl: RunTimeline): boolean {
  const r = findRecovery(log, tl);
  return r.settled > 0 && r.firstAttemptRoutes > r.probes;
}

export function checkRecovery(log: ScenarioLog, tl: RunTimeline): Check {
  const p = tl.providerId ?? '(provider)';
  const r = findRecovery(log, tl);
  return {
    id: 'd.recovery',
    title: `${p} got traffic again after it recovered (first-attempt routes beyond probes, and settlements)`,
    ok: r.settled > 0 && r.firstAttemptRoutes > r.probes,
    detail:
      tl.outageEndedOffset === null
        ? 'the outage never ended'
        : `${r.firstAttemptRoutes} first-attempt route(s) to ${p} after the outage ended (${r.probes} probe(s)), ${r.settled} settled` +
          (r.firstSettledAfterMs !== null ? `; first settlement ${(r.firstSettledAfterMs / 1000).toFixed(1)} s after the outage ended` : ''),
  };
}

// ---------------------------------------------------------------------------------------------
// (h) reset

export function checkReset(r: { durationMs: number | null; error?: string; logEventsAfter?: number | null }, maxMs: number): Check {
  const ok = r.durationMs !== null && r.durationMs < maxMs && !r.error && (r.logEventsAfter === undefined || r.logEventsAfter === null || r.logEventsAfter < 1000);
  return {
    id: 'h.reset',
    title: `Reset took < ${(maxMs / 1000).toFixed(0)} s and the system came back empty and healthy`,
    ok,
    detail: r.error
      ? `reset failed: ${r.error}`
      : r.durationMs === null
        ? 'no reset'
        : `${(r.durationMs / 1000).toFixed(2)} s` + (r.logEventsAfter !== undefined && r.logEventsAfter !== null ? `; ${r.logEventsAfter} event(s) in the log right after` : ''),
  };
}
