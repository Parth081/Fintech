// Case management queues: My cases / Unassigned / Pending my approval / All.
import { useMemo, useState } from 'react';
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { isForbidden, useApi, useNow } from '../../ui/hooks';
import { Icon } from '../../ui/Icon';
import { riskApi } from './data';
import { CASE_QUEUES, caseSla, filterCases, inQueue, requiresApproval, type CaseQueue } from './lib/queue';
import { Badge, Button, Card, DateTime, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge, Tabs } from './kit';

export default function CasesPage() {
  const { user, can } = useSession();
  const route = useConsoleRoute();
  const now = useNow(1000);
  const canApprove = can('cases.approve');
  const fallback: CaseQueue = can('cases.work') ? 'mine' : 'all';
  const queue = (CASE_QUEUES.some((q) => q.id === route.query.queue) ? route.query.queue : fallback) as CaseQueue;
  const [q, setQ] = useState('');
  const cases = useApi((s) => riskApi.cases({ limit: 1000 }, s), [], { intervalMs: 10_000 });
  const all = cases.data?.items ?? [];
  const me = user?.id ?? '';
  const rows = useMemo(() => filterCases(all, queue, me, q), [all, queue, me, q]);
  const tabs = CASE_QUEUES.map((t) => ({
    ...t,
    count: all.filter((c) => inQueue(c, t.id, me)).length,
    hidden: (t.id === 'approval' && !canApprove) || (t.id === 'mine' && !can('cases.work')),
  }));
  const breaching = all.filter((c) => c.status !== 'closed' && caseSla(c, now).breached).length;

  return (
    <div className="ct-page">
      <PageHeader
        breadcrumb={[{ label: 'Risk & Compliance' }, { label: 'Cases' }]}
        title="Cases"
        subtitle="Investigations opened from alerts. High and critical decisions need a Compliance Manager’s approval (four-eyes)."
        actions={
          <>
            {breaching > 0 && (
              <Badge tone="bad">
                <Icon name="clock" size={12} /> {breaching} breaching SLA
              </Badge>
            )}
            <Button icon="alert" onClick={() => route.navigate(links.alerts())}>
              Alerts
            </Button>
            <Button icon="refresh" onClick={cases.refresh}>
              Refresh
            </Button>
          </>
        }
      />
      <Tabs tabs={tabs} value={queue} onChange={(id) => route.setQuery({ queue: id })} label="Case queues" />
      <Card flush>
        <div className="ct-toolbar">
          <input className="ct-input" type="search" placeholder="Search case, payment, assignee…" aria-label="Search cases" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 300 }} />
          <span className="ct-muted ctm-small">
            {rows.length} case{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        {cases.error && !cases.data ? (
          <ErrorState error={cases.error} onRetry={cases.refresh} forbidden={isForbidden(cases.errorObj)} />
        ) : (
          <div className="ct-table-wrap">
            <table className="ct-table ctm-table-dense">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th className="ct-num">Amount</th>
                  <th>Parties</th>
                  <th className="ct-num">Alerts</th>
                  <th>Assignee</th>
                  <th>SLA</th>
                  <th>Opened</th>
                </tr>
              </thead>
              {cases.loading ? (
                <LoadingRows cols={10} />
              ) : rows.length === 0 ? (
                <tbody>
                  <tr>
                    <td colSpan={10}>
                      <EmptyState
                        title={queue === 'mine' ? 'No cases assigned to you' : queue === 'approval' ? 'Nothing is waiting for your approval' : queue === 'unassigned' ? 'Every open case has an owner' : 'No cases yet'}
                        hint={queue === 'mine' ? 'Pick one up from Unassigned or assign alerts to yourself from the Alerts queue.' : undefined}
                        action={
                          queue === 'mine' ? (
                            <Button size="sm" onClick={() => route.setQuery({ queue: 'unassigned' })}>
                              View unassigned
                            </Button>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                </tbody>
              ) : (
                <tbody>
                  {rows.map((c) => {
                    const sla = caseSla(c, now);
                    return (
                      <tr key={c.caseId} className="ct-row-link" onClick={() => route.navigate(links.case(c.caseId))}>
                        <td className="ct-mono">{c.caseId}</td>
                        <td>
                          <StatusBadge kind="severity" value={c.priority} />
                        </td>
                        <td>
                          <div className="ctm-row" style={{ gap: 4 }}>
                            <StatusBadge kind="case" value={c.status} />
                            {c.status === 'pending_approval' && c.proposal && (
                              <span className="ct-muted ctm-small">
                                {c.proposal.decision} by {c.proposal.by.name}
                              </span>
                            )}
                            {c.status !== 'closed' && c.status !== 'pending_approval' && requiresApproval(c.priority) && (
                              <span className="ct-muted ctm-small" title="High/critical decisions need a Compliance Manager’s approval">
                                4-eyes
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <a className="ctm-link ct-mono" href={links.payment(c.paymentId)} onClick={(e) => e.stopPropagation()}>
                            {c.paymentId}
                          </a>
                          {c.payment && <div className="ct-muted ctm-small">{c.payment.corridor}</div>}
                        </td>
                        <td className="ct-num">{c.payment ? <Money value={c.payment.amount} /> : '—'}</td>
                        <td className="ctm-small">
                          {c.payment ? (
                            <>
                              <div className="ctm-ellipsis" style={{ maxWidth: 200 }}>
                                {c.payment.debtorName}
                              </div>
                              <div className="ct-muted ctm-ellipsis" style={{ maxWidth: 200 }}>
                                → {c.payment.creditorName}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="ct-num">{c.alertIds.length}</td>
                        <td>{c.assignee ? c.assignee.name : <span className="ct-muted">Unassigned</span>}</td>
                        <td>
                          <Badge tone={sla.tone}>
                            <Icon name="clock" size={12} />
                            {sla.label}
                          </Badge>
                        </td>
                        <td className="ctm-small">
                          <DateTime iso={c.openedAt} now={now} relative />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              )}
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
