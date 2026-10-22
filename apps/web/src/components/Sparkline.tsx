import { sparkGeometry } from '../lib/sparkline';

interface Props {
  values: number[];
  width?: number;
  height?: number;
  label: string;
}

export function Sparkline({ values, width = 320, height = 80, label }: Props) {
  const g = sparkGeometry(values, width, height, 4);
  if (!g.line) return <div className="spark-empty">No data</div>;
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={g.area} className="spark-area" />
      <path d={g.line} className="spark-line" />
      {g.end && <circle cx={g.end.x} cy={g.end.y} r={4} className="spark-end" />}
    </svg>
  );
}
