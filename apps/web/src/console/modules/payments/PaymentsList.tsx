// Payments list: server paging + filters (status/corridor/provider/currency/amount/date/text), saved views,
// column chooser, CSV export of the current page.
import { useEffect, useMemo, useState } from 'react';
import { CORRIDORS, PROVIDERS, type PaymentStatus } from '@ct/contracts/browser';
import { gatewayApi } from '../../api';
import { toCsv, downloadText, stampedName } from '../../lib/csv';
import { activeFilterCount, apiQuery, EMPTY_FILTERS, filtersFromQuery, filtersToQuery, type PaymentFilters } from '../../lib/payments';
import { PAYMENT_STATUS, PAYMENT_STATUSES } from '../../lib/status';
import { removeView, toggleHidden, upsertView, visibleColumns, type SavedView } from '../../lib/table';
import { links, useConsoleRoute } from '../../route';
import type { PaymentSummary } from '../../../lib/types';
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  DateTime,
  Field,
  Input,
  Money,
  Page,
  PageHeader,
  Popover,
  Select,
  StatusBadge,
  formatDuration,
  shortId,
  useApi,
  useDebounced,
  useLocalStorage,
  useToast,
  type Column,
} from '../../ui';

const providerName = (id?: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id ?? '';

const COLUMNS: Column<PaymentSummary>[] = [
  { id: 'id', header: 'Payment ID', required: true, cell: (p) => <a className="ct-mono" href={links.payment(p.paymentId)}>{shortId(p.paymentId, 20)}</a> },
  { id: 'status', header: 'Status', cell: (p) => <StatusBadge kind="payment" value={p.status} />, sortValue: (p) => p.status },
  { id: 'amount', header: 'Amount', numeric: true, cell: (p) => <Money value={p.amount} />, sortValue: (p) => p.amount.amountMinor },
  { id: 'target', header: 'Beneficiary gets', numeric: true, cell: (p) => (p.targetAmount ? <Money value={p.targetAmount} /> : <span className="ct-muted">—</span>), sortValue: (p) => p.targetAmount?.amountMinor },
  { id: 'corridor', header: 'Corridor', cell: (p) => p.corridor, sortValue: (p) => p.corridor },
  { id: 'provider', header: 'Provider', cell: (p) => providerName(p.providerId) || <span className="ct-muted">—</span>, sortValue: (p) => p.providerId },
  { id: 'attempts', header: 'Retries', numeric: true, cell: (p) => (p.retries ? <span className="ct-text-warn">{p.retries}</span> : '0'), sortValue: (p) => p.retries },
  { id: 'recon', header: 'Recon', cell: (p) => (p.recon === 'break' ? <StatusBadge kind="generic" value="break" /> : p.recon === 'matched' ? <span className="ct-text-ok">Matched</span> : <span className="ct-muted">—</span>) },
  { id: 'e2e', header: 'End-to-end', numeric: true, cell: (p) => (p.endToEndMs !== undefined ? formatDuration(p.endToEndMs) : <span className="ct-muted">—</span>), sortValue: (p) => p.endToEndMs },
  { id: 'reason', header: 'Reason', cell: (p) => (p.reason ? <span className="ct-ellipsis" style={{ display: 'inline-block', maxWidth: 220 }} title={p.reason}>{p.reason}</span> : <span className="ct-muted">—</span>) },
  { id: 'created', header: 'Created', cell: (p) => <DateTime value={p.createdAt} />, sortValue: (p) => p.createdAt, defaultSortDir: 'desc' },
  { id: 'updated', header: 'Last update', cell: (p) => <DateTime value={p.updatedAt} relative />, sortValue: (p) => p.updatedAt, defaultSortDir: 'desc' },
];
const DEFAULT_HIDDEN = ['target', 'e2e', 'reason', 'updated'];

function StatusPicker({ value, onChange }: { value: PaymentStatus[]; onChange(v: PaymentStatus[]): void }) {
  return (
    <Popover
      align="left"
      width={240}
      trigger={({ toggle, open }) => (
        <Button size="sm" icon="filter" onClick={toggle} aria-expanded={open}>
          Status{value.length ? ` (${value.length})` : ''}
        </Button>
      )}
    >
      <div style={{ padding: 10 }} className="ct-stack-sm">
        {PAYMENT_STATUSES.map((s) => (
          <Checkbox key={s} label={PAYMENT_STATUS[s].label} checked={value.includes(s)} onChange={(on) => onChange(on ? [...value, s] : value.filter((x) => x !== s))} />
        ))}
        {value.length > 0 && <button type="button" className="ct-link-btn ct-small" onClick={() => onChange([])}>Clear</button>}
      </div>
    </Popover>
  );
}

export function PaymentsList() {
  const route = useConsoleRoute();
  const toast = useToast();
  const filters = filtersFromQuery(route.query);
  const offset = Math.max(0, Number(route.query.offset ?? 0) || 0);
  const limit = [25, 50, 100].includes(Number(route.query.limit)) ? Number(route.query.limit) : 25;
  const [hidden, setHidden] = useLocalStorage<string[]>('ct.console.payments.hidden', DEFAULT_HIDDEN);
  const [views, setViews] = useLocalStorage<SavedView<Record<string, string>>[]>('ct.console.payments.views', []);
  const [text, setText] = useState(filters.q);
  const debouncedText = useDebounced(text, 350);
  const [newView, setNewView] = useState('');

  const set = (patch: Partial<PaymentFilters>, keepOffset = false) => {
    const next = { ...filters, ...patch };
    route.navigate('payments', { query: { ...filtersToQuery(next), limit: limit === 25 ? null : limit, offset: keepOffset ? offset || null : null }, replace: true });
  };
  // Push the debounced search text into the URL.
  useEffect(() => {
    if (debouncedText !== filters.q) set({ q: debouncedText });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedText]);
  // Keep the box in sync when the URL changes elsewhere (saved view, global search).
  useEffect(() => {
    if (filters.q !== debouncedText) setText(filters.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  const query = apiQuery(filters);
  const data = useApi((signal) => gatewayApi.payments({ ...query, offset, limit }, signal), [query, offset, limit], { intervalMs: 10_000 });
  const visible = visibleColumns(COLUMNS, hidden);
  const currencies = useMemo(() => [...new Set(CORRIDORS.map((c) => c.sourceCurrency))], []);
  const nFilters = activeFilterCount(filters);

  const exportCsv = () => {
    const rows = data.data?.items ?? [];
    const csv = toCsv(
      [
        { header: 'payment_id', value: (p: PaymentSummary) => p.paymentId },
        { header: 'status', value: (p) => p.status },
        { header: 'amount_minor', value: (p) => p.amount.amountMinor },
        { header: 'currency', value: (p) => p.amount.currency },
        { header: 'target_amount_minor', value: (p) => p.targetAmount?.amountMinor },
        { header: 'target_currency', value: (p) => p.targetAmount?.currency },
        { header: 'corridor', value: (p) => p.corridor },
        { header: 'provider', value: (p) => p.providerId },
        { header: 'retries', value: (p) => p.retries },
        { header: 'recon', value: (p) => p.recon },
        { header: 'reason', value: (p) => p.reason },
        { header: 'created_at', value: (p) => p.createdAt },
        { header: 'updated_at', value: (p) => p.updatedAt },
      ],
      rows,
    );
    downloadText(stampedName('payments'), csv);
    toast.success('Export ready', `${rows.length} payments on this page exported as CSV.`);
  };

  return (
    <Page>
      <PageHeader
        title="Payments"
        subtitle="Every payment on the platform, live from the event log."
        actions={
          <>
            <Popover
              width={260}
              trigger={({ toggle, open }) => (
                <Button icon="bookmark" onClick={toggle} aria-expanded={open}>
                  Saved views{views.length ? ` (${views.length})` : ''}
                </Button>
              )}
            >
              {(close) => (
                <div>
                  <div className="ct-popover-head">Saved views</div>
                  {views.length === 0 && <div className="ct-empty" style={{ padding: 14 }}>No saved views yet.</div>}
                  {views.map((v) => (
                    <div key={v.id} className="ct-row" style={{ paddingRight: 8 }}>
                      <a className="ct-menu-item" href={links.payments(v.filters)} onClick={() => { setText(v.filters.q ?? ''); close(); }}>
                        {v.name}
                      </a>
                      <Button size="sm" variant="ghost" icon="x" aria-label={`Delete view ${v.name}`} onClick={() => setViews((vs) => removeView(vs, v.id))} />
                    </div>
                  ))}
                  <div className="ct-menu-sep" />
                  <form
                    className="ct-row"
                    style={{ padding: 10 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newView.trim()) return;
                      setViews((vs) => upsertView(vs, newView, filtersToQuery(filters)));
                      toast.success('View saved', `“${newView.trim()}” saved in this browser.`);
                      setNewView('');
                    }}
                  >
                    <Input compact placeholder="Name current filters" value={newView} onChange={(e) => setNewView(e.target.value)} aria-label="View name" />
                    <Button size="sm" type="submit" variant="primary" disabled={!newView.trim()}>Save</Button>
                  </form>
                </div>
              )}
            </Popover>
            <Button icon="download" onClick={exportCsv} disabled={!data.data?.items.length}>Export CSV</Button>
          </>
        }
      />
      <Card flush>
        <div className="ct-toolbar">
          <div className="ct-search-box" style={{ width: 320 }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Payment ID, customer, account, message ref…" aria-label="Search payments" />
          </div>
          <StatusPicker value={filters.status} onChange={(status) => set({ status })} />
          <Select compact aria-label="Corridor" value={filters.corridor} placeholder="All corridors" options={CORRIDORS.map((c) => ({ value: c.id, label: `${c.id} · ${c.sourceCurrency}→${c.targetCurrency}` }))} onChange={(e) => set({ corridor: e.target.value })} />
          <Select compact aria-label="Provider" value={filters.provider} placeholder="All providers" options={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))} onChange={(e) => set({ provider: e.target.value })} />
          <Select compact aria-label="Currency" value={filters.currency} placeholder="Any currency" options={currencies.map((c) => ({ value: c, label: c }))} onChange={(e) => set({ currency: e.target.value })} />
          <Popover
            align="left"
            width={300}
            trigger={({ toggle, open }) => (
              <Button size="sm" icon="filter" onClick={toggle} aria-expanded={open}>
                Amount & date{filters.minAmount || filters.maxAmount || filters.from || filters.to ? ' •' : ''}
              </Button>
            )}
          >
            <div className="ct-stack-sm" style={{ padding: 12 }}>
              <div className="ct-grid ct-grid-2" style={{ gap: 8 }}>
                <Field label="Min amount">{(id) => <Input id={id} compact type="number" min={0} value={filters.minAmount} onChange={(e) => set({ minAmount: e.target.value })} />}</Field>
                <Field label="Max amount">{(id) => <Input id={id} compact type="number" min={0} value={filters.maxAmount} onChange={(e) => set({ maxAmount: e.target.value })} />}</Field>
                <Field label="From date">{(id) => <Input id={id} compact type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
                <Field label="To date">{(id) => <Input id={id} compact type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
              </div>
              <span className="ct-field-hint">Amounts are in the payment’s source currency (major units).</span>
            </div>
          </Popover>
          {nFilters > 0 && (
            <Button size="sm" variant="ghost" icon="x" onClick={() => { setText(''); route.navigate('payments', { query: filtersToQuery(EMPTY_FILTERS), replace: true }); }}>
              Clear filters ({nFilters})
            </Button>
          )}
          <div className="ct-spacer" />
          <Popover
            width={220}
            trigger={({ toggle, open }) => <Button size="sm" icon="columns" onClick={toggle} aria-expanded={open}>Columns</Button>}
          >
            <div className="ct-stack-sm" style={{ padding: 12 }}>
              {COLUMNS.map((c) => (
                <Checkbox key={c.id} label={c.header} disabled={c.required} checked={visible.includes(c.id)} onChange={() => setHidden((h) => toggleHidden(h, c.id))} />
              ))}
              <button type="button" className="ct-link-btn ct-small" onClick={() => setHidden(DEFAULT_HIDDEN)}>Reset to default</button>
            </div>
          </Popover>
          <Button size="sm" icon="refresh" onClick={data.refresh} aria-label="Refresh" loading={data.fetching && !data.loading} />
        </div>
        <DataTable
          caption="Payments"
          columns={COLUMNS}
          visible={visible}
          rows={data.data?.items}
          rowKey={(p) => p.paymentId}
          rowHref={(p) => links.payment(p.paymentId)}
          loading={data.loading}
          error={data.error}
          onRetry={data.refresh}
          empty={nFilters ? 'No payments match these filters' : 'No payments yet'}
          emptyHint={nFilters ? 'Try widening the filters or clearing the search.' : 'Start traffic to see payments flow in.'}
          paging={{
            offset,
            limit,
            total: data.data?.total ?? 0,
            onChange: (o, l) => route.setQuery({ offset: o || null, limit: l === 25 ? null : l }),
          }}
        />
      </Card>
    </Page>
  );
}
