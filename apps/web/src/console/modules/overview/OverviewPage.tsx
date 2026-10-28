// Overview: today's KPIs, risk queues, recon & change control, payments-per-minute trend, quick links.
import { SEVERITIES } from '../../lib/status';
import { gatewayApi, opsApi } from '../../api';
import { links } from '../../route';
import { useSession } from '../../session';
import { useShellAttention } from '../../shell/Shell';
import { lastSum, trendGeometry } from '../../lib/trend';
import type { PaymentTrend } from '../../api';
import {
  Card,
  DataTable,
  DateTime,
  ErrorState,
  LinkButton,
  MetricCard,
  Page,
  PageHeader,
  Skeleton,
  StackedBar,
  StatusBadge,
  formatNumber,
  formatPercent,
  formatUsdCompact,
  shortId,
  useApi,
  useNow,
  type Column,
} from '../../ui';
import type { CaseView } from '@ct/contracts/browser';

function greeting(nowMs: number): string {
  const h = new Date(nowMs).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function TrendChart({ trend }: { trend: PaymentTrend }) {
  const W = 600;
  const H = 150;
  const g = trendGeometry(trend.initiated, trend.failed, W, H);
  const n = trend.initiated.length;
  return (
    <div>
      <svg className="ct-trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Payments per minute over the last ${n} minutes; latest ${trend.initiated.at(-1) ?? 0}`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} className="ct-trend-grid" x1={0} x2={W} y1={H * f} y2={H * f} />
        ))}
        <path className="ct-trend-area" d={g.area} />
        <path className="ct-trend-line" d={g.line} vectorEffect="non-scaling-stroke" />
        {g.bars.map((b, i) => (
          <rect key={i} className="ct-trend-fail" x={b.x} y={b.y} width={b.w} height={b.h} />
        ))}
      </svg>
      <div className="ct-row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <span className="ct-small ct-muted">
          <DateTime value={trend.fromMs} seconds={false} />
        </span>
        <div className="ct-legend">
          <span>
            <i className="ct-fill-accent" />
            Initiated / min (peak {formatNumber(g.max)})
          </span>
          <span>
            <i className="ct-fill-bad" />
            Failed or rejected
          </span>
        </div>
        <span className="ct-small ct-muted">now</span>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const { user, can } = useSession();
  const now = useNow(60_000);
  const attention = useShellAttention();
  const own = useApi((s) => opsApi.overview(s), [], { intervalMs: 15_000, enabled: !attention });
  const ov = attention?.overview ?? own.data;
  const trend = useApi((s) => gatewayApi.trend(30, s), [], { intervalMs: 10_000 });
  const myCases = useApi((s) => opsApi.cases({ assignee: 'me', status: 'active', limit: 6 }, s), [user?.id], { intervalMs: 20_000, enabled: can('cases.work') });
  const pendingApproval = useApi((s) => opsApi.cases({ status: 'pending_approval', limit: 6 }, s), [], { intervalMs: 20_000, enabled: can('cases.approve') });
  const loading = !ov;

  const caseCols: Column<CaseView>[] = [
    { id: 'id', header: 'Case', cell: (c) => <span className="ct-mono">{c.caseId}</span> },
    { id: 'p', header: 'Priority', cell: (c) => <StatusBadge kind="severity" value={c.priority} /> },
    { id: 's', header: 'Status', cell: (c) => <StatusBadge kind="case" value={c.status} dot={false} /> },
    {
      id: 'sla',
      header: 'SLA due',
      cell: (c) => <span className={Date.parse(c.slaDueAt) < now ? 'ct-text-bad ct-strong' : undefined}><DateTime value={c.slaDueAt} relative now={now} /></span>,
    },
  ];

  const sev = ov?.alerts.bySeverity;
  return (
    <Page>
      <PageHeader
        title={`${greeting(now)}, ${user?.name.split(' ')[0] ?? ''}`}
        subtitle={ov ? <>Operations snapshot as of <DateTime value={ov.asOf} /></> : 'Loading today’s operations snapshot…'}
        actions={
          <>
            {can('payments.read') && <LinkButton href={links.payments({ status: 'failed' })} icon="payments">Failed payments</LinkButton>}
            {can('alerts.read') && <LinkButton href={links.cases({ status: 'active' })} variant="primary" icon="cases">Case queue</LinkButton>}
          </>
        }
      />
      {own.error && !ov && <div className="ct-card" style={{ marginBottom: 16 }}><ErrorState error={own.error} onRetry={own.refresh} /></div>}

      <div className="ct-grid ct-grid-4" style={{ marginBottom: 16 }}>
        <MetricCard loading={loading} label="Payments today" value={formatNumber(ov?.payments.today)} hint={ov ? `${formatUsdCompact(ov.payments.volumeUsdToday)} USD-equivalent volume` : undefined} href={links.payments()} />
        <MetricCard loading={loading} label="Straight-through success" value={formatPercent(ov?.payments.successRate)} tone={ov && ov.payments.successRate < 0.9 ? 'warn' : 'ok'} hint="Reconciled ÷ completed" />
        <MetricCard loading={loading} label="In flight" value={formatNumber(ov?.payments.inFlight)} hint={ov ? `${formatNumber(ov.payments.held)} held for review` : undefined} href={links.payments({ status: 'held' })} />
        <MetricCard loading={loading} label="Failed" value={formatNumber(ov?.payments.failed)} tone={ov && ov.payments.failed > 0 ? 'bad' : undefined} hint="Eligible for operator retry" href={links.payments({ status: 'failed' })} />
      </div>

      <div className="ct-split" style={{ marginBottom: 16 }}>
        <Card title="Payments per minute" subtitle="Last 30 minutes, by initiation time" actions={trend.data ? <span className="ct-small ct-muted">{formatNumber(lastSum(trend.data.initiated, 5))} in the last 5 min</span> : undefined}>
          {trend.data ? <TrendChart trend={trend.data} /> : trend.error ? <ErrorState error={trend.error} onRetry={trend.refresh} /> : <Skeleton height={150} />}
        </Card>
        <Card title="Open alerts by severity" actions={can('alerts.read') ? <a className="ct-small" href={links.alerts({ status: 'open' })}>Alert queue →</a> : undefined}>
          {!sev ? (
            <Skeleton lines={4} />
          ) : (
            <div className="ct-stack-sm">
              <div className="ct-row" style={{ alignItems: 'baseline' }}>
                <span className="ct-metric-value" style={{ margin: 0 }}>{formatNumber(ov?.alerts.open)}</span>
                <span className="ct-muted">open alerts</span>
              </div>
              <StackedBar label="Alerts by severity" parts={SEVERITIES.map((s) => ({ value: sev[s] ?? 0, tone: s === 'critical' ? 'bad' : s === 'high' ? 'warn' : s === 'medium' ? 'info' : 'neutral', label: s }))} />
              <table className="ct-table ct-table-compact" style={{ marginTop: 8 }}>
                <tbody>
                  {SEVERITIES.map((s) => (
                    <tr key={s}>
                      <td><StatusBadge kind="severity" value={s} /></td>
                      <td className="ct-num">{can('alerts.read') ? <a href={links.alerts({ severity: s, status: 'open' })}>{formatNumber(sev[s] ?? 0)}</a> : formatNumber(sev[s] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="ct-grid ct-grid-4" style={{ marginBottom: 16 }}>
        <MetricCard loading={loading} label="Open cases" value={formatNumber(ov?.cases.open)} hint={ov ? `${formatNumber(ov.cases.myAssigned)} assigned to me` : undefined} href={can('alerts.read') ? links.cases({ status: 'active' }) : undefined} />
        <MetricCard loading={loading} label="SLA breaches" value={formatNumber(ov?.cases.breachingSla)} tone={ov && ov.cases.breachingSla > 0 ? 'bad' : 'ok'} hint="Open cases past their due time" href={can('alerts.read') ? links.cases({ status: 'active', sla: 'breached' }) : undefined} />
        <MetricCard loading={loading} label="Recon breaks" value={formatNumber(ov?.recon.openBreaks)} tone={ov && ov.recon.openBreaks > 0 ? 'warn' : undefined} hint={ov ? `${formatPercent(ov.recon.matchRate)} statement match rate` : undefined} href={can('recon.read') ? links.breaks({ status: 'open' }) : undefined} />
        <MetricCard loading={loading} label="Pending changes" value={formatNumber(ov?.changes.pending)} hint={ov ? `${formatNumber(ov.cases.pendingApproval)} case decisions awaiting approval` : undefined} href={links.changes({ status: 'pending' })} />
      </div>

      <div className="ct-grid ct-grid-2">
        {can('cases.work') && (
          <Card title="My cases" flush actions={<a className="ct-small" href={links.cases({ assignee: 'me' })}>All my cases →</a>}>
            <DataTable compact columns={caseCols} rows={myCases.data?.items} rowKey={(c) => c.caseId} rowHref={(c) => links.case(c.caseId)} loading={myCases.loading} error={myCases.error} skeletonRows={4} empty="No cases assigned to you" emptyHint="Pick up unassigned work from the case queue." />
          </Card>
        )}
        {can('cases.approve') && (
          <Card title="Pending my approval" flush actions={<a className="ct-small" href={links.cases({ status: 'pending_approval' })}>Approval queue →</a>}>
            <DataTable compact columns={caseCols} rows={pendingApproval.data?.items.filter((c) => c.proposal?.by.userId !== user?.id)} rowKey={(c) => c.caseId} rowHref={(c) => links.case(c.caseId)} loading={pendingApproval.loading} error={pendingApproval.error} skeletonRows={4} empty="Nothing waiting for your approval" />
          </Card>
        )}
        <Card title="Where to go next">
          <div className="ct-stack-sm">
            {can('payments.read') && <a href={links.payments({ status: 'held' })}>Held payments awaiting a compliance decision →</a>}
            {can('payments.retry') && <a href={links.payments({ status: 'failed' })}>Failed payments you can retry →</a>}
            {(can('payments.refund.request') || can('payments.refund.approve')) && <a href={links.refunds({ status: 'pending' })}>Refund requests →</a>}
            {can('recon.read') && <a href={links.breaks({ status: 'open' })}>Reconciliation breaks →</a>}
            <a href={links.changes({ status: 'pending' })}>Configuration change requests →</a>
            {can('audit.read') && <a href={links.audit()}>Audit log →</a>}
          </div>
          {user && <p className="ct-small ct-muted" style={{ marginBottom: 0 }}>Signed in as {user.name} ({shortId(user.id)}).</p>}
        </Card>
      </div>
    </Page>
  );
}
