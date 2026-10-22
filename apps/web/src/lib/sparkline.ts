// Inline-SVG sparkline geometry (no chart library).

export interface SparkGeometry {
  line: string;
  area: string;
  min: number;
  max: number;
  first: number | null;
  last: number | null;
  /** Last point, for an end marker. */
  end: { x: number; y: number } | null;
}

export function sparkGeometry(values: number[], width: number, height: number, pad = 2): SparkGeometry {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { line: '', area: '', min: NaN, max: NaN, first: null, last: null, end: null };
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = v.length > 1 ? innerW / (v.length - 1) : 0;
  const pts = v.map((y, i) => {
    const px = pad + (v.length > 1 ? i * step : innerW / 2);
    const py = max === min ? pad + innerH / 2 : pad + innerH - ((y - min) / span) * innerH;
    return { x: Math.round(px * 100) / 100, y: Math.round(py * 100) / 100 };
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const firstPt = pts[0]!;
  const lastPt = pts.at(-1)!;
  const area = `${line} L${lastPt.x} ${height - pad} L${firstPt.x} ${height - pad} Z`;
  return { line, area, min, max, first: v[0]!, last: v.at(-1)!, end: lastPt };
}

/** Relative change first -> last, e.g. 0.0012 for +0.12%. */
export function changeRatio(first: number | null, last: number | null): number | null {
  if (first === null || last === null || first === 0) return null;
  return (last - first) / first;
}
