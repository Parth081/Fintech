// Per-second ring buffer of event counts keyed by event time. O(1) per event, O(window) per read.
import type { Throughput } from './api-types';

const SLOTS = 128; // > 2 x window, so a slot is never reused while still inside the window

export class ThroughputMeter {
  private readonly sec = new Float64Array(SLOTS).fill(-1);
  private readonly events = new Uint32Array(SLOTS);
  private readonly initiated = new Uint32Array(SLOTS);
  private readonly completed = new Uint32Array(SLOTS);

  constructor(
    private readonly now: () => number = Date.now,
    readonly windowSec = 60,
  ) {}

  record(atMs: number, kind: { initiated?: boolean; completed?: boolean } = {}): void {
    if (!Number.isFinite(atMs)) return;
    const s = Math.floor(atMs / 1000);
    const nowS = Math.floor(this.now() / 1000);
    if (s <= nowS - this.windowSec || s > nowS + 5) return; // outside the window (replay of old events)
    const i = ((s % SLOTS) + SLOTS) % SLOTS;
    if (this.sec[i] !== s) {
      this.sec[i] = s;
      this.events[i] = 0;
      this.initiated[i] = 0;
      this.completed[i] = 0;
    }
    this.events[i]! += 1;
    if (kind.initiated) this.initiated[i]! += 1;
    if (kind.completed) this.completed[i]! += 1;
  }

  read(): Throughput {
    const nowS = Math.floor(this.now() / 1000);
    const series: number[] = [];
    let ev = 0;
    let ini = 0;
    let done = 0;
    // window = the last `windowSec` whole seconds including the current one
    for (let s = nowS - this.windowSec + 1; s <= nowS; s++) {
      const i = ((s % SLOTS) + SLOTS) % SLOTS;
      if (this.sec[i] === s) {
        series.push(this.events[i]!);
        ev += this.events[i]!;
        ini += this.initiated[i]!;
        done += this.completed[i]!;
      } else series.push(0);
    }
    const scale = 60 / this.windowSec;
    return {
      windowSec: this.windowSec,
      paymentsPerMin: Math.round(ini * scale),
      completedPerMin: Math.round(done * scale),
      eventsPerSec: Math.round((ev / this.windowSec) * 10) / 10,
      eventsLastMinute: Math.round(ev * scale),
      series,
    };
  }
}
