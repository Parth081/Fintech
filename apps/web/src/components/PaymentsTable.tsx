import { formatMoney } from '@ct/contracts/browser';
import { corridorLabel, elapsedMs, formatDuration, providerName, shortId, STAGE_LABELS } from '../lib/format';
import type { PaymentSummary } from '../lib/types';
import { ProgressTrack } from './ProgressTrack';

interface Props {
  payments: PaymentSummary[];
  now: number;
  lastChanged: { paymentId: string; seq: number } | null;
  selectedId: string | null;
  onSelect(id: string): void;
}

export function PaymentsTable({ payments, now, lastChanged, selectedId, onSelect }: Props) {
  return (
    <section className="table-wrap" aria-label="Live payments">
      <h2 className="section-title">Live payments</h2>
      {payments.length === 0 ? (
        <p className="empty">No payments yet. Press “Send test payment” to start one.</p>
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
            {payments.map((p) => {
              const flash = lastChanged !== null && lastChanged.paymentId === p.paymentId;
              const cls = [
                'row',
                flash ? 'row-flash' : '',
                selectedId === p.paymentId ? 'row-selected' : '',
                p.status === 'held' || p.status === 'rejected' ? 'row-stopped' : '',
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
