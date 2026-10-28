// Global search: payment id / end-to-end id (= payment id) / message & settlement refs / customer name / case id.
// "/" or Ctrl+K focuses; arrows move; Enter opens.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaseView } from '@ct/contracts/browser';
import { gatewayApi, opsApi } from '../api';
import { directJumps, moveIndex, normalizeQuery, searchable } from '../lib/search';
import { links, navigateTo } from '../route';
import { useSession } from '../session';
import type { PaymentSummary } from '../../lib/types';
import { Icon, StatusBadge, formatMoney, shortId, useDebounced, useDismiss } from '../ui';

interface Result {
  key: string;
  group: string;
  title: string;
  sub?: string;
  href: string;
  status?: { kind: 'payment' | 'case'; value: string };
}

export function GlobalSearch() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [payments, setPayments] = useState<{ items: PaymentSummary[]; total: number } | null>(null);
  const [cases, setCases] = useState<CaseView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const debounced = useDebounced(normalizeQuery(q), 220);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useDismiss(box, open, () => setOpen(false));

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    if (!searchable(debounced)) {
      setPayments(null);
      setCases(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    Promise.all([
      can('payments.read') ? gatewayApi.payments({ q: debounced, limit: 6 }, ctrl.signal).catch(() => null) : Promise.resolve(null),
      can('alerts.read') ? opsApi.cases({ q: debounced, limit: 5 }, ctrl.signal).then((p) => p.items).catch(() => null) : Promise.resolve(null),
    ]).then(([p, c]) => {
      if (ctrl.signal.aborted) return;
      setPayments(p);
      setCases(c);
      setLoading(false);
      setActive(-1);
    });
    return () => ctrl.abort();
  }, [debounced, can]);

  const results = useMemo<Result[]>(() => {
    if (!searchable(q)) return [];
    const out: Result[] = directJumps(q).map((j) => ({ key: `jump:${j.href}`, group: 'Go to', title: j.label, href: j.href }));
    for (const p of payments?.items ?? []) {
      out.push({
        key: `p:${p.paymentId}`,
        group: 'Payments',
        title: shortId(p.paymentId, 24),
        sub: `${formatMoney(p.amount)} · ${p.corridor}`,
        href: links.payment(p.paymentId),
        status: { kind: 'payment', value: p.status },
      });
    }
    for (const c of cases ?? []) {
      out.push({ key: `c:${c.caseId}`, group: 'Cases', title: c.caseId, sub: `Payment ${shortId(c.paymentId, 16)} · ${c.priority}`, href: links.case(c.caseId), status: { kind: 'case', value: c.status } });
    }
    const norm = normalizeQuery(q);
    if (can('payments.read')) out.push({ key: 'all', group: 'More', title: `Search all payments for “${norm}”`, sub: payments ? `${payments.total} match${payments.total === 1 ? '' : 'es'}` : undefined, href: links.payments({ q: norm }) });
    return out;
  }, [q, payments, cases, can]);

  const go = (r: Result | undefined) => {
    if (!r) return;
    navigateTo(r.href);
    setOpen(false);
    setQ('');
    input.current?.blur();
  };

  let lastGroup = '';
  return (
    <div className="ct-search" ref={box}>
      <div className="ct-search-box">
        <Icon name="search" />
        <input
          ref={input}
          value={q}
          placeholder="Search payment ID, end-to-end ID, customer name or case ID"
          aria-label="Global search"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="ct-search-results"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => moveIndex(a, e.key === 'ArrowDown' ? 1 : -1, results.length));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(results[active >= 0 ? active : 0]);
            } else if (e.key === 'Escape') {
              setOpen(false);
              input.current?.blur();
            }
          }}
        />
        {loading ? <span className="ct-spinner" aria-hidden="true" /> : <span className="ct-kbd">/</span>}
      </div>
      {open && searchable(q) && (
        <div className="ct-popover ct-popover-wide" id="ct-search-results" role="listbox">
          <div className="ct-menu-scroll">
            {results.map((r, i) => {
              const header = r.group !== lastGroup ? <div className="ct-popover-section">{r.group}</div> : null;
              lastGroup = r.group;
              return (
                <div key={r.key}>
                  {header}
                  <a
                    className="ct-menu-item"
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    href={r.href}
                    onMouseEnter={() => setActive(i)}
                    onClick={(e) => {
                      e.preventDefault();
                      go(r);
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className={r.group === 'Payments' || r.group === 'Cases' ? 'ct-mono' : undefined}>{r.title}</span>
                      {r.sub && <small>{r.sub}</small>}
                    </span>
                    {r.status && <StatusBadge kind={r.status.kind} value={r.status.value} />}
                  </a>
                </div>
              );
            })}
            {!loading && payments && payments.items.length === 0 && (cases ?? []).length === 0 && directJumps(q).length === 0 && (
              <div className="ct-empty" style={{ padding: 16 }}>No payments or cases match “{normalizeQuery(q)}”.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
