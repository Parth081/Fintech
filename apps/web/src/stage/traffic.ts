// Share of recent routing decisions per provider (sliding window, 1 s buckets). Pure.

export interface Share {
  key: string;
  count: number;
  /** 0..1 of the total in the window (0 when nothing was routed). */
  share: number;
}

export class TrafficWindow {
  private readonly buckets = new Map<number, Map<string, number>>();

  constructor(
    readonly windowMs = 60_000,
    readonly bucketMs = 1_000,
  ) {}

  record(key: string, atMs: number, n = 1): void {
    const b = Math.floor(atMs / this.bucketMs);
    let m = this.buckets.get(b);
    if (!m) {
      m = new Map();
      this.buckets.set(b, m);
    }
    m.set(key, (m.get(key) ?? 0) + n);
  }

  /**
   * Counts per key in (nowMs - window, nowMs], at bucket resolution. `window` defaults to (and is
   * capped at) windowMs. Also prunes buckets older than windowMs.
   */
  counts(nowMs: number, window = this.windowMs): Record<string, number> {
    const prune = Math.floor((nowMs - this.windowMs) / this.bucketMs) + 1;
    const oldest = Math.max(prune, Math.floor((nowMs - Math.min(window, this.windowMs)) / this.bucketMs) + 1);
    const newest = Math.floor(nowMs / this.bucketMs);
    const out: Record<string, number> = {};
    for (const [b, m] of this.buckets) {
      if (b < prune) {
        this.buckets.delete(b);
        continue;
      }
      if (b < oldest || b > newest) continue;
      for (const [k, n] of m) out[k] = (out[k] ?? 0) + n;
    }
    return out;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** Total of a counts record. */
export function totalOf(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

/**
 * Last-minute counts for the provider panel: the gateway's own meter when it reports any traffic
 * (it survives page reloads), else what this screen has seen itself.
 */
export function pickCounts(server: Readonly<Record<string, number>> | null, local: Readonly<Record<string, number>>): Record<string, number> {
  return server && totalOf(server) > 0 ? { ...server } : { ...local };
}

/** Shares for `keys` (in that order; keys not listed are still part of the total). */
export function sharesOf(counts: Readonly<Record<string, number>>, keys: readonly string[]): Share[] {
  const total = totalOf(counts);
  return keys.map((key) => {
    const count = counts[key] ?? 0;
    return { key, count, share: total > 0 ? count / total : 0 };
  });
}

/** Whole-percent labels that add up to 100 (largest remainder), or '—' when there is no traffic. */
export function percentLabels(shares: readonly Share[]): string[] {
  const total = shares.reduce((s, x) => s + x.count, 0);
  if (total === 0) return shares.map(() => '—');
  const raw = shares.map((s) => (s.count / total) * 100);
  const floors = raw.map(Math.floor);
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (rest <= 0) break;
    floors[o.i] = (floors[o.i] as number) + 1;
    rest -= 1;
  }
  return floors.map((f) => `${f}%`);
}
