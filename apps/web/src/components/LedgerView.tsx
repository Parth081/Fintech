import { useState, type FormEvent } from 'react';
import type { JournalView } from '@ct/contracts/browser';
import { fetchAccounts, fetchJournals, fetchTrialBalance } from '../lib/api';
import { formatClock, formatCount, formatMinor } from '../lib/format';
import { filterAccounts, journalBalanced, journalRows } from '../lib/ledger';
import { usePoll } from '../hooks/usePoll';

export function LedgerView() {
  const tb = usePoll(fetchTrialBalance, 3000);
  const accounts = usePoll(fetchAccounts, 6000);
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState('');
  const [journals, setJournals] = useState<{ paymentId: string; list: JournalView[] } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const accountTypes = new Map((accounts.data ?? []).map((a) => [a.accountId, a.type] as const));
  const { rows, total } = filterAccounts(accounts.data ?? [], query, 200);
  const t = tb.data;

  const onLookup = (e: FormEvent) => {
    e.preventDefault();
    const id = lookup.trim();
    if (!id) return;
    setLookupError(null);
    fetchJournals(id).then(
      (list) => setJournals({ paymentId: id, list }),
      (err: unknown) => setLookupError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <div className="view">
      <section className="panel">
        <div className="panel-head">
          <h2 className="section-title">Trial balance</h2>
          <span className="tl-meta">{t ? `as of ${formatClock(t.asOf)} · auto-refresh 3 s` : ''}</span>
        </div>
        {tb.error && <p className="msg-error">⚠ {tb.error}</p>}
        {!t && !tb.error && <p className="empty">Loading…</p>}
        {t && (
          <div className="tb">
            <div className={`big-check ${t.balanced ? 'big-ok' : 'big-bad'}`} role="status">
              <span className="big-check-mark">{t.balanced ? '✓' : '✗'}</span>
              <span>{t.balanced ? 'Balanced' : 'Unbalanced'}</span>
              <span className="big-check-sub">debits = credits in every currency</span>
            </div>
            <div className="tb-figures">
              <div className="kpi">
                <span className="kpi-value">{formatCount(t.journals)}</span>
                <span className="kpi-label">Journals</span>
              </div>
              <div className="kpi">
                <span className="kpi-value">{formatCount(t.entries)}</span>
                <span className="kpi-label">Entries</span>
              </div>
            </div>
            <table className="ledger tb-table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th className="num">Total debits</th>
                  <th className="num">Total credits</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {t.byCurrency.map((c) => (
                  <tr key={c.currency}>
                    <td className="mono">{c.currency}</td>
                    <td className="num mono">{formatMinor(c.debits, c.currency)}</td>
                    <td className="num mono">{formatMinor(c.credits, c.currency)}</td>
                    <td>{c.balanced ? <span className="ok">Balanced ✓</span> : <span className="bad">Off by {formatMinor(c.debits - c.credits, c.currency)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="section-title">Journal lookup</h2>
        </div>
        <form className="lookup" onSubmit={onLookup}>
          <input
            className="input mono"
            placeholder="Payment id"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            aria-label="Payment id"
          />
          <button type="submit" className="btn">
            Find journals
          </button>
        </form>
        {lookupError && <p className="msg-error">⚠ {lookupError}</p>}
        {journals && journals.list.length === 0 && <p className="empty">No journals for {journals.paymentId}.</p>}
        {journals?.list.map((j) => (
          <div key={j.journalId} className="journal">
            <div className="tl-meta mono">
              {j.journalId} · {j.kind} · {formatClock(j.postedAt)}{' '}
              {journalBalanced(j) ? <span className="balanced">Balanced ✓</span> : <span className="unbalanced">Not balanced ✗</span>}
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
                {journalRows(j, accountTypes).map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.accountId}</td>
                    <td>{r.type}</td>
                    <td className="num mono">{r.debit}</td>
                    <td className="num mono">{r.credit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="section-title">Accounts</h2>
          <input
            className="input"
            placeholder="Search id, type or currency"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search accounts"
          />
          <span className="tl-meta">
            {accounts.data ? `${formatCount(rows.length)} of ${formatCount(total)} shown` : ''}
          </span>
        </div>
        {accounts.error && <p className="msg-error">⚠ {accounts.error}</p>}
        {accounts.data && (
          <table className="ledger accounts">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Currency</th>
                <th className="num">Debits</th>
                <th className="num">Credits</th>
                <th className="num">Balance</th>
                <th className="num">Entries</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={`${a.accountId}|${a.currency}`}>
                  <td className="mono">{a.accountId}</td>
                  <td>{a.type}</td>
                  <td className="mono">{a.currency}</td>
                  <td className="num mono">{formatMinor(a.debits, a.currency)}</td>
                  <td className="num mono">{formatMinor(a.credits, a.currency)}</td>
                  <td className={`num mono${a.balance < 0 ? ' neg' : ''}`}>{formatMinor(a.balance, a.currency)}</td>
                  <td className="num mono">{formatCount(a.entryCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
