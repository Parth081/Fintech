// Investigator explanations per alert kind: sanctions name comparison, fraud score contributions, AML network.
import type { AlertView } from '@ct/contracts/browser';
import { links } from '../../route';
import { formatPercent } from '../../lib/format';
import { amlPattern, compareNames, contributions, humanizeCode, nameSimilarity, networkLayout, parseRelatedPayments, parseSanctions, scoreBand, type TokenCompare } from './lib/evidence';
import { KIND_LABEL } from './lib/queue';
import { Badge, DateTime, EmptyState, KeyValueList, Money, StatusBadge } from './kit';

export interface Thresholds {
  hold: number;
  reject: number;
}

function toneColor(tone: string): string {
  return tone === 'bad' ? 'var(--ct-bad)' : tone === 'warn' ? 'var(--ct-warn)' : tone === 'ok' ? 'var(--ct-ok)' : 'var(--ct-text-3)';
}

export function AlertExplanation({ alert, thresholds }: { alert: AlertView; thresholds: Thresholds }) {
  return (
    <section className="ct-card" aria-label={`${KIND_LABEL[alert.kind]} alert ${alert.alertId}`}>
      <header className="ct-card-header">
        <div className="ctm-row">
          <StatusBadge kind="severity" value={alert.severity} />
          <h3 className="ct-card-title">{KIND_LABEL[alert.kind]} alert</h3>
          <span className="ct-mono ct-muted">{alert.alertId}</span>
        </div>
        <span className="ct-muted ctm-small">
          <span className="ct-mono">{alert.rule}</span> · <DateTime iso={alert.raisedAt} />
        </span>
      </header>
      <div className="ct-card-body ctm-stack">
        <div>{alert.summary}</div>
        {alert.kind === 'sanctions' && <SanctionsPanel alert={alert} />}
        {alert.kind === 'fraud' && <FraudPanel alert={alert} thresholds={thresholds} />}
        {alert.kind === 'aml' && <AmlPanel alert={alert} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- sanctions

function Tokens({ tokens }: { tokens: TokenCompare[] }) {
  if (!tokens.length) return <span className="ct-muted">Not provided</span>;
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={`ctm-token ctm-token-${t.match}`} title={t.match === 'exact' ? 'Exact token match' : t.match === 'fuzzy' ? 'Close spelling match' : 'No match'}>
          {t.token}
        </span>
      ))}
    </>
  );
}

export function SanctionsPanel({ alert }: { alert: AlertView }) {
  const m = parseSanctions(alert);
  const cmp = compareNames(m.screenedName, m.listName === 'Not provided' ? '' : m.listName);
  const score = m.score ?? (m.listName !== 'Not provided' ? nameSimilarity(m.screenedName, m.listName) : null);
  const tone = score === null ? 'neutral' : score >= 0.9 ? 'bad' : score >= 0.75 ? 'warn' : 'ok';
  return (
    <div className="ctm-stack">
      <div className="ctm-compare">
        <div className="ctm-compare-side">
          <div className="ctm-section-title">Payment party ({m.partyRole})</div>
          <div className="ctm-compare-name">
            <Tokens tokens={cmp.left} />
          </div>
          <KeyValueList items={[['Name as sent', m.screenedName], m.screenedCountry ? ['Country', m.screenedCountry] : null, ['Corridor', alert.payment.corridor]]} />
        </div>
        <div className="ctm-score" aria-label="Match score">
          <div className="ctm-score-value" style={{ color: toneColor(tone) }}>
            {score === null ? '—' : formatPercent(score, 0)}
          </div>
          <div className="ct-muted ctm-small">{m.score === null && score !== null ? 'similarity (UI estimate)' : 'match score'}</div>
          <div className="ctm-meter" style={{ width: 80 }}>
            <span style={{ width: `${Math.round((score ?? 0) * 100)}%`, background: toneColor(tone) }} />
          </div>
          {m.algorithm && <div className="ct-muted ctm-small">{m.algorithm}</div>}
        </div>
        <div className="ctm-compare-side">
          <div className="ctm-section-title">Sanctions list entry</div>
          <div className="ctm-compare-name">
            <Tokens tokens={cmp.right} />
          </div>
          <KeyValueList
            items={[
              ['List', m.listSource ?? 'Not provided'],
              m.listId ? ['Entry id', <span className="ct-mono">{m.listId}</span>] : null,
              m.listCountry ? ['Country', m.listCountry] : null,
              m.aliases.length ? ['Aliases', m.aliases.join(' · ')] : null,
              m.listVersion ? ['List version', m.listVersion] : null,
            ]}
          />
        </div>
      </div>
      <div className="ctm-row ctm-small ct-muted">
        <span className="ctm-token ctm-token-exact">exact</span>
        <span className="ctm-token ctm-token-fuzzy">close spelling</span>
        <span>tokens are compared case- and accent-insensitively. A true match needs more than the name: check country, date of birth and identifiers.</span>
      </div>
      {m.extra.length > 0 && <KeyValueList items={m.extra.map(([k, v]) => [humanizeCode(k), v] as const)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- fraud

export function FraudPanel({ alert, thresholds }: { alert: AlertView; thresholds: Thresholds }) {
  const rows = contributions(alert.reasons, alert.score);
  const score = alert.score === undefined ? null : alert.score > 1 ? alert.score / 100 : alert.score;
  const band = scoreBand(score, thresholds);
  const weighted = alert.reasons.some((r) => typeof r.weight === 'number');
  const rowH = 30;
  const labelW = 210;
  const W = 640;
  const barW = W - labelW - 70;
  const H = rows.length * rowH + 8;
  return (
    <div className="ctm-stack">
      <div className="ctm-row">
        <span className="ctm-strong">Risk score {score === null ? '—' : score.toFixed(2)}</span>
        <Badge tone={band.tone === 'neutral' ? 'neutral' : band.tone}>{band.label}</Badge>
        <span className="ct-muted ctm-small">
          hold ≥ {thresholds.hold.toFixed(2)} · reject ≥ {thresholds.reject.toFixed(2)}
        </span>
      </div>
      {score !== null && (
        <svg className="ctm-svg" viewBox="0 0 640 34" width="100%" role="img" aria-label={`Score ${score.toFixed(2)} against thresholds`}>
          <rect x="0" y="10" width="640" height="10" rx="5" fill="var(--ct-surface-2)" />
          <rect x={640 * thresholds.hold} y="10" width={640 * (thresholds.reject - thresholds.hold)} height="10" fill="var(--ct-warn-soft)" />
          <rect x={640 * thresholds.reject} y="10" width={640 * (1 - thresholds.reject)} height="10" fill="var(--ct-bad-soft)" />
          <line x1={640 * Math.min(1, score)} x2={640 * Math.min(1, score)} y1="4" y2="26" stroke="var(--ct-text)" strokeWidth="2" />
          <text x={Math.min(620, Math.max(4, 640 * score + 4))} y="33" fontSize="10" fill="var(--ct-text-2)">
            {score.toFixed(2)}
          </text>
        </svg>
      )}
      {rows.length === 0 ? (
        <EmptyState title="The model did not report contributing factors" />
      ) : (
        <>
          <div className="ctm-section-title">What drove the score{weighted ? '' : ' (no weights reported: shown equally)'}</div>
          <svg className="ctm-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Score contributions">
            {rows.map((r, i) => {
              const y = i * rowH + 4;
              const w = Math.max(2, r.scaled * barW);
              const neg = r.weight < 0;
              return (
                <g key={r.code}>
                  <title>{`${r.code}: ${r.text}`}</title>
                  <text x={labelW - 8} y={y + 16} fontSize="12" textAnchor="end" fill="var(--ct-text-2)">
                    {humanizeCode(r.code).slice(0, 30)}
                  </text>
                  <rect x={labelW} y={y + 4} width={barW} height="16" rx="3" fill="var(--ct-surface-2)" />
                  <rect x={labelW} y={y + 4} width={w} height="16" rx="3" fill={neg ? 'var(--ct-ok)' : 'var(--ct-accent)'} opacity={0.85} />
                  <text x={labelW + barW + 8} y={y + 16} fontSize="12" fill="var(--ct-text)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {neg ? '−' : '+'}
                    {Math.abs(r.weight).toFixed(2)}
                  </text>
                </g>
              );
            })}
          </svg>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {rows.map((r) => (
              <li key={r.code} style={{ marginBottom: 4 }}>
                {r.text || humanizeCode(r.code)}
                {r.share > 0 && <span className="ct-muted ctm-small"> — explains {formatPercent(r.share, 0)} of the score</span>}
                {r.weight < 0 && <span className="ct-muted ctm-small"> — lowers the risk</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- AML

export function AmlPanel({ alert }: { alert: AlertView }) {
  const related = parseRelatedPayments(alert);
  const net = networkLayout(related);
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  return (
    <div className="ctm-stack">
      <div className="ctm-strong">{amlPattern(related, alert.rule)}</div>
      {alert.reasons.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {alert.reasons.map((r) => (
            <li key={r.code}>{r.text || humanizeCode(r.code)}</li>
          ))}
        </ul>
      )}
      <div className="ctm-section-title">Sender → beneficiary network</div>
      <svg className="ctm-svg" viewBox={`0 0 ${net.width} ${net.height}`} width="100%" style={{ maxHeight: 420 }} role="img" aria-label="Payment network between senders and beneficiaries">
        <text x={net.width * 0.28} y={12} fontSize="11" textAnchor="middle" fill="var(--ct-text-3)">
          SENDERS
        </text>
        <text x={net.width * 0.72} y={12} fontSize="11" textAnchor="middle" fill="var(--ct-text-3)">
          BENEFICIARIES
        </text>
        {net.edges.map((e, i) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          return (
            <g key={i}>
              <path d={`M${a.x + 6},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x - 6},${b.y}`} fill="none" stroke={e.focus ? 'var(--ct-bad)' : 'var(--ct-border-strong)'} strokeWidth={Math.min(6, 1 + e.count)} opacity={e.focus ? 0.9 : 0.7} />
              {e.count > 1 && (
                <text x={mx} y={(a.y + b.y) / 2 - 4} fontSize="10" textAnchor="middle" fill="var(--ct-text-2)">
                  ×{e.count}
                </text>
              )}
            </g>
          );
        })}
        {net.nodes.map((n) => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={6} fill={n.focus ? 'var(--ct-bad)' : 'var(--ct-accent)'} stroke="var(--ct-surface)" strokeWidth="2" />
            <text x={n.side === 'sender' ? n.x - 12 : n.x + 12} y={n.y + 4} fontSize="12" textAnchor={n.side === 'sender' ? 'end' : 'start'} fill={n.focus ? 'var(--ct-text)' : 'var(--ct-text-2)'} fontWeight={n.focus ? 600 : 400}>
              {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>
      <div className="ct-muted ctm-small">Red: the parties of the alerted payment. Line width grows with the number of payments.</div>
      <div className="ctm-section-title">Related payments ({related.length})</div>
      <div className="ct-table-wrap">
        <table className="ct-table ctm-table-dense">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Sender</th>
              <th>Beneficiary</th>
              <th className="ct-num">Amount</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {related.map((p) => (
              <tr key={p.paymentId} style={p.current ? { background: 'var(--ct-accent-soft)' } : undefined}>
                <td>
                  <a className="ctm-link ct-mono" href={links.payment(p.paymentId)}>
                    {p.paymentId}
                  </a>
                  {p.current && <span className="ct-muted ctm-small"> (this payment)</span>}
                </td>
                <td>{p.debtorName}</td>
                <td>{p.creditorName}</td>
                <td className="ct-num">
                  <Money value={p.amount} />
                </td>
                <td>{p.status ? <StatusBadge kind="payment" value={p.status} /> : '—'}</td>
                <td className="ctm-small">{p.at ? <DateTime iso={p.at} relative /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
