// Dot lifecycle for the world map: one dot per payment attempt, driven by feed events.
//   routed / sent      -> spawn: fly from source towards the target, hold just short of it
//   settled/reconciled -> land: finish the route, flash at the target, disappear
//   send_failed/failed -> bounce: run to the provider hub (where it was rejected), turn red, fade
//   no news for maxAgeMs -> fade quietly
// The engine mutates in place (it runs every animation frame); it never touches the DOM.

export type DotPhase = 'flying' | 'landing' | 'landed' | 'failing' | 'fading';

export interface Dot {
  id: number;
  paymentId: string;
  routeKey: string;
  providerId: string;
  /** Progress along the route, 0..1 by length. */
  p: number;
  /** Progress per millisecond. */
  v: number;
  /** p never passes this. */
  stopAt: number;
  phase: DotPhase;
  /** Time spent in the current phase after reaching stopAt (landed/failing/fading timers). */
  phaseMs: number;
  ageMs: number;
  /** Spawned while the provider's breaker was half-open (a probe). */
  probe: boolean;
}

export interface DotConfig {
  maxDots: number;
  /** Time to fly from source to the hold point. */
  travelMs: number;
  /** Where a dot waits for settlement (fraction of the route). */
  holdAt: number;
  /** Minimum time to finish once settled. */
  landMs: number;
  /** Landing flash duration. */
  flashMs: number;
  /** Red bounce / quiet fade duration. */
  failMs: number;
  /** A dot with no outcome after this long fades out. */
  maxAgeMs: number;
}

export const DEFAULT_DOT_CONFIG: DotConfig = { maxDots: 180, travelMs: 2600, holdAt: 0.9, landMs: 500, flashMs: 700, failMs: 1500, maxAgeMs: 45_000 };
/** prefers-reduced-motion: fewer, slower dots. */
export const REDUCED_DOT_CONFIG: DotConfig = { maxDots: 40, travelMs: 5200, holdAt: 0.9, landMs: 1000, flashMs: 400, failMs: 2500, maxAgeMs: 45_000 };

export interface DotEngine {
  dots: Dot[];
  /** paymentId -> its dot that is still waiting for an outcome. */
  active: Map<string, Dot>;
  nextId: number;
  /** Spawns skipped because of the cap. */
  dropped: number;
}

export function createDotEngine(): DotEngine {
  return { dots: [], active: new Map(), nextId: 1, dropped: 0 };
}

/** Drop every dot (demo reset). Keeps the id counter so React/canvas never reuse ids. */
export function clearDots(engine: DotEngine): void {
  engine.dots.length = 0;
  engine.active.clear();
  engine.dropped = 0;
}

export interface DotEvent {
  type: string;
  paymentId: string;
}

export interface SpawnInfo {
  routeKey: string;
  providerId: string;
  /** Hub position on the route (where rejected dots bounce). */
  hubT: number;
  probe?: boolean;
}

const SPAWN = new Set(['payment.routed', 'payment.sent']);
const LAND = new Set(['payment.settled', 'payment.reconciled']);
const FAIL = new Set(['payment.send_failed', 'payment.failed']);

export function isDotEvent(type: string): boolean {
  return SPAWN.has(type) || LAND.has(type) || FAIL.has(type);
}

function startLanding(d: Dot, cfg: DotConfig): void {
  d.phase = 'landing';
  d.phaseMs = 0;
  d.stopAt = 1;
  const rest = Math.max(0, 1 - d.p);
  // Fast enough to finish within landMs from the hold point, slow enough to still show the trip.
  d.v = rest > 0 ? rest / (cfg.landMs + rest * cfg.travelMs * 0.5) : 1;
}

function startFailing(d: Dot, cfg: DotConfig, hubT: number): void {
  d.phase = 'failing';
  d.phaseMs = 0;
  d.stopAt = Math.max(d.p, hubT);
  d.v = 2 / cfg.travelMs;
}

/**
 * Apply feed events in order. `resolve` gives the route for a payment (null = unknown: no dot).
 * Hub positions for failures come from the dot's own route via `hubT`.
 */
export function applyDotEvents(
  engine: DotEngine,
  events: readonly DotEvent[],
  resolve: (paymentId: string) => SpawnInfo | null,
  cfg: DotConfig = DEFAULT_DOT_CONFIG,
  hubT: (routeKey: string) => number = () => 0.5,
): void {
  for (const e of events) {
    const current = engine.active.get(e.paymentId);
    if (SPAWN.has(e.type)) {
      if (current) {
        // routed again without a reported failure (e.g. a missed send_failed): retire the old dot.
        if (e.type === 'payment.routed') {
          startFailing(current, cfg, hubT(current.routeKey));
          engine.active.delete(e.paymentId);
        } else continue;
      }
      const info = resolve(e.paymentId);
      if (!info) continue;
      if (engine.dots.length >= cfg.maxDots) {
        engine.dropped += 1;
        continue;
      }
      const d: Dot = {
        id: engine.nextId++,
        paymentId: e.paymentId,
        routeKey: info.routeKey,
        providerId: info.providerId,
        p: 0,
        v: cfg.holdAt / cfg.travelMs,
        stopAt: cfg.holdAt,
        phase: 'flying',
        phaseMs: 0,
        ageMs: 0,
        probe: info.probe ?? false,
      };
      engine.dots.push(d);
      engine.active.set(e.paymentId, d);
    } else if (LAND.has(e.type)) {
      if (!current) continue;
      startLanding(current, cfg);
      engine.active.delete(e.paymentId);
    } else if (FAIL.has(e.type)) {
      if (!current) continue;
      startFailing(current, cfg, hubT(current.routeKey));
      engine.active.delete(e.paymentId);
    }
  }
}

/** Advance every dot by dtMs and drop finished ones. */
export function advanceDots(engine: DotEngine, dtMs: number, cfg: DotConfig = DEFAULT_DOT_CONFIG): void {
  const dt = Math.max(0, Math.min(dtMs, 250)); // a backgrounded tab must not teleport everything
  const dots = engine.dots;
  let w = 0;
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i] as Dot;
    d.ageMs += dt;
    let keep = true;
    if (d.p < d.stopAt) {
      d.p = Math.min(d.stopAt, d.p + d.v * dt);
    } else if (d.phase !== 'flying') {
      d.phaseMs += dt;
    }
    switch (d.phase) {
      case 'flying':
        if (d.ageMs >= cfg.maxAgeMs) {
          d.phase = 'fading';
          d.phaseMs = 0;
          d.stopAt = d.p;
          if (engine.active.get(d.paymentId) === d) engine.active.delete(d.paymentId);
        }
        break;
      case 'landing':
        if (d.p >= 1) {
          d.phase = 'landed';
          d.phaseMs = 0;
        }
        break;
      case 'landed':
        if (d.phaseMs >= cfg.flashMs) keep = false;
        break;
      case 'failing':
      case 'fading':
        if (d.phaseMs >= cfg.failMs) keep = false;
        break;
    }
    if (keep) dots[w++] = d;
  }
  dots.length = w;
}

/** Opacity of a dot for drawing (0..1). */
export function dotAlpha(d: Dot, cfg: DotConfig = DEFAULT_DOT_CONFIG): number {
  if (d.phase === 'failing' || d.phase === 'fading') return Math.max(0, 1 - d.phaseMs / cfg.failMs);
  if (d.phase === 'landed') return Math.max(0, 1 - d.phaseMs / cfg.flashMs);
  return Math.min(1, 0.25 + d.ageMs / 300);
}

/** Counts per phase (diagnostics / tests). */
export function dotCounts(engine: DotEngine): Record<DotPhase, number> {
  const out: Record<DotPhase, number> = { flying: 0, landing: 0, landed: 0, failing: 0, fading: 0 };
  for (const d of engine.dots) out[d.phase] += 1;
  return out;
}
