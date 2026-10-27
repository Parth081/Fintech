// Audit log: every operator and system action, immutable. Filters, server paging, entry detail drawer,
// CSV export (server-generated, same filters), links to the target and to the event it produced.
import { useState } from 'react';
import type { AuditEntry } from '@ct/contracts/browser';
import { opsApi, type Query } from '../../api';
import { downloadText, stampedName } from '../../lib/csv';
import { dayBounds } from '../../lib/format';
import { links, targetHref, useConsoleRoute } from '../../route';
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateTime,
  Drawer,
  Field,
  Input,
  KeyValueList,
  Page,
  PageHeader,
  Select,
  humanize,
  isForbidden,
  shortId,
  useApi,
  useToast,
  type Column,
} from '../../ui';

const TARGET_TYPES = ['payment', 'case', 'alert', 'config', 'break', 'user', 'apikey', 'webhook'] as const;

function actionTone(action: string): 'ok' | 'bad' | 'warn' | 'info' | 'accent' | 'neutral' {
  if (/approved|released|resolved|created|login/.test(action)) return 'ok';
  if (/rejected|revoked|deleted|failed/.test(action)) return 'bad';
  if (/requested|proposed|retry/.test(action)) return 'accent';
  if (/assigned|note|linked|opened/.test(action)) return 'info';
  return 'neutral';
}

export default function AuditPage() {
  const route = useConsoleRoute();
  const toast = useToast();
  const qy = route.query;
  const offset = Math.max(0, Number(qy.offset ?? 0) || 0);
  const limit = [25, 50, 100].includes(Number(qy.limit)) ? Number(qy.limit) : 50;
  const filters: Query = {
    actor: qy.actor,
    action: qy.action,
    targetType: qy.targetType,
    targetId: qy.targetId,
    from: qy.from ? dayBounds(qy.from)?.from : undefined,
    to: qy.to ? dayBounds(qy.to)?.to : undefined,
  };
  const users = useApi((s) => opsApi.demoUsers(s), []);
  const data = useApi((s) => opsApi.audit({ ...filters, limit, offset }, s), [filters, limit, offset], { intervalMs: 15_000 });
  const entryId = qy.entry ?? null;
  const entry = data.data?.items.find((e) => e.id === entryId) ?? null;
  const [exporting, setExporting] = useState(false);
  const [targetText, setTargetText] = useState(qy.targetId ?? '');
  const [actionText, setActionText] = useState(qy.action ?? '');
  const hasFilters = ['actor', 'action', 'targetType', 'targetId', 'from', 'to'].some((k) => qy[k]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await opsApi.auditCsv(filters);
      downloadText(stampedName('audit-log'), csv);
      toast.success('Audit export ready', 'All entries matching the current filters.');
    } catch (err) {
      toast.error('Export failed', err);
    } finally {
      setExporting(false);
    }
  };

  const cols: Column<AuditEntry>[] = [
    { id: 'at', header: 'Time', cell: (e) => <DateTime value={e.at} /> },
    { id: 'actor', header: 'Actor', cell: (e) => <>{e.actor.name} <span className="ct-small ct-muted">{humanize(e.actor.role)}</span></> },
    { id: 'action', header: 'Action', cell: (e) => <Badge tone={actionTone(e.action)}>{e.action}</Badge> },
    {
      id: 'target',
      header: 'Target',
      cell: (e) => {
        const href = targetHref(e.target);
        return (
          <>
            <span className="ct-muted ct-small">{e.target.type} </span>
            {href ? <a className="ct-mono" href={href}>{shortId(e.target.id, 22)}</a> : <span className="ct-mono">{shortId(e.target.id, 22)}</span>}
          </>
        );
      },
    },
    { id: 'event', header: 'Event', cell: (e) => (e.eventId ? <span className="ct-mono ct-small" title={e.eventId}>{shortId(e.eventId, 14)}</span> : <span className="ct-muted">—</span>) },
  ];

  return (
    <Page>
      <PageHeader
        title="Audit log"
        subtitle="Append-only record of every sign-in, decision, approval and configuration change."
        actions={<Button icon="download" loading={exporting} onClick={() => void exportCsv()}>Export CSV</Button>}
      />
      <Card flush>
        <form
          className="ct-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            route.setQuery({ targetId: targetText.trim() || null, action: actionText.trim() || null, offset: null });
          }}
        >
          <Select compact aria-label="Actor" value={qy.actor ?? ''} placeholder="All actors" options={[{ value: 'system', label: 'System' }, ...(users.data ?? []).map((u) => ({ value: u.id, label: u.name }))]} onChange={(e) => route.setQuery({ actor: e.target.value || null, offset: null })} />
          <Select compact aria-label="Target type" value={qy.targetType ?? ''} placeholder="All targets" options={TARGET_TYPES.map((t) => ({ value: t, label: humanize(t) }))} onChange={(e) => route.setQuery({ targetType: e.target.value || null, offset: null })} />
          <Input compact placeholder="Action, e.g. refund." value={actionText} onChange={(e) => setActionText(e.target.value)} aria-label="Action" style={{ width: 170 }} />
          <Input compact placeholder="Target ID" value={targetText} onChange={(e) => setTargetText(e.target.value)} aria-label="Target ID" style={{ width: 200 }} />
          <Input compact type="date" value={qy.from ?? ''} onChange={(e) => route.setQuery({ from: e.target.value || null, offset: null })} aria-label="From date" />
          <Input compact type="date" value={qy.to ?? ''} onChange={(e) => route.setQuery({ to: e.target.value || null, offset: null })} aria-label="To date" />
          <Button size="sm" type="submit" icon="search">Apply</Button>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              icon="x"
              onClick={() => {
                setTargetText('');
                setActionText('');
                route.navigate('audit', { replace: true });
              }}
            >
              Clear
            </Button>
          )}
        </form>
        <DataTable
          caption="Audit entries"
          columns={cols}
          rows={data.data?.items}
          rowKey={(e) => e.id}
          selectedKey={entryId}
          onRowClick={(e) => route.setQuery({ entry: e.id })}
          loading={data.loading}
          error={data.error}
          forbidden={isForbidden(data.errorObj)}
          onRetry={data.refresh}
          empty={hasFilters ? 'No audit entries match these filters' : 'No audit entries yet'}
          paging={{ offset, limit, total: data.data?.total ?? 0, pageSizes: [25, 50, 100], onChange: (o, l) => route.setQuery({ offset: o || null, limit: l === 50 ? null : l }) }}
        />
      </Card>
      <Drawer open={!!entry} title={entry ? entry.action : ''} subtitle={entry ? <span className="ct-mono">{entry.id}</span> : undefined} onClose={() => route.setQuery({ entry: null })}>
        {entry && (
          <div className="ct-stack">
            <KeyValueList
              items={[
                { label: 'Time', value: <DateTime value={entry.at} /> },
                { label: 'Actor', value: `${entry.actor.name} (${humanize(entry.actor.role)})` },
                { label: 'Actor ID', value: <span className="ct-mono">{entry.actor.userId}</span> },
                { label: 'Action', value: <Badge tone={actionTone(entry.action)}>{entry.action}</Badge> },
                { label: 'Target', value: targetHref(entry.target) ? <a href={targetHref(entry.target)!}>{entry.target.type} {entry.target.id}</a> : `${entry.target.type} ${entry.target.id}` },
                {
                  label: 'Linked event',
                  value: entry.eventId ? (
                    <>
                      <span className="ct-mono">{entry.eventId}</span>
                      {entry.target.type === 'payment' && <> · <a href={links.payment(entry.target.id, 'timeline')}>View on payment timeline</a></>}
                    </>
                  ) : null,
                },
              ]}
            />
            <div>
              <h3 className="ct-section-title">Details</h3>
              <pre className="ct-pre">{JSON.stringify(entry.details, null, 2)}</pre>
            </div>
            <p className="ct-small ct-muted">Audit entries are append-only and cannot be edited or deleted.</p>
          </div>
        )}
      </Drawer>
    </Page>
  );
}
