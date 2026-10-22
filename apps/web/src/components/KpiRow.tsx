import { formatDuration } from '../lib/format';
import type { Stats } from '../lib/types';

export function KpiRow({ stats }: { stats: Stats | null }) {
  const tiles: { label: string; value: string; tone?: string }[] = [
    { label: 'Total payments', value: String(stats?.total ?? 0) },
    { label: 'Reconciled', value: String(stats?.reconciled ?? 0), tone: 'ok' },
    { label: 'In flight', value: String(stats?.inFlight ?? 0), tone: 'info' },
    { label: 'Held', value: String(stats?.held ?? 0), tone: 'warn' },
    { label: 'Avg end-to-end', value: formatDuration(stats?.avgEndToEndMs) },
  ];
  return (
    <section className="kpis" aria-label="Key figures">
      {tiles.map((t) => (
        <div key={t.label} className={`kpi${t.tone ? ` kpi-${t.tone}` : ''}`}>
          <span className="kpi-value">{t.value}</span>
          <span className="kpi-label">{t.label}</span>
        </div>
      ))}
      {stats && stats.rejectedEvents > 0 && (
        <div className="kpi kpi-bad" title="Events the state machine refused (see /api/rejected)">
          <span className="kpi-value">{stats.rejectedEvents}</span>
          <span className="kpi-label">Invalid events</span>
        </div>
      )}
    </section>
  );
}
