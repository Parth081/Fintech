// Injectable clock so scenario timelines and ambient pacing can run on fake time in tests.

export type TimerHandle = { readonly __timer: true } | ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
  clearTimeout: (h) => {
    if (h !== undefined) clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Manual clock for tests: time moves only on advance(); due timers fire in (time, creation) order. */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: FakeTimer[] = [];

  constructor(startMs = Date.parse('2026-01-01T09:00:00.000Z')) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer: FakeTimer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return { __timer: true, id: timer.id } as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    if (!handle) return;
    const id = (handle as unknown as { id: number }).id;
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward by `ms`, firing every timer that falls due (including ones scheduled meanwhile). */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flushAsync();
    }
    this.t = target;
    await flushAsync();
  }
}

/** Let pending promise chains (and quick I/O callbacks) run. */
export async function flushAsync(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}
