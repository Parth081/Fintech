import { useEffect, useMemo, useState } from 'react';
import type { AccountType, JournalView } from '@ct/contracts/browser';
import { fetchAccount, fetchDetail, fetchJournals, fetchMessages } from '../lib/api';
import { formatClock, formatDuration, STAGE_LABELS, EVENT_LABELS } from '../lib/format';
import { formatInput, keyFacts, ledgerCheck, ledgerRows, quoteView, reconView, timelineRows } from '../lib/detail';
import { attemptsFrom } from '../lib/attempts';
import { journalBalanced, journalRows } from '../lib/ledger';
import type { IsoMessage, PaymentDetail } from '../lib/types';
import { AttemptsTimeline } from './AttemptsTimeline';
import { XmlViewer } from './XmlViewer';

interface Props {
  paymentId: string;
  /** Changes whenever this payment receives a new event, so the drawer refreshes. */
  version: number;
  onClose(): void;
}

/** Account types rarely change: cache them for the session. */
const accountTypes = new Map<string, AccountType>();

function useLedgerJournals(paymentId: string, posted: boolean, version: number) {
  const [journals, setJournals] = useState<JournalView[] | null>(null);
  const [types, setTypes] = useState<ReadonlyMap<string, AccountType>>(accountTypes);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setJournals(null);
    setError(null);
  }, [paymentId]);
  useEffect(() => {
    if (!posted) return;
    const ctrl = new AbortController();
    fetchJournals(paymentId, ctrl.signal)
      .then(async (js) => {
        setJournals(js);
        setError(null);
        const missing = [...new Set(js.flatMap((j) => j.entries.map((e) => e.accountId)))].filter((a) => !accountTypes.has(a));
        await Promise.all(
          missing.map((a) =>
            fetchAccount(a, ctrl.signal).then(
              (acc) => accountTypes.set(a, acc.type),
              () => undefined,
            ),
          ),
        );
        if (!ctrl.signal.aborted) setTypes(new Map(accountTypes));
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [paymentId, posted, version]);
  return { journals, types, error };
}

export function DetailDrawer({ paymentId, version, onClose }: Props) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [messages, setMessages] = useState<IsoMessage[]>([]);
  const [msgIndex, setMsgIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMsgIndex(null);
    setMessages([]);
  }, [paymentId]);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([fetchDetail(paymentId, ctrl.signal), fetchMessages(paymentId, ctrl.signal).catch(() => [] as IsoMessage[])]).then(
      ([d, m]) => {
        setDetail(d);
        setMessages(m);
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
  const ledger = useLedgerJournals(paymentId, Boolean(current?.state.ledgerPosted), version);
  const attempts = useMemo(() => (current ? attemptsFrom(current.events) : null), [current]);
  const quotedAt = current?.events.find((e) => e.type === 'payment.quoted')?.occurredAt;
  const quote = current ? quoteView(current.state, quotedAt) : null;
  const recon = current ? reconView(current.state) : null;
  const eventEntries = current?.state.facts['ledger.posted']?.entries;
  const eventCheck = ledgerCheck(eventEntries);
  const shownMsg = messages.length ? messages[Math.min(msgIndex ?? messages.length - 1, messages.length - 1)] : undefined;

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

            {quote && (
              <section>
                <h3>FX quote</h3>
                <dl className="facts">
                  <div className="fact"><dt>Market mid</dt><dd className="mono">{quote.mid ?? '—'}</dd></div>
                  <div className="fact"><dt>Customer rate</dt><dd className="mono">{quote.rate}</dd></div>
                  <div className="fact">
                    <dt>Spread</dt>
                    <dd className="mono">
                      {quote.spreadBps} bps{quote.effectiveSpreadBps !== null && quote.effectiveSpreadBps !== quote.spreadBps ? ` (effective ${quote.effectiveSpreadBps})` : ''}
                    </dd>
                  </div>
                  <div className="fact"><dt>Converts</dt><dd className="mono">{quote.source} → {quote.target}</dd></div>
                  <div className="fact"><dt>Market tick</dt><dd className="mono">{quote.rateTimestamp ? formatClock(quote.rateTimestamp) : '—'}</dd></div>
                  <div className="fact">
                    <dt>Expires</dt>
                    <dd className="mono">{formatClock(quote.expiresAt)}{quote.validForMs !== null ? ` (valid ${formatDuration(quote.validForMs)})` : ''}</dd>
                  </div>
                </dl>
              </section>
            )}

            <section>
              <h3>Routing attempts</h3>
              {attempts && <AttemptsTimeline summary={attempts} />}
            </section>

            <section>
              <h3>ISO 20022 messages</h3>
              {messages.length === 0 ? (
                <p className="empty">No messages yet (pacs.008 is built when the payment is sent).</p>
              ) : (
                <>
                  <div className="msg-tabs" role="tablist">
                    {messages.map((m, i) => (
                      <button
                        key={m.eventId}
                        type="button"
                        role="tab"
                        aria-selected={m === shownMsg}
                        className={`msg-tab${m === shownMsg ? ' msg-tab-active' : ''}${m.status === 'RJCT' ? ' msg-tab-bad' : ''}`}
                        onClick={() => setMsgIndex(i)}
                      >
                        {m.messageType}
                        {m.status ? ` ${m.status}` : ''}
                        {m.attempt !== undefined ? ` · #${m.attempt}` : ''}
                      </button>
                    ))}
                  </div>
                  {shownMsg && (
                    <XmlViewer
                      xml={shownMsg.xml}
                      title={`${shownMsg.messageType} · ${shownMsg.providerId} · ${formatClock(shownMsg.occurredAt)}${shownMsg.reasonCode ? ` · reason ${shownMsg.reasonCode}` : ''}`}
                    />
                  )}
                </>
              )}
            </section>

            <section>
              <h3>
                Ledger journal
                {ledger.journals && ledger.journals.length > 0 &&
                  (ledger.journals.every(journalBalanced) ? <span className="balanced">Balanced ✓</span> : <span className="unbalanced">Not balanced ✗</span>)}
              </h3>
              {!current.state.ledgerPosted ? (
                <p className="empty">
                  {current.state.status === 'failed' ? 'Nothing posted: the payment failed before settlement.' : 'Not posted yet (posted after settlement).'}
                </p>
              ) : ledger.journals && ledger.journals.length > 0 ? (
                ledger.journals.map((j) => (
                  <div key={j.journalId} className="journal">
                    <div className="tl-meta mono">
                      {j.journalId} · {j.kind} · {formatClock(j.postedAt)}
                    </div>
                    <table className="ledger">
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Type</th>
                          <th className="num">Debit</th>
                          <th className="num">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {journalRows(j, ledger.types).map((row, i) => (
                          <tr key={i}>
                            <td className="mono">{row.accountId}</td>
                            <td>{row.type}</td>
                            <td className="num mono">{row.debit}</td>
                            <td className="num mono">{row.credit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              ) : (
                <>
                  <p className="tl-meta">
                    {ledger.error ? `Ledger service: ${ledger.error}. Showing the entries carried on the ledger.posted event.` : ledger.journals ? 'Ledger service has no journal for this payment yet; showing the event entries.' : 'Loading from the ledger service…'}
                    {eventCheck.present && (eventCheck.balanced ? <span className="balanced">Balanced ✓</span> : <span className="unbalanced">Not balanced ✗</span>)}
                  </p>
                  {eventEntries && (
                    <table className="ledger">
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th className="num">Debit</th>
                          <th className="num">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerRows(eventEntries).map((row, i) => (
                          <tr key={i}>
                            <td className="mono">{row.account}</td>
                            <td className="num mono">{row.debit}</td>
                            <td className="num mono">{row.credit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </section>

            <section>
              <h3>
                Reconciliation
                {recon && (recon.matched ? <span className="balanced">Matched ✓</span> : <span className="unbalanced">Break ✗</span>)}
              </h3>
              {recon ? (
                <>
                  <p className="tl-meta mono">
                    Statement {recon.statementRef}
                    {recon.journalId ? ` · journal ${recon.journalId}` : ''}
                  </p>
                  {recon.breaks.length > 0 && (
                    <ul className="breaks">
                      {recon.breaks.map((b) => (
                        <li key={b} className="mono">
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="empty">Not reconciled yet.</p>
              )}
            </section>

            <section>
              <h3>Event timeline</h3>
              {current.droppedEvents ? <p className="tl-meta">{current.droppedEvents} older events not kept by the gateway.</p> : null}
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
          </div>
        )}
      </aside>
    </>
  );
}
