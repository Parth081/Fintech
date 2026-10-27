// Payments-per-minute trend chart geometry (pure).

export interface TrendGeometry {
  line: string;
  area: string;
  bars: { x: number; y: number; w: number; h: number }[];
  max: number;
}

/** SVG paths for a series of counts in a w x h box (oldest first). Failures render as bars. */
export function trendGeometry(values: readonly number[], failed: readonly number[], w: number, h: number, pad = 4): TrendGeometry {
  const n = values.length;
  const max = Math.max(1, ...values, ...failed);
  if (n === 0) return { line: '', area: '', bars: [], max };
  const step = n > 1 ? (w - pad * 2) / (n - 1) : 0;
  const x = (i: number) => pad + i * step;
  const y = (v: number) => h - pad - (Math.max(0, v) / max) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const bw = Math.max(1, Math.min(6, step * 0.5 || 6));
  const bars = failed
    .map((v, i) => ({ v, i }))
    .filter((b) => b.v > 0)
    .map(({ v, i }) => {
      const top = y(v);
      return { x: x(i) - bw / 2, y: top, w: bw, h: h - pad - top };
    });
  return { line, area, bars, max };
}

/** Sum of the last `k` buckets. */
export function lastSum(values: readonly number[], k: number): number {
  return values.slice(-k).reduce((a, b) => a + b, 0);
}
