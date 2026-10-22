import { useState } from 'react';
import { CORRIDORS, PROVIDERS, formatMoney } from '@ct/contracts/browser';
import { fetchPaymentsPage } from '../lib/api';
import { ALL_STATUSES, corridorLabel, elapsedMs, formatCount, formatDuration, providerName, shortId, STAGE_LABELS } from '../lib/format';
import { usePoll } from '../hooks/usePoll';
import type { PaymentSummary } from '../lib/types';
import { ProgressTrack } from './ProgressTrack';

const PAGE_SIZE = 50;

interface Props {
  /** Newest payments from the live feed (used for the unfiltered first page). */
  livePayments: PaymentSummary[];
  liveTotal: number;
  now: number;
  lastChanged: { paymentId: string; seq: number } | null;
  selectedId: string | null;
  onSelect(id: string): void;
}

interface Filter {
  status: string;
  corridor: string;
  provider: string;
}

export function PaymentsTable({ livePayments, liveTotal, now, lastChanged, selectedId, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>({ status: '', corridor: '', provider: '' });
  const [page, setPage] = useState(0);
  const filtered = Boolean(filter.status || filter.corridor || filter.provider);
  const useLive = !filtered && page === 0;
  const key = JSON.stringify({ filter, page, useLive });
  const remote = usePoll(
    (signal) =>
      useLive
        ? Promise.resolve(null)
        : fetchPaymentsPage({ ...filter, offset: page * PAGE_SIZE, limit: PAGE_SIZE }, signal),
    useLive ? 0 : 2000,
    key,
  );

  const rows = useLive ? livePayments.slice(0, PAGE_SIZE) : (remote.data?.items ?? []);
  const total = useLive ? liveTotal : (remote.data?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const set = (patch: Partial<Filter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  return (
    <section className="table-wrap" aria-label="Payments">
      <div className="table-head">
        <h2 className="section-title">{useLive ? 'Live payments' : 'Payments'}</h2>
        <div className="filters">
          <label>
            Status
            <select value={filter.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All</option>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s].title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Corridor
            <select value={filter.corridor} onChange={(e) => set({ corridor: e.target.value })}>
              <option value="">All</option>
              {CORRIDORS.map((c) => (
                <option key={c.id} value={c.id}>
                  {corridorLabel(c.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select value={filter.provider} onChange={(e) => set({ provider: e.target.value })}>
              <option value="">All</option>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="pager">
            <button type="button" className="btn btn-small" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ‹ Newer
            </button>
            <span className="mono pager-text">
              {total === 0 ? '0' : `${formatCount(page * PAGE_SIZE + 1)}–${formatCount(Math.min(total, (page + 1) * PAGE_SIZE))}`} of{' '}
              {formatCount(total)}
            </span>
            <button type="button" className="btn btn-small" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              Older ›
            </button>
          </div>
        </div>
      </div>
      {remote.error && !useLive && <p className="msg-error">⚠ {remote.error}</p>}
      {rows.length === 0 ? (
        <p className="empty">
          {useLive ? 'No payments yet. Press “Send test payment” to start one.' : remote.data ? 'No payments match.' : 'Loading…'}
        </p>
      ) : (
        <table className="payments">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Corridor</th>
              <th className="num">Amount</th>
              <th className="num">Target amount</th>
              <th>Status</th>
              <th>Provider</th>
              <th className="num">Elapsed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const flash = useLive && lastChanged !== null && lastChanged.paymentId === p.paymentId;
              const cls = [
                'row',
                flash ? 'row-flash' : '',
                selectedId === p.paymentId ? 'row-selected' : '',
                p.status === 'held' || p.status === 'rejected' || p.status === 'failed' ? 'row-stopped' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <tr
                  key={flash ? `${p.paymentId}:${lastChanged.seq}` : p.paymentId}
                  className={cls}
                  tabIndex={0}
                  aria-selected={selectedId === p.paymentId}
                  onClick={() => onSelect(p.paymentId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(p.paymentId);
                    }
                  }}
                >
                  <td className="mono" title={p.paymentId}>
                    {shortId(p.paymentId)}
                    {p.scenario && <span className="tag">{p.scenario}</span>}
                  </td>
                  <td>{corridorLabel(p.corridor)}</td>
                  <td className="num mono">{formatMoney(p.amount)}</td>
                  <td className="num mono">{p.targetAmount ? formatMoney(p.targetAmount) : '—'}</td>
                  <td>
                    <div className="status-cell">
                      <ProgressTrack payment={p} />
                      <span className={`status status-${p.status}`}>{STAGE_LABELS[p.status].title}</span>
                      {p.retries > 0 && (
                        <span className="tag tag-warn" title={`${p.retries} provider reject(s)`}>
                          ↻{p.retries}
                        </span>
                      )}
                      {p.recon === 'break' && <span className="tag tag-bad">break</span>}
                    </div>
                  </td>
                  <td>{providerName(p.providerId)}</td>
                  <td className="num mono">{formatDuration(elapsedMs(p, now))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
