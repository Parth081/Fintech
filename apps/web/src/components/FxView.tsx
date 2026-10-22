import { fetchFxRates } from '../lib/api';
import { corridorLabel, formatClock, formatCount, formatDuration } from '../lib/format';
import { changeRatio } from '../lib/sparkline';
import { usePoll } from '../hooks/usePoll';
import { Sparkline } from './Sparkline';

export function FxView() {
  const fx = usePoll(fetchFxRates, 5000);
  return (
    <div className="view">
      {fx.error && <p className="msg-error">⚠ {fx.error}</p>}
      {!fx.data && !fx.error && <p className="empty">Loading…</p>}
      <div className="cards">
        {fx.data?.map((c) => {
          const values = c.series.map((p) => Number(p.mid));
          const ch = changeRatio(values[0] ?? null, values.at(-1) ?? null);
          const windowMs = c.series.length > 1 ? c.series.at(-1)!.atMs - c.series[0]!.atMs : 0;
          return (
            <section key={c.corridorId} className="card">
              <div className="card-head">
                <h2>{corridorLabel(c.corridorId)}</h2>
                <span className="mono tl-meta">
                  {c.sourceCurrency}/{c.targetCurrency}
                </span>
              </div>
              <div className="fx-mid mono">{c.mid ?? '—'}</div>
              <div className="tl-meta">
                market mid · {formatClock(new Date(c.atMs).toISOString())}
                {ch !== null && (
                  <span className={ch >= 0 ? 'ok' : 'bad'}>
                    {' '}
                    {ch >= 0 ? '▲' : '▼'} {(Math.abs(ch) * 100).toFixed(3)}% in {formatDuration(windowMs)}
                  </span>
                )}
              </div>
              {c.marketError ? (
                <p className="msg-error">Market unavailable: {c.marketError}</p>
              ) : (
                <Sparkline values={values} label={`${c.corridorId} mid rate, last ${formatDuration(windowMs)}`} />
              )}
              <dl className="card-stats">
                <div>
                  <dt>Avg spread</dt>
                  <dd className="mono">{c.quotes.avgSpreadBps === null ? '—' : `${c.quotes.avgSpreadBps} bps`}</dd>
                </div>
                <div>
                  <dt>Quotes</dt>
                  <dd className="mono">{formatCount(c.quotes.count)}</dd>
                </div>
                <div>
                  <dt>Last rate</dt>
                  <dd className="mono">{c.quotes.lastRate ?? '—'}</dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}
