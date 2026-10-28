// Treasury overview: reconciliation health, FX positions, provider payables and today's volumes.
import { useMemo } from 'react';
import { links } from '../../route';
import { useApi } from '../../ui/hooks';
import { formatMoney, formatNumber, formatPercent, formatUsdCompact } from '../../lib/format';
import { providerName } from '../../../lib/format';
import { treasuryApi } from './data';
import { fxPositions, matchRate, providerBalances, volumesToday, type VolumeRow } from './lib/treasury';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, MetricCard } from '../risk/kit';

export default function OverviewTab({ now, openBreaks }: { now: number; openBreaks: number | null }) {
  const accounts = useApi((s) => treasuryApi.accounts(s), [], { intervalMs: 10_000 });
  const stats = useApi((s) => treasuryApi.stats(s), [], { intervalMs: 10_000 });
  const day = new Date(now).toDateString();
  const payments = useApi((s) => treasuryApi.paymentsToday(Date.now(), s), [day], { intervalMs: 15_000 });

  const positions = useMemo(() => fxPositions(accounts.data ?? []), [accounts.data]);
  const payables = useMemo(() => providerBalances(accounts.data ?? []), [accounts.data]);
  const byCorridor = useMemo(() => volumesToday(payments.data?.items ?? [], 'corridor', now), [payments.data, now]);
  const byProvider = useMemo(() => volumesToday(payments.data?.items ?? [], 'provider', now), [payments.data, now]);
  const rate = stats.data ? matchRate(stats.data.reconMatched, stats.data.reconBreaks) : null;
  const volumeUsd = byCorridor.reduce((s, r) => s + r.usd, 0);
  const payableUsd = payables.reduce((s, p) => s + (p.usd ?? 0), 0);
  const maxPos = Math.max(1, ...positions.map((p) => Math.abs(p.usd ?? 0)));

  return (
    <div className="ctm-stack">
      <div className="ct-grid ct-grid-4">
        <MetricCard
          label="Reconciliation match rate"
          value={formatPercent(rate)}
          tone={rate === null ? undefined : rate >= 0.98 ? 'ok' : rate >= 0.9 ? 'warn' : 'bad'}
          delta={stats.data ? `${formatNumber(stats.data.reconMatched)} matched · ${formatNumber(stats.data.reconBreaks)} breaks` : 'Loading…'}
        />
        <MetricCard label="Open breaks" value={openBreaks === null ? '—' : formatNumber(openBreaks)} tone={openBreaks ? 'warn' : 'ok'} delta={<a className="ctm-link" href={links.breaks()}>Work the queue →</a>} />
        <MetricCard
          label="Today’s volume (indicative USD)"
          value={formatUsdCompact(volumeUsd)}
          delta={payments.data ? `${formatNumber(payments.data.total)} payments since midnight${payments.data.total > payments.data.items.length ? ` (first ${payments.data.items.length} summed)` : ''}` : 'Loading…'}
        />
        <MetricCard label="Owed to providers (indicative USD)" value={formatUsdCompact(payableUsd)} delta={`${payables.length} payable account${payables.length === 1 ? '' : 's'}`} />
      </div>

      <div className="ct-grid ct-grid-2">
        <Card title="FX positions" subtitle="Ledger fx-position accounts · long = currency bought, short = sold" flush>
          {accounts.error && !accounts.data ? (
            <ErrorState error={accounts.error} onRetry={accounts.refresh} />
          ) : accounts.loading ? (
            <div className="ct-card-body">
              <LoadingBlock />
            </div>
          ) : positions.length === 0 ? (
            <EmptyState title="No FX positions yet" hint="Positions appear once cross-currency payments settle." />
          ) : (
            <div className="ct-table-wrap">
              <table className="ct-table ctm-table-dense">
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th className="ct-num">Bought</th>
                    <th className="ct-num">Sold</th>
                    <th className="ct-num">Net position</th>
                    <th style={{ width: 140 }}>Indicative USD</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const w = Math.round((Math.abs(p.usd ?? 0) / maxPos) * 50);
                    return (
                      <tr key={p.accountId}>
                        <td>
                          <span className="ctm-strong">{p.currency}</span>{' '}
                          <Badge tone={p.direction === 'long' ? 'ok' : p.direction === 'short' ? 'bad' : 'neutral'}>{p.direction}</Badge>
                        </td>
                        <td className="ct-num">{formatMoney({ amountMinor: p.boughtMinor, currency: p.currency })}</td>
                        <td className="ct-num">{formatMoney({ amountMinor: p.soldMinor, currency: p.currency })}</td>
                        <td className="ct-num ctm-strong">{formatMoney({ amountMinor: p.netMinor, currency: p.currency })}</td>
                        <td>
                          <div className="ctm-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                            <svg width="100" height="10" aria-hidden="true">
                              <rect x="0" y="0" width="100" height="10" rx="2" fill="var(--ct-surface-2)" />
                              <line x1="50" x2="50" y1="0" y2="10" stroke="var(--ct-border-strong)" />
                              <rect x={p.direction === 'short' ? 50 - w : 50} y="1" width={w} height="8" rx="2" fill={p.direction === 'short' ? 'var(--ct-bad)' : 'var(--ct-ok)'} />
                            </svg>
                            <span className="ct-num ctm-small">{formatUsdCompact(p.usd)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Provider payables" subtitle="What we owe each payout provider (provider:<id>:payable:<CCY>)" flush>
          {accounts.loading ? (
            <div className="ct-card-body">
              <LoadingBlock />
            </div>
          ) : payables.length === 0 ? (
            <EmptyState title="No provider balances yet" />
          ) : (
            <div className="ct-table-wrap">
              <table className="ct-table ctm-table-dense">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Currency</th>
                    <th className="ct-num">Payable</th>
                    <th className="ct-num">Indicative USD</th>
                    <th className="ct-num">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {payables.map((p) => (
                    <tr key={p.accountId}>
                      <td>{providerName(p.providerId)}</td>
                      <td>{p.currency}</td>
                      <td className="ct-num ctm-strong">{formatMoney({ amountMinor: p.payableMinor, currency: p.currency })}</td>
                      <td className="ct-num">{formatUsdCompact(p.usd)}</td>
                      <td className="ct-num">{formatNumber(p.entryCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="ct-grid ct-grid-2">
        <VolumeCard title="Today by corridor" rows={byCorridor} loading={payments.loading} error={payments.error} label={(k) => k} />
        <VolumeCard title="Today by provider" rows={byProvider} loading={payments.loading} error={payments.error} label={(k) => (k === 'unrouted' ? 'Not routed yet' : providerName(k))} />
      </div>
      <div className="ct-muted ctm-small">USD values use fixed indicative reference rates for side-by-side sizing; ledger amounts are exact in their own currency.</div>
    </div>
  );
}

function VolumeCard({ title, rows, loading, error, label }: { title: string; rows: VolumeRow[]; loading: boolean; error: string | null; label(k: string): string }) {
  const total = rows.reduce((s, r) => s + r.usd, 0) || 1;
  return (
    <Card title={title} flush>
      {error && !rows.length ? (
        <ErrorState error={error} />
      ) : loading ? (
        <div className="ct-card-body">
          <LoadingBlock />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No payments today yet" />
      ) : (
        <div className="ct-table-wrap">
          <table className="ct-table ctm-table-dense">
            <thead>
              <tr>
                <th>{title.endsWith('corridor') ? 'Corridor' : 'Provider'}</th>
                <th className="ct-num">Payments</th>
                <th className="ct-num">Settled</th>
                <th>Source volume</th>
                <th style={{ width: 150 }}>Share (USD)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="ctm-strong">{label(r.key)}</td>
                  <td className="ct-num">{formatNumber(r.count)}</td>
                  <td className="ct-num">{formatNumber(r.settled)}</td>
                  <td className="ctm-small">
                    {Object.entries(r.bySource)
                      .map(([ccy, minor]) => formatMoney({ amountMinor: minor, currency: ccy }))
                      .join(' · ')}
                  </td>
                  <td>
                    <div className="ctm-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <div className="ctm-meter" style={{ width: 70 }}>
                        <span style={{ width: `${Math.round((r.usd / total) * 100)}%`, background: 'var(--ct-accent)' }} />
                      </div>
                      <span className="ct-num ctm-small">{formatUsdCompact(r.usd)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
