import { formatCount, formatDuration } from '../lib/format';
import type { Stats } from '../lib/types';

export function KpiRow({ stats }: { stats: Stats | null }) {
  const t = stats?.throughput;
  const tiles: { label: string; value: string; tone?: string; title?: string }[] = [
    { label: 'Total payments', value: formatCount(stats?.total ?? 0) },
    { label: 'Reconciled', value: formatCount(stats?.reconciled ?? 0), tone: 'ok' },
    { label: 'In flight', value: formatCount(stats?.inFlight ?? 0), tone: 'info' },
    {
      label: 'Payments / min',
      value: formatCount(t?.paymentsPerMin ?? 0),
      tone: 'info',
      title: t ? `${t.eventsPerSec} events/s · ${t.completedPerMin} completed/min (last ${t.windowSec}s)` : undefined,
    },
    { label: 'Provider retries', value: formatCount(stats?.retriesTotal ?? 0), tone: stats?.retriesTotal ? 'warn' : undefined },
    { label: 'Failed', value: formatCount(stats?.failed ?? 0), tone: stats?.failed ? 'bad' : undefined },
    { label: 'Recon breaks', value: formatCount(stats?.reconBreaks ?? 0), tone: stats?.reconBreaks ? 'bad' : 'ok' },
    { label: 'Avg end-to-end', value: formatDuration(stats?.avgEndToEndMs) },
  ];
  return (
    <section className="kpis" aria-label="Key figures">
      {tiles.map((k) => (
        <div key={k.label} className={`kpi${k.tone ? ` kpi-${k.tone}` : ''}`} title={k.title}>
          <span className="kpi-value">{k.value}</span>
          <span className="kpi-label">{k.label}</span>
        </div>
      ))}
      {stats && stats.rejectedEvents > 0 && (
        <div className="kpi kpi-bad" title="Events the state machine refused (see /api/rejected)">
          <span className="kpi-value">{formatCount(stats.rejectedEvents)}</span>
          <span className="kpi-label">Invalid events</span>
        </div>
      )}
    </section>
  );
}
