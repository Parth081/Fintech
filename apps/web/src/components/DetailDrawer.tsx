import { useEffect, useState } from 'react';
import { fetchDetail } from '../lib/api';
import { formatClock, formatDuration, STAGE_LABELS, EVENT_LABELS } from '../lib/format';
import { formatInput, keyFacts, ledgerCheck, ledgerRows, timelineRows } from '../lib/detail';
import type { PaymentDetail } from '../lib/types';

interface Props {
  paymentId: string;
  /** Changes whenever this payment receives a new event, so the drawer refreshes. */
  version: number;
  onClose(): void;
}

export function DetailDrawer({ paymentId, version, onClose }: Props) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDetail(paymentId, ctrl.signal).then(
      (d) => {
        setDetail(d);
        setError(null);
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => ctrl.abort();
  }, [paymentId, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = detail && detail.state.paymentId === paymentId ? detail : null;
  const entries = current?.state.facts['ledger.posted']?.entries;
  const check = ledgerCheck(entries);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Payment ${paymentId}`}>
        <div className="drawer-head">
          <div>
            <h2>Payment</h2>
            <div className="mono drawer-id">{paymentId}</div>
          </div>
          {current && <span className={`status status-${current.state.status}`}>{STAGE_LABELS[current.state.status].title}</span>}
          <button type="button" className="btn btn-close" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>

        {error && <p className="msg-error">⚠ {error}</p>}
        {!current && !error && <p className="empty">Loading…</p>}

        {current && (
          <div className="drawer-body">
            <section>
              <h3>Key facts</h3>
              <dl className="facts">
                {keyFacts(current.state).map((f) => (
                  <div key={f.label} className="fact">
                    <dt>{f.label}</dt>
                    <dd className="mono">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <h3>Event timeline</h3>
              <ol className="timeline">
                {timelineRows(current.events).map((r) => (
                  <li key={r.eventId} className={`tl-item tl-${r.type.replace('.', '-')}`}>
                    <div className="tl-head">
                      <span className="tl-type">{EVENT_LABELS[r.type]}</span>
                      <span className="tl-meta mono">
                        {formatClock(r.occurredAt)} · {r.producer}
                        {r.sincePrevMs !== null && <> · +{formatDuration(r.sincePrevMs)}</>}
                        {r.stageLatencyMs !== null && <> · stage {formatDuration(r.stageLatencyMs)}</>}
                      </span>
                    </div>
                    <div className="tl-code mono">{r.type}</div>
                    {r.trace ? (
                      <div className="trace">
                        <div>
                          <span className="trace-k">Decision</span> <strong>{r.trace.decision}</strong>
                          <span className="trace-k"> · rule</span> <span className="mono">{r.trace.ruleVersion}</span>
                        </div>
                        <div className="codes">
                          {r.trace.reasonCodes.map((c) => (
                            <span key={c} className="code">
                              {c}
                            </span>
                          ))}
                        </div>
                        {Object.keys(r.trace.inputs).length > 0 && (
                          <dl className="inputs">
                            {Object.entries(r.trace.inputs).map(([k, v]) => (
                              <div key={k}>
                                <dt>{k}</dt>
                                <dd className="mono">{formatInput(v)}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>
                    ) : (
                      <div className="trace trace-none">No decision trace</div>
                    )}
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h3>
                Ledger journal{' '}
                {check.present &&
                  (check.balanced ? <span className="balanced">Balanced ✓</span> : <span className="unbalanced">Not balanced ✗</span>)}
              </h3>
              {entries ? (
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th className="num">Debit</th>
                      <th className="num">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows(entries).map((row, i) => (
                      <tr key={i}>
                        <td className="mono">{row.account}</td>
                        <td className="num mono">{row.debit}</td>
                        <td className="num mono">{row.credit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty">Not posted yet (posted after settlement).</p>
              )}
            </section>
          </div>
        )}
      </aside>
    </>
  );
}
