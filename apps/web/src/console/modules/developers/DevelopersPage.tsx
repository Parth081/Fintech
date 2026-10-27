// Developers: API keys (secret shown once; revoke), webhook endpoints + simulated deliveries, API reference.
import { useState } from 'react';
import type { ApiKeyView, WebhookDelivery, WebhookEndpoint } from '@ct/contracts/browser';
import { opsApi, type CreatedApiKey } from '../../api';
import { useConsoleRoute } from '../../route';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DateTime,
  Field,
  Input,
  Modal,
  Page,
  PageHeader,
  StatusBadge,
  Tabs,
  copyToClipboard,
  isForbidden,
  useApi,
  useToast,
  type Column,
} from '../../ui';

/** Scopes accepted by POST /developer/keys (ops service). */
export const API_KEY_SCOPES = ['payments:read', 'payments:write', 'refunds:write', 'webhooks:manage', 'reports:read'] as const;
const WEBHOOK_EVENTS = ['payment.*', 'payment.settled', 'payment.failed', 'payment.held', 'payment.reconciled', 'payment.refunded', 'risk.alert_raised'] as const;

function KeysTab() {
  const toast = useToast();
  const keys = useApi((s) => opsApi.apiKeys(s), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['payments:read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoke, setRevoke] = useState<ApiKeyView | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const k = await opsApi.createApiKey(name.trim(), scopes);
      setCreated(k);
      setCreating(false);
      setName('');
      keys.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cols: Column<ApiKeyView>[] = [
    { id: 'name', header: 'Name', cell: (k) => <span className="ct-strong">{k.name}</span>, sortValue: (k) => k.name },
    { id: 'prefix', header: 'Key', cell: (k) => <span className="ct-mono">{k.prefix}…</span> },
    { id: 'scopes', header: 'Scopes', cell: (k) => <div className="ct-row ct-row-wrap">{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div> },
    { id: 'created', header: 'Created', cell: (k) => <><DateTime value={k.createdAt} relative /> <span className="ct-small ct-muted">by {k.createdBy.name}</span></>, sortValue: (k) => k.createdAt, defaultSortDir: 'desc' },
    { id: 'used', header: 'Last used', cell: (k) => (k.lastUsedAt ? <DateTime value={k.lastUsedAt} relative /> : <span className="ct-muted">Never</span>) },
    { id: 'status', header: 'Status', cell: (k) => (k.revokedAt ? <Badge tone="bad" dot>Revoked</Badge> : <Badge tone="ok" dot>Active</Badge>) },
    { id: 'actions', header: '', cell: (k) => (k.revokedAt ? null : <Button size="sm" variant="ghost" onClick={() => setRevoke(k)}>Revoke</Button>) },
  ];

  return (
    <>
      <Card title="API keys" subtitle="Test-mode keys for the sandbox. The secret is shown once at creation." flush actions={<Button variant="primary" icon="plus" size="sm" onClick={() => setCreating(true)}>Create key</Button>}>
        <DataTable columns={cols} rows={keys.data} rowKey={(k) => k.id} loading={keys.loading} error={keys.error} forbidden={isForbidden(keys.errorObj)} onRetry={keys.refresh} initialSort={{ key: 'created', dir: 'desc' }} empty="No API keys yet" emptyHint="Create a key to call the sandbox API." skeletonRows={4} />
      </Card>
      <Modal
        open={creating}
        title="Create API key"
        onClose={() => !busy && setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim() || scopes.length === 0} onClick={() => void create()}>Create key</Button>
          </>
        }
      >
        <Field label="Name" required hint="What will use this key, e.g. “Reconciliation job”.">
          {(id) => <Input id={id} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <div className="ct-field">
          <span className="ct-label">Scopes</span>
          <div className="ct-grid ct-grid-2" style={{ gap: 6 }}>
            {API_KEY_SCOPES.map((s) => (
              <Checkbox key={s} label={<code>{s}</code>} checked={scopes.includes(s)} onChange={(on) => setScopes((xs) => (on ? [...xs, s] : xs.filter((x) => x !== s)))} />
            ))}
          </div>
        </div>
        {error && <Banner tone="bad">{error}</Banner>}
      </Modal>
      <Modal open={!!created} title="Copy your new API key" onClose={() => setCreated(null)} footer={<Button variant="primary" onClick={() => setCreated(null)}>I’ve stored it safely</Button>}>
        <Banner tone="warn">This is the only time the secret is shown. Store it in your secrets manager now.</Banner>
        {created && (
          <div className="ct-secret">
            <span style={{ flex: 1 }}>{created.secret}</span>
            <Button size="sm" icon="copy" onClick={() => void copyToClipboard(created.secret).then((ok) => toast.show({ title: ok ? 'Secret copied' : 'Copy failed', tone: ok ? 'ok' : 'bad' }))}>Copy</Button>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={!!revoke}
        title={`Revoke “${revoke?.name ?? ''}”?`}
        description="Requests using this key will be refused immediately. This cannot be undone."
        confirmLabel="Revoke key"
        variant="danger"
        requireReason={false}
        onCancel={() => setRevoke(null)}
        onConfirm={async () => {
          await opsApi.revokeApiKey(revoke!.id);
          toast.success('API key revoked', revoke!.name);
          setRevoke(null);
          keys.refresh();
        }}
      />
    </>
  );
}

function WebhooksTab() {
  const toast = useToast();
  const hooks = useApi((s) => opsApi.webhooks(s), []);
  const deliveries = useApi((s) => opsApi.deliveries(s), [], { intervalMs: 10_000 });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('https://example.test/webhooks/payments');
  const [events, setEvents] = useState<string[]>(['payment.*']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remove, setRemove] = useState<WebhookEndpoint | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.createWebhook(url.trim(), events);
      setAdding(false);
      hooks.refresh();
      toast.success('Endpoint added', 'Deliveries are simulated in the sandbox; nothing is sent off this machine.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hookCols: Column<WebhookEndpoint>[] = [
    { id: 'url', header: 'Endpoint URL', cell: (w) => <span className="ct-mono">{w.url}</span> },
    { id: 'events', header: 'Events', cell: (w) => <div className="ct-row ct-row-wrap">{w.events.map((e) => <Badge key={e}>{e}</Badge>)}</div> },
    { id: 'status', header: 'Status', cell: (w) => (w.enabled ? <Badge tone="ok" dot>Enabled</Badge> : <Badge dot>Disabled</Badge>) },
    { id: 'created', header: 'Created', cell: (w) => <DateTime value={w.createdAt} relative /> },
    {
      id: 'actions',
      header: '',
      cell: (w) => (
        <div className="ct-row" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={() => void opsApi.testWebhook(w.id).then(() => { toast.success('Test event sent (simulated)'); deliveries.refresh(); }, (e) => toast.error('Test failed', e))}>Send test</Button>
          <Button size="sm" variant="ghost" onClick={() => void opsApi.setWebhookEnabled(w.id, !w.enabled).then(hooks.refresh, (e) => toast.error('Update failed', e))}>{w.enabled ? 'Disable' : 'Enable'}</Button>
          <Button size="sm" variant="ghost" onClick={() => setRemove(w)}>Delete</Button>
        </div>
      ),
    },
  ];
  const deliveryCols: Column<WebhookDelivery>[] = [
    { id: 'at', header: 'Time', cell: (d) => <DateTime value={d.at} />, sortValue: (d) => d.at, defaultSortDir: 'desc' },
    { id: 'type', header: 'Event', cell: (d) => <code>{d.eventType}</code> },
    { id: 'event', header: 'Event ID', cell: (d) => <span className="ct-mono ct-small">{d.eventId}</span> },
    { id: 'endpoint', header: 'Endpoint', cell: (d) => <span className="ct-small">{hooks.data?.find((w) => w.id === d.endpointId)?.url ?? d.endpointId}</span> },
    { id: 'status', header: 'Status', cell: (d) => <StatusBadge kind="delivery" value={d.status} /> },
    { id: 'ms', header: 'Response', numeric: true, cell: (d) => `${d.responseMs} ms`, sortValue: (d) => d.responseMs },
  ];

  return (
    <div className="ct-stack">
      <Banner tone="info">Sandbox: webhook deliveries are simulated and recorded below. Nothing leaves this machine.</Banner>
      <Card title="Endpoints" flush actions={<Button variant="primary" icon="plus" size="sm" onClick={() => setAdding(true)}>Add endpoint</Button>}>
        <DataTable columns={hookCols} rows={hooks.data} rowKey={(w) => w.id} loading={hooks.loading} error={hooks.error} forbidden={isForbidden(hooks.errorObj)} onRetry={hooks.refresh} empty="No webhook endpoints" skeletonRows={3} />
      </Card>
      <Card title="Recent deliveries" subtitle="Latest 100 (simulated)" flush>
        <DataTable columns={deliveryCols} rows={deliveries.data} rowKey={(d) => d.id} loading={deliveries.loading} error={deliveries.error} onRetry={deliveries.refresh} initialSort={{ key: 'at', dir: 'desc' }} empty="No deliveries yet" emptyHint="Add an endpoint and send a test event." compact />
      </Card>
      <Modal
        open={adding}
        title="Add webhook endpoint"
        onClose={() => !busy && setAdding(false)}
        footer={
          <>
            <Button onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!url.trim() || events.length === 0} onClick={() => void add()}>Add endpoint</Button>
          </>
        }
      >
        <Field label="Endpoint URL" required hint="Absolute http(s) URL. Deliveries are simulated.">
          {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
        <div className="ct-field">
          <span className="ct-label">Events</span>
          <div className="ct-grid ct-grid-2" style={{ gap: 6 }}>
            {WEBHOOK_EVENTS.map((e) => (
              <Checkbox key={e} label={<code>{e}</code>} checked={events.includes(e)} onChange={(on) => setEvents((xs) => (on ? [...xs, e] : xs.filter((x) => x !== e)))} />
            ))}
          </div>
        </div>
        {error && <Banner tone="bad">{error}</Banner>}
      </Modal>
      <ConfirmDialog
        open={!!remove}
        title="Delete this endpoint?"
        description={remove ? <>Deliveries to <span className="ct-mono">{remove.url}</span> stop immediately.</> : undefined}
        confirmLabel="Delete endpoint"
        variant="danger"
        requireReason={false}
        onCancel={() => setRemove(null)}
        onConfirm={async () => {
          await opsApi.deleteWebhook(remove!.id);
          toast.success('Endpoint deleted');
          setRemove(null);
          hooks.refresh();
        }}
      />
    </div>
  );
}

const REFERENCE: { method: string; path: string; text: string; scope: string }[] = [
  { method: 'GET', path: '/v1/payments', text: 'List payments (filters: status, corridor, provider, q; paged, X-Total-Count)', scope: 'payments:read' },
  { method: 'GET', path: '/v1/payments/{id}', text: 'Retrieve a payment with its event history', scope: 'payments:read' },
  { method: 'POST', path: '/v1/payments', text: 'Create a payment (Idempotency-Key header required)', scope: 'payments:write' },
  { method: 'GET', path: '/v1/payments/{id}/messages', text: 'ISO 20022 pacs.008 / pacs.002 messages', scope: 'payments:read' },
  { method: 'POST', path: '/v1/payments/{id}/refunds', text: 'Request a refund (requires four-eyes approval)', scope: 'refunds:write' },
  { method: 'GET', path: '/v1/reports/statements', text: 'Provider statements (camt.053)', scope: 'reports:read' },
  { method: 'POST', path: '/v1/webhooks', text: 'Register a webhook endpoint', scope: 'webhooks:manage' },
];

function ReferenceTab() {
  return (
    <div className="ct-stack">
      <Card title="Authentication">
        <p style={{ marginTop: 0 }}>Send your secret key as a bearer token. Test keys start with <code>ctk_test_</code> and only work in the sandbox.</p>
        <pre className="ct-pre">{`curl https://sandbox.api.example.test/v1/payments?status=failed \\
  -H "Authorization: Bearer ctk_test_..." \\
  -H "Accept: application/json"`}</pre>
      </Card>
      <Card title="Endpoints" flush>
        <table className="ct-table">
          <thead><tr><th>Method</th><th>Path</th><th>Description</th><th>Scope</th></tr></thead>
          <tbody>
            {REFERENCE.map((r) => (
              <tr key={r.method + r.path}>
                <td><Badge tone={r.method === 'GET' ? 'info' : 'accent'}>{r.method}</Badge></td>
                <td className="ct-mono">{r.path}</td>
                <td>{r.text}</td>
                <td><code>{r.scope}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Webhook payload">
        <pre className="ct-pre">{JSON.stringify({ id: 'evt_…', type: 'payment.settled', created: '2026-10-27T09:00:00Z', data: { paymentId: '…', status: 'settled', amount: { amountMinor: 125000, currency: 'USD' } } }, null, 2)}</pre>
        <p className="ct-small ct-muted" style={{ marginBottom: 0 }}>Events are delivered at least once; deduplicate on <code>id</code>. Reference documentation is static in this demo.</p>
      </Card>
    </div>
  );
}

export default function DevelopersPage() {
  const route = useConsoleRoute();
  const tab = route.query.tab ?? 'keys';
  return (
    <Page>
      <PageHeader title="Developers" subtitle="API keys, webhooks and the sandbox API reference." actions={<Badge tone="warn" dot>Test mode</Badge>} />
      <Tabs tabs={[{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'reference', label: 'API reference' }]} active={tab} onChange={(t) => route.setQuery({ tab: t === 'keys' ? null : t })} />
      {tab === 'keys' && <KeysTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'reference' && <ReferenceTab />}
    </Page>
  );
}
