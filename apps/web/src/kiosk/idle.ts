// Kiosk idle timer (pure; the clock is passed in). After `timeoutMs` without a touch the visit ends and the
// kiosk returns to the welcome screen. During the last `warnMs` a gentle countdown is shown.

export const IDLE_TIMEOUT_MS = 60_000;
export const IDLE_WARN_MS = 15_000;

export type IdlePhase = 'active' | 'warning' | 'expired';

export interface IdleStatus {
  phase: IdlePhase;
  /** Milliseconds until reset (0 once expired). */
  remainingMs: number;
  /** Whole seconds to show in the countdown (ceil, never below 0). */
  secondsLeft: number;
}

export class IdleTimer {
  private last: number;

  constructor(
    now: number,
    readonly timeoutMs: number = IDLE_TIMEOUT_MS,
    readonly warnMs: number = IDLE_WARN_MS,
  ) {
    if (!(timeoutMs > 0)) throw new Error('timeoutMs must be positive');
    if (warnMs < 0 || warnMs > timeoutMs) throw new Error('warnMs must be between 0 and timeoutMs');
    this.last = now;
  }

  /** Any touch, tap, key press or scroll counts as activity. */
  touch(now: number): void {
    if (now > this.last) this.last = now;
  }

  get lastActivity(): number {
    return this.last;
  }

  status(now: number): IdleStatus {
    const remainingMs = Math.max(0, this.timeoutMs - (now - this.last));
    const phase: IdlePhase = remainingMs === 0 ? 'expired' : remainingMs <= this.warnMs ? 'warning' : 'active';
    return { phase, remainingMs, secondsLeft: Math.ceil(remainingMs / 1000) };
  }
}
