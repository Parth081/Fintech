import { useCallback, useState } from 'react';
import { formatMoney } from '@ct/contracts/browser';
import { fetchProviders } from '../lib/api';
import { corridorLabel, formatClock, formatCount, formatDuration, formatPct, shortId } from '../lib/format';
import { usePoll } from '../hooks/usePoll';
import { StatementViewer } from './StatementViewer';

export function ProvidersView() {
  const providers = usePoll(fetchProviders, 3000);
  const [statement, setStatement] = useState<{ providerId: string; date: string; currency: string } | null>(null);
  const close = useCallback(() => setStatement(null), []);
  return (
    <div className="view">
      {providers.error && <p className="msg-error">⚠ {providers.error}</p>}
      {!providers.data && !providers.error && <p className="empty">Loading…</p>}
      <div className="cards">
        {providers.data?.map((p) => {
          const observed = p.health?.successRate ?? p.observed.successRate;
          const catalogue = p.catalogue.baseSuccessRate;
          const below = observed !== null && catalogue !== null && observed < catalogue - 0.02;
          return (
            <section key={p.providerId} className="card">
              <div className="card-head">
                <h2>{p.name}</h2>
                <span className="tl-meta">
                  {p.rail}
                  {p.bic ? ` · ${p.bic}` : ''}
                </span>
              </div>
              <div className="share">
                <div className="share-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(p.shareOfVolume * 100)}%` }} />
                </div>
                <span className="share-text">
                  <strong>{formatPct(p.shareOfVolume, 0)}</strong> of settled volume
                </span>
              </div>
              <dl className="card-stats">
                <div>
                  <dt>Success (observed)</dt>
                  <dd className={`mono${below ? ' bad' : ''}`}>{formatPct(observed)}</dd>
                </div>
                <div>
                  <dt>Success (catalogue)</dt>
                  <dd className="mono">{formatPct(catalogue)}</dd>
                </div>
                <div>
                  <dt>Avg latency</dt>
                  <dd className="mono">{formatDuration(p.health?.avgLatencyMs ?? p.observed.avgLatencyMs)}</dd>
                </div>
                <div>
                  <dt>Avg fee</dt>
                  <dd className="mono">
                    {p.avgFeeBps === null ? '—' : `${p.avgFeeBps} bps`}
                    {p.avgFee.length > 0 && <span className="tl-meta"> · {p.avgFee.map((m) => formatMoney(m)).join(', ')}</span>}
                  </dd>
                </div>
                <div>
                  <dt>Settled / sent</dt>
                  <dd className="mono">
                    {formatCount(p.observed.settled)} / {formatCount(p.observed.sent)}
                  </dd>
                </div>
                <div>
                  <dt>Retries caused</dt>
                  <dd className={`mono${p.retriesCaused ? ' warn' : ''}`}>{formatCount(p.retriesCaused)}</dd>
                </div>
              </dl>
              <div className="tl-meta">Corridors: {p.corridors.map(corridorLabel).join(' · ') || '—'}</div>
              {p.healthError && <div className="tl-meta">Market health unavailable ({p.healthError}); showing gateway counters.</div>}
              <h3 className="card-sub">Recent failures</h3>
              {Object.keys(p.failureReasons).length > 0 && (
                <div className="codes">
                  {Object.entries(p.failureReasons)
                    .sort((a, b) => b[1] - a[1])
                    .map(([code, n]) => (
                      <span key={code} className="code">
                        {code} × {formatCount(n)}
                      </span>
                    ))}
                </div>
              )}
              {p.recentFailures.length === 0 ? (
                <p className="empty">None.</p>
              ) : (
                <ul className="failures">
                  {p.recentFailures.slice(0, 5).map((f) => (
                    <li key={`${f.paymentId}-${f.attempt}`}>
                      <span className="code">{f.reasonCode}</span> <span>{f.reason}</span>{' '}
                      <span className="tl-meta mono">
                        {shortId(f.paymentId)} · #{f.attempt} · {formatClock(f.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="card-foot">
                {p.latestStatement ? (
                  <button type="button" className="btn btn-small" onClick={() => setStatement({ providerId: p.providerId, ...p.latestStatement! })}>
                    camt.053 · {p.latestStatement.date} · {p.latestStatement.currency}
                  </button>
                ) : (
                  <span className="tl-meta">No statement yet</span>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {statement && <StatementViewer {...statement} onClose={close} />}
    </div>
  );
}
