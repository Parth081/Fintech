// Change requests (maker-checker): list by status, detail drawer with current-vs-proposed diff, four-eyes review.
import { useMemo, useState } from 'react';
import type { ChangeRequest, ChangeStatus } from '@ct/contracts/browser';
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { isForbidden, useApi, useNow } from '../../ui/hooks';
import { configApi } from './data';
import { canReview, filterChanges, KEY_INFO, summarizeChange, type ChangeTab } from './lib/config';
import { DiffTable } from './DiffTable';
import { Button, Card, DateTime, Drawer, EmptyState, ErrorState, KeyValueList, LoadingBlock, LoadingRows, PageHeader, ReasonDialog, StatusBadge, Tabs, toastDone, toastError } from '../risk/kit';

const TABS: { id: ChangeTab; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'all', label: 'All' },
];

export default function ChangesPage({ selectedId }: { selectedId?: string }) {
  const route = useConsoleRoute();
  const now = useNow(10_000);
  const tab = (TABS.some((t) => t.id === route.query.status) ? route.query.status : 'pending') as ChangeTab;
  const list = useApi((s) => configApi.changes({}, s), [], { intervalMs: 10_000 });
  const all = list.data?.items ?? [];
  const rows = useMemo(() => filterChanges(all, tab), [all, tab]);
  const count = (s: ChangeTab) => (s === 'all' ? all.length : all.filter((c) => c.status === s).length);

  return (
    <div className="ct-page">
      <PageHeader
        breadcrumb={[{ label: 'Platform' }, { label: 'Routing & providers', href: links.config() }, { label: 'Change requests' }]}
        title="Change requests"
        subtitle="Configuration changes need two people: one requests, a different approver reviews. Approved changes are published on the event log with a new version."
        actions={
          <>
            <Button icon="routing" onClick={() => route.navigate(links.config())}>
              Configuration
            </Button>
            <Button icon="refresh" onClick={list.refresh}>
              Refresh
            </Button>
          </>
        }
      />
      <Tabs tabs={TABS.map((t) => ({ ...t, count: count(t.id) }))} value={tab} onChange={(id) => route.setQuery({ status: id === 'pending' ? null : id })} label="Change status" />
      <Card flush>
        {list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={list.refresh} forbidden={isForbidden(list.errorObj)} />
        ) : (
          <div className="ct-table-wrap">
            <table className="ct-table ctm-table-dense">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Setting</th>
                  <th>Change</th>
                  <th>Requested by</th>
                  <th>Status</th>
                  <th>Reviewed by</th>
                  <th className="ct-num">Applied version</th>
                </tr>
              </thead>
              {list.loading ? (
                <LoadingRows cols={7} />
              ) : rows.length === 0 ? (
                <tbody>
                  <tr>
                    <td colSpan={7}>
                      <EmptyState title={tab === 'pending' ? 'Nothing is waiting for review' : 'No change requests here'} hint={tab === 'pending' ? 'Propose a change from Routing & providers.' : undefined} />
                    </td>
                  </tr>
                </tbody>
              ) : (
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="ct-row-link" onClick={() => route.navigate(links.change(c.id), { query: route.query })}>
                      <td className="ct-mono">{c.id}</td>
                      <td>{KEY_INFO[c.key]?.title ?? c.key}</td>
                      <td className="ctm-small">
                        <span className="ctm-ellipsis" style={{ maxWidth: 340 }} title={summarizeChange(c.key, c.currentValue, c.proposedValue)}>
                          {summarizeChange(c.key, c.currentValue, c.proposedValue)}
                        </span>
                      </td>
                      <td>
                        {c.requestedBy.name}
                        <div className="ct-muted ctm-small">
                          <DateTime iso={c.requestedAt} now={now} relative />
                        </div>
                      </td>
                      <td>
                        <StatusBadge kind="change" value={c.status} />
                      </td>
                      <td>{c.reviewedBy ? c.reviewedBy.name : <span className="ct-muted">—</span>}</td>
                      <td className="ct-num">{c.appliedVersion ? `v${c.appliedVersion}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        )}
      </Card>
      {selectedId && <ChangeDrawer id={selectedId} onClose={() => route.navigate(links.changes(route.query))} onChanged={list.refresh} />}
    </div>
  );
}

type Dlg = 'approve' | 'reject' | 'withdraw' | null;

function ChangeDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const { user, can } = useSession();
  const cr = useApi((s) => configApi.change(id, s), [id], { intervalMs: 10_000 });
  const live = useApi((s) => configApi.config(s), []);
  const [dlg, setDlg] = useState<Dlg>(null);
  const c = cr.data;

  async function act(fn: () => Promise<ChangeRequest>, title: (r: ChangeRequest) => string) {
    try {
      const r = await fn();
      cr.refresh();
      live.refresh();
      onChanged();
      await toastDone(title(r), { type: 'config', id }, can);
    } catch (err) {
      toastError(err);
      throw err;
    }
  }

  const gate = c ? canReview(c, (p) => can(p), user?.id) : { allowed: false };
  const liveValue = c ? live.data?.values[c.key] : undefined;
  const stale = c && c.status === 'pending' && live.data && JSON.stringify(liveValue) !== JSON.stringify(c.currentValue);
  const mine = c && user && c.requestedBy.userId === user.id;

  return (
    <Drawer title={`Change request ${id}`} subtitle={c ? `${KEY_INFO[c.key]?.title ?? c.key} · ${c.key}` : undefined} onClose={onClose}>
      {cr.loading ? (
        <LoadingBlock lines={6} />
      ) : !c ? (
        <ErrorState error={cr.error ?? 'Change request not found'} onRetry={cr.refresh} />
      ) : (
        <div className="ctm-stack">
          <div className="ctm-row">
            <StatusBadge kind="change" value={c.status} />
            {c.appliedVersion && <span className="ct-muted ctm-small">applied as version {c.appliedVersion} (control.config.updated)</span>}
          </div>
          <Card title="Current vs proposed">
            <DiffTable configKey={c.key} before={c.currentValue} after={c.proposedValue} beforeLabel="At request time" />
            {stale && (
              <div className="ct-banner ct-banner-warn ctm-small" style={{ marginTop: 10 }}>
                The live value has changed since this request was made. Approving applies the proposed value on top of the live one:
                <div style={{ marginTop: 6 }}>
                  <DiffTable configKey={c.key} before={liveValue} after={c.proposedValue} beforeLabel="Live now" />
                </div>
              </div>
            )}
          </Card>
          <Card title="Request">
            <KeyValueList
              items={[
                ['Requested by', `${c.requestedBy.name} (${c.requestedBy.role})`],
                ['Requested at', <DateTime iso={c.requestedAt} />],
                ['Reason', c.reason],
                c.reviewedBy ? ['Reviewed by', `${c.reviewedBy.name} (${c.reviewedBy.role})`] : null,
                c.reviewedAt ? ['Reviewed at', <DateTime iso={c.reviewedAt} />] : null,
                c.reviewComment ? ['Review comment', c.reviewComment] : null,
                ['Setting', KEY_INFO[c.key]?.help ?? c.key],
              ]}
            />
          </Card>
          {c.status === 'pending' && (
            <Card title="Review" subtitle="Four-eyes: the requester cannot approve their own change">
              <div className="ctm-stack" style={{ gap: 10 }}>
                {mine && <div className="ct-banner ct-banner-warn ctm-small">You requested this change. Another approver must review it; you can withdraw it.</div>}
                {!can('config.approve') && !mine && <div className="ct-banner ctm-small">Waiting for an approver (permission config.approve).</div>}
                <div className="ctm-row">
                  <Button variant="primary" icon="check" gate={gate} onClick={() => setDlg('approve')}>
                    Approve & apply
                  </Button>
                  <Button variant="danger" icon="x" gate={gate} onClick={() => setDlg('reject')}>
                    Reject
                  </Button>
                  {mine && (
                    <Button icon="refund" onClick={() => setDlg('withdraw')}>
                      Withdraw
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
      {dlg === 'approve' && c && (
        <ReasonDialog
          title={`Approve ${c.id}`}
          description="The new value is published on the event log (control.config.updated) and every stage applies it from that point on."
          label="Comment"
          minLength={0}
          confirmLabel="Approve & apply"
          onConfirm={(comment) => act(() => configApi.approve(c.id, comment), (r) => `${r.id} approved${r.appliedVersion ? ` · applied as version ${r.appliedVersion}` : ''}`)}
          onClose={() => setDlg(null)}
        >
          <DiffTable configKey={c.key} before={liveValue ?? c.currentValue} after={c.proposedValue} />
        </ReasonDialog>
      )}
      {dlg === 'reject' && c && (
        <ReasonDialog title={`Reject ${c.id}`} label="Comment" minLength={5} confirmLabel="Reject change" variant="danger" placeholder="Why is this change not acceptable?" onConfirm={(comment) => act(() => configApi.reject(c.id, comment), (r) => `${r.id} rejected`)} onClose={() => setDlg(null)} />
      )}
      {dlg === 'withdraw' && c && (
        <ReasonDialog
          title={`Withdraw ${c.id}`}
          description="The request is closed without review. You can submit a new one later."
          label="Note"
          minLength={0}
          confirmLabel="Withdraw"
          onConfirm={() => act(() => configApi.withdraw(c.id), (r) => `${r.id} withdrawn`)}
          onClose={() => setDlg(null)}
        />
      )}
    </Drawer>
  );
}

export type { ChangeStatus };
