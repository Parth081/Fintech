// Circuit breakers per provider, derived from observed attempt outcomes (M3).
//
// The breaker is a pure function of (attempt outcomes, atMs, options): it replays, in time order, every
// attempt OUTCOME (payment.settled / payment.send_failed, attributed to a provider exactly as health.ts
// does) that occurred in [atMs - historyMs, atMs). Nothing else (wall clock, arrival order, process
// state) is involved, so every process and every replay computes the same breaker for the same atMs.
//
// State machine (defaults tuned for a live demo, see DEFAULT_BREAKER_OPTIONS):
//   closed    -> open       when, in the sliding window ending at an outcome — the last windowSize (8)
//                           outcomes that are at most windowMs (20 s) old — at least failureThreshold (4)
//                           attempts failed AND failures / attempts >= failureRateThreshold (50%).
//                           (Count AND time bounded: a busy provider's earlier successes cannot hide a
//                           sudden run of failures, and old failures do not linger.)
//   open      -> half-open  openMs after it opened (time-based; no outcome needed).
//   half-open -> closed     on the first SUCCESSFUL outcome of an attempt sent while half-open (a probe).
//   half-open -> open       when probeFailuresToReopen (2) probes of this half-open period failed without a
//                           success in between (open again for openMs). Two, not one: a single probe can be
//                           rejected for an ordinary reason (the provider's normal ~3% rejects), and re-opening
//                           on that would delay a recovered provider by a whole openMs. Under a real outage the
//                           second probe fails moments later, so the cost is one extra failed (retried) probe.
// Outcomes of attempts sent before the breaker last entered half-open (stragglers that were already in
// flight when it tripped, or fallback traffic while open) never count after a trip: a breaker that
// recovered starts with an empty window.
//
// Half-open admission is deterministic per payment: isProbeAllowed(paymentId, providerId) is a hash
// draw < probeFraction, so the same payment is always (or never) a probe for that provider.
//
// Ordering ties (same outcome time) break on sent time, then payment id + attempt index.
//
// Cost: one pass over the states (attempt extraction cached per state object by attemptsOf), then a
// sort of the outcomes inside the history window per provider. The machine starts CLOSED at
// atMs - historyMs (default 30 min, much longer than any demo incident), which bounds the work.
import type { BreakerView, PaymentState } from '@ct/contracts/browser';
import { PROVIDER_CATALOG } from './catalog';
import { attemptsOf } from './health';
import { fmix32, fnv1a } from './hash';

export interface BreakerOptions {
  /** Failures within the window that open the breaker. */
  failureThreshold?: number;
  /** Minimum failure share within the window (0..1) that, together with failureThreshold, opens it. */
  failureRateThreshold?: number;
  /** The window holds at most this many most recent outcomes... */
  windowSize?: number;
  /** ...that are at most this old. */
  windowMs?: number;
  /** How long an open breaker stays open before letting probe traffic through (half-open). */
  openMs?: number;
  /** Share of payments (by hash) admitted as probes while half-open. */
  probeFraction?: number;
  /** Failed probes (in one half-open period, no success) that re-open the breaker. */
  probeFailuresToReopen?: number;
  /** Outcomes older than this before atMs are not replayed (the machine starts closed there). */
  historyMs?: number;
}

export const DEFAULT_BREAKER_OPTIONS: Readonly<Required<BreakerOptions>> = {
  failureThreshold: 4,
  failureRateThreshold: 0.5,
  windowSize: 8,
  windowMs: 20_000,
  openMs: 15_000,
  probeFraction: 0.25,
  probeFailuresToReopen: 2,
  historyMs: 30 * 60_000,
};

export type BreakerStateName = BreakerView['state'];

/** BreakerView plus the machine details routing and tests need. */
export interface BreakerDetail extends BreakerView {
  sinceMs: number | null;
  /** When an open breaker goes half-open (open only). */
  halfOpenAtMs: number | null;
  /** Last time the breaker closed after a trip (a probe succeeded), if any. */
  recoveredAtMs: number | null;
  /** Times the breaker opened (including re-opens after failed probes) within the history window. */
  trips: number;
  /** Failures / attempts that tripped it the last time it opened from closed. */
  trip: { failures: number; attempts: number; atMs: number } | null;
  /** Outcome of the last probe while half-open, if any. */
  lastProbe: { ok: boolean; atMs: number } | null;
  probeFraction: number;
}

/** One attempt outcome as the breaker sees it. */
export interface BreakerOutcome {
  sentAtMs: number;
  outcomeAtMs: number;
  ok: boolean;
  /** Stable tie-breaker (paymentId#attemptIndex). */
  key: string;
}

const resolve = (opts: BreakerOptions): Required<BreakerOptions> => ({ ...DEFAULT_BREAKER_OPTIONS, ...stripUndefined(opts) });

function stripUndefined(o: BreakerOptions): BreakerOptions {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as BreakerOptions;
}

const byTime = (a: BreakerOutcome, b: BreakerOutcome) =>
  a.outcomeAtMs - b.outcomeAtMs || a.sentAtMs - b.sentAtMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/**
 * The breaker of one provider at atMs from its outcomes (any order; only outcomes before atMs and
 * inside the history window are used). Pure; exported for tests and tools.
 */
export function breakerFromOutcomes(providerId: string, outcomes: readonly BreakerOutcome[], atMs: number, opts: BreakerOptions = {}): BreakerDetail {
  const o = resolve(opts);
  const from = atMs - o.historyMs;
  const evs = outcomes.filter((e) => e.outcomeAtMs < atMs && e.outcomeAtMs >= from);
  // Fast path: with fewer failures than the threshold in the whole history it can never have tripped.
  let totalFails = 0;
  for (const e of evs) if (!e.ok) totalFails++;
  if (totalFails >= o.failureThreshold) evs.sort(byTime);

  let state = 'closed' as BreakerStateName;
  let sinceMs: number | null = null;
  let openedAtMs = 0;
  let halfOpenSinceMs = Number.NEGATIVE_INFINITY;
  let admittedFromMs = Number.NEGATIVE_INFINITY;
  let recoveredAtMs: number | null = null;
  let trips = 0;
  let trip: BreakerDetail['trip'] = null;
  let lastProbe: BreakerDetail['lastProbe'] = null;
  // sliding window of admitted outcomes while closed
  let qT: number[] = [];
  let qOk: boolean[] = [];
  let head = 0;
  let fails = 0;
  let probeFails = 0;

  const open = (t: number) => {
    state = 'open';
    sinceMs = t;
    openedAtMs = t;
    trips++;
    qT = [];
    qOk = [];
    head = 0;
    fails = 0;
  };
  const advance = (t: number) => {
    if (state === 'open' && t >= openedAtMs + o.openMs) {
      state = 'half-open';
      sinceMs = openedAtMs + o.openMs;
      halfOpenSinceMs = sinceMs;
      probeFails = 0;
    }
  };

  for (const e of totalFails >= o.failureThreshold ? evs : []) {
    advance(e.outcomeAtMs);
    if (state === 'closed') {
      if (e.sentAtMs < admittedFromMs) continue;
      qT.push(e.outcomeAtMs);
      qOk.push(e.ok);
      if (!e.ok) fails++;
      while (head < qT.length && (qT[head]! <= e.outcomeAtMs - o.windowMs || qT.length - head > o.windowSize)) {
        if (!qOk[head]) fails--;
        head++;
      }
      const n = qT.length - head;
      if (fails >= o.failureThreshold && fails / n >= o.failureRateThreshold) {
        trip = { failures: fails, attempts: n, atMs: e.outcomeAtMs };
        open(e.outcomeAtMs);
      }
    } else if (state === 'half-open') {
      if (e.sentAtMs < halfOpenSinceMs) continue; // not a probe: sent before half-open
      lastProbe = { ok: e.ok, atMs: e.outcomeAtMs };
      if (e.ok) {
        state = 'closed';
        sinceMs = e.outcomeAtMs;
        recoveredAtMs = e.outcomeAtMs;
        admittedFromMs = halfOpenSinceMs;
        qT = [];
        qOk = [];
        head = 0;
        fails = 0;
      } else if (++probeFails >= o.probeFailuresToReopen) open(e.outcomeAtMs);
    }
    // open: outcomes are ignored (stragglers or fallback traffic)
  }
  advance(atMs);

  // Display stats: every outcome of this provider in [atMs - windowMs, atMs).
  let wAttempts = 0;
  let wFails = 0;
  for (const e of evs) {
    if (e.outcomeAtMs >= atMs - o.windowMs) {
      wAttempts++;
      if (!e.ok) wFails++;
    }
  }
  const failureRate = wAttempts ? Math.round((wFails / wAttempts) * 10_000) / 10_000 : 0;
  const halfOpenAtMs = state === 'open' ? openedAtMs + o.openMs : null;

  let reason: string;
  if (state === 'open') {
    const why = lastProbe && !lastProbe.ok && lastProbe.atMs === openedAtMs
      ? `${o.probeFailuresToReopen === 1 ? 'probe instruction' : `${o.probeFailuresToReopen} probe instructions`} rejected (last at ${hhmmss(openedAtMs)})`
      : trip
        ? `${trip.failures} of the last ${trip.attempts} instructions rejected within ${secs(o.windowMs)}`
        : 'too many rejections';
    reason = `Open: ${why}. Traffic is re-routed; probing again at ${hhmmss(halfOpenAtMs!)}.`;
  } else if (state === 'half-open') {
    reason = `Half-open since ${hhmmss(sinceMs!)}: ${Math.round(o.probeFraction * 100)}% of payments go through as probes; one success closes it, ${o.probeFailuresToReopen === 1 ? 'one rejection' : `${o.probeFailuresToReopen} rejections`} re-open it.`;
  } else if (recoveredAtMs !== null) {
    reason = `Closed: recovered at ${hhmmss(recoveredAtMs)} after a successful probe; ${wFails} of ${wAttempts} instructions rejected in the last ${secs(o.windowMs)}.`;
  } else {
    reason = wAttempts
      ? `Closed: ${wFails} of ${wAttempts} instructions rejected in the last ${secs(o.windowMs)}.`
      : `Closed: no instructions completed in the last ${secs(o.windowMs)}.`;
  }

  return {
    providerId,
    state,
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    failureRate,
    attempts: wAttempts,
    reason,
    sinceMs,
    halfOpenAtMs,
    recoveredAtMs,
    trips,
    trip,
    lastProbe,
    probeFraction: o.probeFraction,
  };
}

/** Attempt outcomes per provider with outcomeAt in [from, atMs). One pass over the states. */
export function breakerOutcomes(states: Iterable<PaymentState>, atMs: number, historyMs = DEFAULT_BREAKER_OPTIONS.historyMs): Map<string, BreakerOutcome[]> {
  const from = atMs - historyMs;
  const out = new Map<string, BreakerOutcome[]>();
  for (const p of PROVIDER_CATALOG) out.set(p.id, []);
  for (const state of states) {
    const attempts = attemptsOf(state);
    for (let i = 0; i < attempts.length; i++) {
      const r = attempts[i]!;
      if (r.outcome === null || !(r.outcomeAtMs! < atMs) || r.outcomeAtMs! < from) continue;
      let list = out.get(r.providerId);
      if (!list) out.set(r.providerId, (list = []));
      list.push({ sentAtMs: r.sentAtMs, outcomeAtMs: r.outcomeAtMs!, ok: r.outcome === 'settled', key: `${state.paymentId}#${i}` });
    }
  }
  return out;
}

/** Breaker detail of every catalogue provider (plus any other provider seen), keyed by provider id. */
export function breakerDetails(states: Iterable<PaymentState>, atMs: number, opts: BreakerOptions = {}): Record<string, BreakerDetail> {
  const o = resolve(opts);
  const result: Record<string, BreakerDetail> = {};
  for (const [id, outcomes] of breakerOutcomes(states, atMs, o.historyMs)) result[id] = breakerFromOutcomes(id, outcomes, atMs, o);
  return result;
}

/**
 * Breaker state for every provider at `atMs`, derived ONLY from attempt outcomes that occurred before
 * `atMs` (deterministic: the same inputs always give the same states). Catalogue order, then others.
 */
export function breakerStates(states: Iterable<PaymentState>, atMs: number, opts: BreakerOptions = {}): BreakerView[] {
  return Object.values(breakerDetails(states, atMs, opts)).map(({ providerId, state, since, failureRate, attempts, reason }) => ({ providerId, state, since, failureRate, attempts, reason }));
}

/** One provider's breaker (detail). */
export function breakerFor(states: Iterable<PaymentState>, providerId: string, atMs: number, opts: BreakerOptions = {}): BreakerDetail {
  const o = resolve(opts);
  return breakerFromOutcomes(providerId, breakerOutcomes(states, atMs, o.historyMs).get(providerId) ?? [], atMs, o);
}

/** Deterministic uniform draw in [0, 1) for (payment, provider) probe selection. */
export function probeDraw(paymentId: string, providerId: string): number {
  return fmix32(fnv1a(`${paymentId}|${providerId}|probe`)) / 4294967296;
}

/** Whether a half-open breaker admits this payment as a probe. */
export function isProbeAllowed(paymentId: string, providerId: string, probeFraction = DEFAULT_BREAKER_OPTIONS.probeFraction): boolean {
  return probeDraw(paymentId, providerId) < probeFraction;
}

export type BreakerAdmission = 'admit' | 'probe' | 'reject-open' | 'reject-half-open';

/** What a breaker means for one payment: closed admits, half-open admits probes only, open rejects. */
export function breakerAdmission(b: Pick<BreakerDetail, 'state' | 'providerId' | 'probeFraction'>, paymentId: string): BreakerAdmission {
  if (b.state === 'closed') return 'admit';
  if (b.state === 'open') return 'reject-open';
  return isProbeAllowed(paymentId, b.providerId, b.probeFraction) ? 'probe' : 'reject-half-open';
}
