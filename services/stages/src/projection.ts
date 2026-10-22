import { applyEvent, type AnyEvent, type PaymentState } from '@ct/contracts';

export class StoppedError extends Error {
  constructor() {
    super('stage stopped');
    this.name = 'StoppedError';
  }
}

/**
 * In-memory view of every payment, fed by an ephemeral subscription from earliest.
 * Tracks the highest log offset applied so the trigger consumer can wait for it to catch up.
 */
export class Projection {
  readonly states = new Map<string, PaymentState>();
  applied = -1;
  rejected = 0;
  private lastActivity = Date.now();
  private waiters: { offset: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  private stopped = false;

  apply(event: AnyEvent, offset: number): void {
    try {
      this.states.set(event.paymentId, applyEvent(this.states.get(event.paymentId), event));
    } catch {
      this.rejected += 1; // invalid events are ignored by the projection (they never change state)
    }
    if (offset > this.applied) this.applied = offset;
    this.lastActivity = Date.now();
    if (this.waiters.length) {
      const ready = this.waiters.filter((w) => w.offset <= this.applied);
      this.waiters = this.waiters.filter((w) => w.offset > this.applied);
      for (const w of ready) w.resolve();
    }
  }

  /** Resolves once the projection has applied the event at `offset` (or later). */
  waitFor(offset: number): Promise<void> {
    if (this.stopped) return Promise.reject(new StoppedError());
    if (this.applied >= offset) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ offset, resolve, reject }));
  }

  /**
   * Best-effort "caught up with the log head": resolves once no event has been applied for
   * `quietMs` (or after `maxMs`). The bus interface does not expose the head offset.
   */
  async settle(quietMs: number, maxMs = 10_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (this.stopped) throw new StoppedError();
      const idleFor = Date.now() - this.lastActivity;
      if (idleFor >= quietMs || Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(quietMs - idleFor, 25))));
    }
  }

  stop(): void {
    this.stopped = true;
    const err = new StoppedError();
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }
}
