import { formatMoney } from '@ct/contracts/browser';
import type { AttemptsSummary } from '../lib/attempts';
import { formatClock, formatDuration, formatPct, providerName } from '../lib/format';

const OUTCOME_TEXT = { routed: 'Routed', sent: 'Sent · awaiting pacs.002', settled: 'Settled (ACSC)', rejected: 'Rejected (RJCT)' } as const;

const num = (x: number, f: (n: number) => string) => (Number.isFinite(x) ? f(x) : '—');

export function AttemptsTimeline({ summary }: { summary: AttemptsSummary }) {
  if (summary.attempts.length === 0) return <p className="empty">Not routed yet.</p>;
  return (
    <ol className="attempts">
      {summary.attempts.map((a) => (
        <li key={`${a.attempt}-${a.routedAt}`} className={`attempt attempt-${a.outcome}`}>
          <div className="attempt-head">
            <span className="attempt-n">Attempt {a.attempt}</span>
            <strong>{providerName(a.providerId)}</strong>
            <span className="tl-meta mono">
              {a.rail} · fee {formatMoney(a.estimatedFee)} · {formatClock(a.routedAt)}
            </span>
            <span className={`outcome outcome-${a.outcome}`}>
              {OUTCOME_TEXT[a.outcome]}
              {a.reasonCode && <span className="code">{a.reasonCode}</span>}
            </span>
          </div>
          {a.reason && <div className="attempt-reason">Provider reason: {a.reason}</div>}
          {a.excludedProviders.length > 0 && (
            <div className="attempt-reason">Excluded after earlier failures: {a.excludedProviders.map(providerName).join(', ')}</div>
          )}
          <table className="scoring">
            <thead>
              <tr>
                <th>Provider</th>
                <th className="num">Fee</th>
                <th className="num">Success</th>
                <th className="num">Latency</th>
                <th className="num">Score</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {a.scoring.map((s) => (
                <tr key={s.providerId} className={s.chosen ? 'score-chosen' : s.eligible ? '' : 'score-excluded'}>
                  <td>{providerName(s.providerId)}</td>
                  <td className="num mono">{Number.isFinite(s.fee.amountMinor) ? formatMoney(s.fee) : '—'}</td>
                  <td className="num mono">{num(s.successRate, (x) => formatPct(x))}</td>
                  <td className="num mono">{num(s.latencyMs, formatDuration)}</td>
                  <td className="num mono">{num(s.score, (x) => x.toFixed(3))}</td>
                  <td>{s.chosen ? <strong className="ok">Chosen ✓</strong> : s.eligible ? 'Eligible' : <span className="code">{s.excludedReason ?? 'EXCLUDED'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!a.fullScoring && <div className="tl-meta">No scoring table on this event (pre-M2 router): alternatives only.</div>}
        </li>
      ))}
      {summary.failed && (
        <li className="attempt attempt-failed">
          <div className="attempt-head">
            <strong className="bad">Payment failed</strong>
            <span className="tl-meta mono">{formatClock(summary.failed.at)}</span>
          </div>
          <div className="attempt-reason">
            {summary.failed.reason}
            {summary.failed.attempts ? ` (${summary.failed.attempts} attempts; nothing posted to the ledger)` : ''}
          </div>
        </li>
      )}
    </ol>
  );
}
