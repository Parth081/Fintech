// Payment detail page (#/console/payments/:id): status header, amounts/FX/fees, parties, event timeline with
// decision traces, routing attempts, ISO 20022 messages, ledger journals (incl. refund reversal), linked
// case/alerts, operator activity, and permission/status-gated actions (Retry, Request refund, Open case).
import { useMemo, useState } from 'react';
import { PROVIDERS, isBalanced, type AnyEvent, type AuditEntry } from '@ct/contracts/browser';
import { gatewayApi, opsApi, type RefundRequest } from '../../api';
import { attemptsFrom } from '../../../lib/attempts';
import { formatInput, quoteView, reconView } from '../../../lib/detail';
import { XmlViewer } from '../../../components/XmlViewer';
import { EVENT_LABEL, eventActor, eventTone, paymentActions, type PaymentAction } from '../../lib/payments';
import { links, useConsoleRoute } from '../../route';
import { useSession } from '../../session';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  KeyValueList,
  LinkButton,
  Money,
  Page,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  Timeline,
  copyToClipboard,
  formatDuration,
  formatMoney,
  formatPercent,
  humanize,
  isForbidden,
  shortId,
  useApi,
  useToast,
  type Column,
} from '../../ui';

const providerName = (id?: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id ?? '—';

function TraceBlock({ e }: { e: AnyEvent }) {
  const t = e.trace;
  if (!t) return null;
  const inputs = Object.entries(t.inputs ?? {});
  return (
    <details style={{ marginTop: 6 }}>
      <summary className="ct-small" style={{ cursor: 'pointer', color: 'var(--ct-text-2)' }}>
        Decision trace · <strong>{t.decision}</strong>
        {t.reasonCodes.length > 0 && <> · {t.reasonCodes.join(', ')}</>} · {t.stage} {t.ruleVersion} · {formatDuration(t.latencyMs)}
      </summary>
      {inputs.length > 0 && (
        <table className="ct-table ct-table-compact" style={{ marginTop: 6 }}>
          <tbody>
            {inputs.map(([k, v]) => (
              <tr key={k}>
                <td className="ct-muted" style={{ width: 200 }}>{k}</td>
                <td className="ct-mono">{formatInput(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function eventSummary(e: AnyEvent): string {
  const p = e.payload as unknown as Record<string, unknown>;
  switch (e.type) {
    case 'payment.screened':
      return `Result ${String(p.result)} · list ${String(p.listVersion)}`;
    case 'payment.scored':
      return `${String(p.decision)} · fraud score ${Number(p.fraudScore).toFixed(2)}`;
    case 'payment.routed':
      return `${providerName(String(p.providerId))} · ${String(p.rail)}`;
    case 'payment.send_failed':
      return `${String(p.reasonCode ?? '')} ${String(p.reason ?? '')}`.trim();
    case 'payment.held':
    case 'payment.rejected':
    case 'payment.failed':
      return String(p.reason ?? '');
    case 'risk.alert_raised':
      return `${String(p.severity)} ${String(p.kind)} · ${String(p.rule ?? '')}`;
    case 'payment.retry_requested':
    case 'payment.refund_requested':
    case 'payment.released':
      return p.reason ? `“${String(p.reason)}”` : '';
    default:
      return '';
  }
}

const auditCols: Column<AuditEntry>[] = [
  { id: 'at', header: 'When', cell: (a) => <DateTime value={a.at} /> },
  { id: 'actor', header: 'Actor', cell: (a) => <>{a.actor.name} <span className="ct-muted ct-small">{humanize(a.actor.role)}</span></> },
  { id: 'action', header: 'Action', cell: (a) => <code>{a.action}</code> },
  { id: 'details', header: 'Details', cell: (a) => <span className="ct-small">{typeof a.details.reason === 'string' ? `“${a.details.reason}”` : typeof a.details.comment === 'string' && a.details.comment ? `“${a.details.comment}”` : Object.keys(a.details).slice(0, 3).join(', ')}</span> },
  { id: 'link', header: '', cell: (a) => <a className="ct-small" href={links.audit({ targetId: a.target.id, entry: a.id })}>Audit entry →</a> },
];

export function PaymentDetailPage({ paymentId }: { paymentId: string }) {
  const { can } = useSession();
  const toast = useToast();
  const route = useConsoleRoute();
  const tab = route.query.tab ?? 'overview';
  const [confirm, setConfirm] = useState<PaymentAction | null>(null);

  const detail = useApi((s) => gatewayApi.payment(paymentId, s), [paymentId], { intervalMs: 5_000 });
  const status = detail.data?.state.status;
  const eventCount = detail.data?.events.length ?? 0;
  const messages = useApi((s) => gatewayApi.messages(paymentId, s), [paymentId, eventCount], { enabled: !!detail.data });
  const journals = useApi((s) => gatewayApi.journals(paymentId, s), [paymentId, detail.data?.state.ledgerPosted, status], { enabled: !!detail.data?.state.ledgerPosted });
  const activity = useApi((s) => opsApi.activity(paymentId, s), [paymentId, eventCount]);
  const alerts = useApi((s) => opsApi.paymentAlerts(paymentId, s), [paymentId, eventCount], { enabled: can('alerts.read') });
  const refunds = useApi((s) => opsApi.refunds({ paymentId }, s), [paymentId, eventCount]);

  const caseId = alerts.data?.items.find((a) => a.caseId)?.caseId ?? null;
  const pendingRefund = (refunds.data?.items ?? []).some((r) => r.status === 'pending');
  const actions = status ? paymentActions(status, can, { pendingRefund, caseId }) : [];
  const attempts = useMemo(() => (detail.data ? attemptsFrom(detail.data.events) : null), [detail.data]);

  if (detail.loading) {
    return (
      <Page>
        <Skeleton width={320} height={26} />
        <Skeleton width={420} style={{ margin: '10px 0 24px' }} />
        <div className="ct-split">
          <div className="ct-card ct-card-body"><Skeleton lines={10} /></div>
          <div className="ct-card ct-card-body"><Skeleton lines={6} /></div>
        </div>
      </Page>
    );
  }
  if (!detail.data) {
    const notFound = /404|not found/i.test(detail.error ?? '');
    return (
      <Page>
        <PageHeader title="Payment" breadcrumbs={[{ label: 'Payments', href: links.payments() }, { label: shortId(paymentId, 24) }]} />
        <div className="ct-card">
          {notFound ? (
            <EmptyState icon="search" title="Payment not found" actions={<LinkButton href={links.payments({ q: paymentId })}>Search payments</LinkButton>}>
              No payment with ID <code>{paymentId}</code> is on the event log.
            </EmptyState>
          ) : (
            <ErrorState error={detail.error ?? 'Unknown error'} onRetry={detail.refresh} />
          )}
        </div>
      </Page>
    );
  }

  const { state, events } = detail.data;
  const init = state.initiated;
  const f = state.facts;
  const quote = quoteView(state);
  const recon = reconView(state);
  const routed = f['payment.routed'];

  const run = async (action: PaymentAction, reason: string) => {
    if (action === 'retry') {
      const r = await opsApi.retry(paymentId, reason);
      toast.success('Retry requested', `Event ${shortId(r.eventId, 18)} published; the orchestrator will re-route the payment.`, { label: 'View in audit log', href: links.audit({ targetId: paymentId }) });
    } else if (action === 'refund') {
      const r: RefundRequest = await opsApi.requestRefund(paymentId, reason);
      toast.success(`Refund ${r.id} requested`, 'A compliance manager must approve it (four-eyes) before the reversal is posted.', { label: 'Open refund queue', href: links.refunds({ status: 'pending' }) });
    }
    setConfirm(null);
    detail.refresh();
    activity.refresh();
    refunds.refresh();
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'timeline', label: 'Event timeline', count: events.length },
    { id: 'routing', label: 'Routing', count: attempts?.attempts.length ?? 0 },
    { id: 'messages', label: 'ISO 20022', count: messages.data?.length ?? 0 },
    { id: 'ledger', label: 'Ledger', count: journals.data?.length ?? 0 },
    { id: 'activity', label: 'Operator activity', count: activity.data?.length ?? 0 },
  ];

  const visibleActions = actions.filter((a) => a.visible);

  return (
    <Page>
      <PageHeader
        breadcrumbs={[{ label: 'Payments', href: links.payments() }, { label: shortId(paymentId, 24) }]}
        title={<span className="ct-mono" style={{ fontSize: 20 }}>{shortId(paymentId, 36)}</span>}
        badge={<StatusBadge kind="payment" value={state.status} />}
        subtitle={
          <>
            {formatMoney(init.amount)} · {init.corridor} · {init.debtor.name} → {init.creditor.name} · created <DateTime value={state.createdAt} />
          </>
        }
        actions={
          <>
            <Button icon="copy" onClick={() => void copyToClipboard(paymentId).then((ok) => ok && toast.show({ title: 'Payment ID copied' }))}>Copy ID</Button>
            {visibleActions.map((a) =>
              a.action === 'case' ? (
                a.enabled && caseId ? (
                  <LinkButton key={a.action} href={links.case(caseId)} variant="primary" icon="cases">Open case {caseId}</LinkButton>
                ) : (
                  <span key={a.action} title={a.reason}><Button icon="cases" disabled>Open case</Button></span>
                )
              ) : (
                <span key={a.action} title={a.enabled ? undefined : a.reason}>
                  <Button variant={a.action === 'retry' ? 'primary' : 'default'} icon={a.action === 'retry' ? 'refresh' : 'refund'} disabled={!a.enabled} onClick={() => setConfirm(a.action)}>
                    {a.label}
                  </Button>
                </span>
              ),
            )}
          </>
        }
      />

      {state.status === 'held' && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="warn">
            Held for compliance review{f['payment.held'] ? `: ${f['payment.held'].reason}` : ''}.{' '}
            {caseId ? <a href={links.case(caseId)}>Case {caseId}</a> : 'A case opens automatically when the risk alert is processed.'}
          </Banner>
        </div>
      )}
      {state.status === 'failed' && f['payment.failed'] && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="bad">Failed at {f['payment.failed'].atStage}: {f['payment.failed'].reason}. {can('payments.retry') ? 'You can retry it once the provider issue is resolved.' : ''}</Banner>
        </div>
      )}
      {pendingRefund && (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="info">A refund request is pending four-eyes approval. <a href={links.refunds({ status: 'pending' })}>Refund queue</a></Banner>
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={(t) => route.setQuery({ tab: t === 'overview' ? null : t })} label="Payment sections" />

      {tab === 'overview' && (
        <div className="ct-split">
          <div className="ct-stack">
            <Card title="Amounts, FX and fees">
              <KeyValueList
                items={[
                  { label: 'Sent amount', value: <Money value={init.amount} /> },
                  { label: 'Beneficiary receives', value: quote ? quote.target : `— (${init.targetCurrency})` },
                  { label: 'FX rate', value: quote ? <>{quote.rate} <span className="ct-muted">mid {quote.mid ?? '—'}</span></> : null },
                  { label: 'FX spread', value: quote ? `${quote.spreadBps} bps${quote.effectiveSpreadBps !== null ? ` (effective ${quote.effectiveSpreadBps} bps)` : ''}` : null },
                  { label: 'Quote', value: quote ? <span className="ct-mono">{quote.quoteId}</span> : null },
                  { label: 'Provider fee (est.)', value: routed ? <Money value={routed.estimatedFee} /> : null },
                  { label: 'Provider', value: routed ? `${providerName(routed.providerId)} · ${routed.rail}` : null },
                  { label: 'Reconciliation', value: recon ? (recon.matched ? <Badge tone="ok" dot>Matched · {recon.statementRef}</Badge> : <Badge tone="bad" dot>Break · {recon.breaks.join(', ') || recon.statementRef}</Badge>) : null },
                ]}
              />
            </Card>
            <div className="ct-grid ct-grid-2">
              <Card title="Debtor (sender)">
                <KeyValueList items={[{ label: 'Name', value: init.debtor.name }, { label: 'Country', value: init.debtor.country }, { label: 'Account', value: <span className="ct-mono">{init.debtor.accountId}</span> }]} />
              </Card>
              <Card title="Creditor (beneficiary)">
                <KeyValueList items={[{ label: 'Name', value: init.creditor.name }, { label: 'Country', value: init.creditor.country }, { label: 'Account', value: <span className="ct-mono">{init.creditor.accountId}</span> }]} />
              </Card>
            </div>
          </div>
          <div className="ct-stack">
            <Card title="Identifiers">
              <KeyValueList
                items={[
                  { label: 'End-to-end ID', value: <span className="ct-mono">{paymentId}</span> },
                  { label: 'Idempotency key', value: <span className="ct-mono">{init.idempotencyKey}</span> },
                  { label: 'pacs.008 msg ID', value: f['payment.sent'] ? <span className="ct-mono">{f['payment.sent'].messageId}</span> : null },
                  { label: 'Settlement ref', value: f['payment.settled'] ? <span className="ct-mono">{f['payment.settled'].settlementRef}</span> : null },
                  { label: 'Ledger journal', value: f['ledger.posted'] ? <span className="ct-mono">{f['ledger.posted'].journalId}</span> : null },
                  { label: 'Scenario', value: init.scenario ?? null, hidden: !init.scenario },
                  { label: 'Last update', value: <DateTime value={state.updatedAt} /> },
                ]}
              />
            </Card>
            <Card title="Risk & compliance" actions={caseId ? <a className="ct-small" href={links.case(caseId)}>Case {caseId} →</a> : undefined}>
              {!can('alerts.read') ? (
                <span className="ct-muted">You don't have permission: alerts.read</span>
              ) : alerts.loading ? (
                <Skeleton lines={3} />
              ) : (alerts.data?.items.length ?? 0) === 0 ? (
                <span className="ct-muted">No risk alerts on this payment.</span>
              ) : (
                <div className="ct-stack-sm">
                  {alerts.data!.items.map((a) => (
                    <a key={a.alertId} href={links.alert(a.alertId)} className="ct-row" style={{ color: 'inherit' }}>
                      <StatusBadge kind="severity" value={a.severity} />
                      <span className="ct-strong">{humanize(a.kind)}</span>
                      <span className="ct-ellipsis ct-muted">{a.summary}</span>
                    </a>
                  ))}
                </div>
              )}
            </Card>
            {(refunds.data?.items.length ?? 0) > 0 && (
              <Card title="Refund requests">
                <div className="ct-stack-sm">
                  {refunds.data!.items.map((r) => (
                    <div key={r.id} className="ct-row">
                      <span className="ct-mono">{r.id}</span>
                      <StatusBadge kind="refund" value={r.status} />
                      <span className="ct-small ct-muted">{r.requestedBy?.name}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'timeline' && (
        <Card title="Event timeline" subtitle="Every event on the immutable payment log, with each stage's decision trace">
          <Timeline
            items={events.map((e) => {
              const actor = eventActor(e);
              const summary = eventSummary(e);
              return {
                id: e.eventId,
                tone: eventTone(e),
                title: EVENT_LABEL[e.type] ?? e.type,
                meta: (
                  <>
                    <DateTime value={e.occurredAt} /> · {e.producer}
                    {actor && <> · by {actor.name} ({humanize(actor.role)})</>}
                  </>
                ),
                body: (
                  <>
                    {summary && <div>{summary}</div>}
                    <div className="ct-small ct-muted ct-mono">{e.eventId}</div>
                    <TraceBlock e={e} />
                  </>
                ),
              };
            })}
          />
          {(detail.data.droppedEvents ?? 0) > 0 && <Banner tone="warn">{detail.data.droppedEvents} older events were not kept in memory.</Banner>}
        </Card>
      )}

      {tab === 'routing' && (
        <div className="ct-stack">
          {!attempts || attempts.attempts.length === 0 ? (
            <Card><EmptyState icon="routing" title="Not routed yet">Routing happens after screening, scoring and FX quoting.</EmptyState></Card>
          ) : (
            attempts.attempts.map((a) => (
              <Card
                key={`${a.attempt}-${a.routedAt}`}
                title={`Attempt ${a.attempt} · ${providerName(a.providerId)}`}
                subtitle={<>{a.rail} · est. fee {formatMoney(a.estimatedFee)} · <DateTime value={a.routedAt} /></>}
                actions={<Badge tone={a.outcome === 'settled' ? 'ok' : a.outcome === 'rejected' ? 'bad' : 'info'} dot>{a.outcome === 'rejected' ? `Rejected ${a.reasonCode ?? ''}` : humanize(a.outcome)}</Badge>}
                flush
              >
                {a.reason && <div className="ct-card-body" style={{ paddingBottom: 0 }}><Banner tone="bad">Provider reason: {a.reason}</Banner></div>}
                {a.excludedProviders.length > 0 && <div className="ct-card-body ct-small ct-muted" style={{ paddingBottom: 0 }}>Excluded after earlier failures: {a.excludedProviders.map(providerName).join(', ')}</div>}
                <div className="ct-table-wrap">
                  <table className="ct-table ct-table-compact">
                    <thead>
                      <tr><th>Provider</th><th className="ct-num">Score</th><th>Eligible</th><th className="ct-num">Fee</th><th className="ct-num">Success rate</th><th className="ct-num">Latency</th><th>Excluded because</th></tr>
                    </thead>
                    <tbody>
                      {a.scoring.map((s) => (
                        <tr key={s.providerId} className={s.chosen ? 'ct-row-selected' : undefined}>
                          <td>{providerName(s.providerId)} {s.chosen && <Badge tone="accent">chosen</Badge>}</td>
                          <td className="ct-num">{Number.isFinite(s.score) ? s.score.toFixed(3) : '—'}</td>
                          <td>{s.eligible ? <span className="ct-text-ok">Yes</span> : <span className="ct-text-bad">No</span>}</td>
                          <td className="ct-num">{a.fullScoring ? formatMoney(s.fee) : '—'}</td>
                          <td className="ct-num">{a.fullScoring ? formatPercent(s.successRate) : '—'}</td>
                          <td className="ct-num">{a.fullScoring ? formatDuration(s.latencyMs) : '—'}</td>
                          <td className="ct-small ct-muted">{s.excludedReason ? humanize(s.excludedReason.toLowerCase()) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))
          )}
          {attempts?.failed && <Banner tone="bad">Failed after {attempts.failed.attempts ?? attempts.attempts.length} attempts: {attempts.failed.reason}</Banner>}
        </div>
      )}

      {tab === 'messages' && (
        <div className="ct-stack">
          {messages.loading ? (
            <Card><Skeleton lines={6} /></Card>
          ) : messages.error ? (
            <Card><ErrorState error={messages.error} onRetry={messages.refresh} /></Card>
          ) : (messages.data ?? []).length === 0 ? (
            <Card><EmptyState icon="code" title="No ISO 20022 messages yet">The pacs.008 is generated when the payment is sent to a provider.</EmptyState></Card>
          ) : (
            messages.data!.map((m) => (
              <Card
                key={m.eventId}
                title={`${m.messageType}${m.status ? ` · ${m.status}` : ''}`}
                subtitle={<>{providerName(m.providerId)}{m.attempt ? ` · attempt ${m.attempt}` : ''} · <DateTime value={m.occurredAt} />{m.reasonCode ? ` · ${m.reasonCode}` : ''}</>}
              >
                <XmlViewer xml={m.xml} title={`${m.messageType} XML`} />
              </Card>
            ))
          )}
        </div>
      )}

      {tab === 'ledger' && (
        <div className="ct-stack">
          {!state.ledgerPosted ? (
            <Card><EmptyState icon="bank" title="No ledger postings yet">The double-entry journal is posted when the provider settles.</EmptyState></Card>
          ) : journals.loading ? (
            <Card><Skeleton lines={6} /></Card>
          ) : journals.error ? (
            <Card><ErrorState error={journals.error} onRetry={journals.refresh} /></Card>
          ) : (
            (journals.data ?? []).map((j) => {
              const balanced = isBalanced(j.entries.map((e) => ({ account: e.accountId, direction: e.direction, amount: e.amount })));
              return (
                <Card
                  key={j.journalId}
                  flush
                  title={<>{j.kind === 'refund' || /refund|reversal/i.test(j.kind) ? 'Refund reversal' : humanize(j.kind)} journal <span className="ct-mono ct-muted" style={{ fontWeight: 400 }}>{j.journalId}</span></>}
                  subtitle={<>Posted <DateTime value={j.postedAt} /> · caused by event <span className="ct-mono">{shortId(j.causationEventId, 18)}</span></>}
                  actions={<Badge tone={balanced ? 'ok' : 'bad'} dot>{balanced ? 'Balanced' : 'Unbalanced'}</Badge>}
                >
                  <table className="ct-table ct-table-compact">
                    <thead><tr><th>Account</th><th className="ct-num">Debit</th><th className="ct-num">Credit</th></tr></thead>
                    <tbody>
                      {j.entries.map((e, i) => (
                        <tr key={i}>
                          <td className="ct-mono">{e.accountId}</td>
                          <td className="ct-num">{e.direction === 'debit' ? formatMoney(e.amount) : ''}</td>
                          <td className="ct-num">{e.direction === 'credit' ? formatMoney(e.amount) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              );
            })
          )}
        </div>
      )}

      {tab === 'activity' && (
        <Card title="Operator activity" subtitle="Human actions on this payment, from the audit trail" flush>
          <DataTable
            columns={auditCols}
            rows={activity.data}
            rowKey={(a) => a.id}
            loading={activity.loading}
            error={activity.error}
            forbidden={isForbidden(activity.errorObj)}
            onRetry={activity.refresh}
            empty="No operator actions on this payment"
            emptyHint="Retries, refunds and compliance decisions appear here with who did them and why."
          />
          {activity.data?.some((a) => a.eventId) && (
            <div className="ct-card-footer ct-small ct-muted">
              Actions that changed the payment link to their event on the log:{' '}
              {activity.data.filter((a) => a.eventId).map((a) => (
                <a key={a.id} className="ct-mono" href={links.payment(paymentId, 'timeline')} style={{ marginRight: 8 }}>{shortId(a.eventId!, 14)}</a>
              ))}
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirm === 'retry'}
        title="Retry this payment?"
        description={<>The orchestrator re-routes <span className="ct-mono">{shortId(paymentId, 20)}</span> ({formatMoney(init.amount)}) to the best eligible provider. A <code>payment.retry_requested</code> event is published with your name.</>}
        confirmLabel="Retry payment"
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) => run('retry', reason)}
      />
      <ConfirmDialog
        open={confirm === 'refund'}
        title="Request a refund?"
        description={<>Requests a full refund of {formatMoney(init.amount)} to {init.debtor.name}. A compliance manager must approve it (four-eyes) before the ledger posts the reversal.</>}
        confirmLabel="Request refund"
        variant="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={(reason) => run('refund', reason)}
      />
    </Page>
  );
}
