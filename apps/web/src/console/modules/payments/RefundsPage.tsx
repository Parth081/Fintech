// Refund requests: four-eyes queue. Requesters can withdraw their own; managers (payments.refund.approve)
// approve (publishes payment.refund_requested -> ledger reversal) or reject with a comment.
import { useState } from 'react';
import { opsApi, type RefundRequest } from '../../api';
import { links, useConsoleRoute } from '../../route';
import { useSession } from '../../session';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DateTime,
  Money,
  Page,
  PageHeader,
  Select,
  StatusBadge,
  isForbidden,
  shortId,
  useApi,
  useToast,
  type Column,
} from '../../ui';

type Pending = { kind: 'approve' | 'reject' | 'withdraw'; refund: RefundRequest } | null;

export function RefundsPage() {
  const { can, user } = useSession();
  const toast = useToast();
  const route = useConsoleRoute();
  const status = route.query.status ?? '';
  const q = (route.query.q ?? '').toUpperCase();
  const data = useApi((s) => opsApi.refunds(status ? { status } : {}, s), [status], { intervalMs: 15_000 });
  const [pending, setPending] = useState<Pending>(null);
  const rows = (data.data?.items ?? []).filter((r) => !q || r.id.includes(q) || r.paymentId.toUpperCase().includes(q));

  const act = async (p: NonNullable<Pending>, comment: string) => {
    if (p.kind === 'approve') {
      const r = await opsApi.approveRefund(p.refund.id, comment);
      toast.success(`Refund ${r.id} approved`, 'payment.refund_requested published; the ledger posts the reversal journal.', { label: 'Open payment', href: links.payment(r.paymentId, 'ledger') });
    } else if (p.kind === 'reject') {
      await opsApi.rejectRefund(p.refund.id, comment);
      toast.success(`Refund ${p.refund.id} rejected`);
    } else {
      await opsApi.withdrawRefund(p.refund.id);
      toast.success(`Refund ${p.refund.id} withdrawn`);
    }
    setPending(null);
    data.refresh();
  };

  const cols: Column<RefundRequest>[] = [
    { id: 'id', header: 'Request', cell: (r) => <span className="ct-mono">{r.id}</span>, sortValue: (r) => r.id },
    { id: 'payment', header: 'Payment', cell: (r) => <a className="ct-mono" href={links.payment(r.paymentId)}>{shortId(r.paymentId, 18)}</a> },
    { id: 'amount', header: 'Amount', numeric: true, cell: (r) => <Money value={r.amount} />, sortValue: (r) => r.amount?.amountMinor },
    { id: 'status', header: 'Status', cell: (r) => <StatusBadge kind="refund" value={r.status} />, sortValue: (r) => r.status },
    { id: 'reason', header: 'Reason', cell: (r) => <span className="ct-small">{r.reason}</span> },
    { id: 'by', header: 'Requested by', cell: (r) => r.requestedBy?.name ?? '—' },
    { id: 'at', header: 'Requested', cell: (r) => <DateTime value={r.requestedAt} relative />, sortValue: (r) => r.requestedAt, defaultSortDir: 'desc' },
    { id: 'review', header: 'Reviewed by', cell: (r) => (r.reviewedBy ? <span title={r.reviewComment}>{r.reviewedBy.name}</span> : <span className="ct-muted">—</span>) },
    {
      id: 'actions',
      header: '',
      cell: (r) => {
        if (r.status !== 'pending') return null;
        const mine = r.requestedBy?.userId === user?.id;
        return (
          <div className="ct-row" style={{ justifyContent: 'flex-end' }}>
            {can('payments.refund.approve') && !mine && (
              <>
                <Button size="sm" variant="primary" onClick={() => setPending({ kind: 'approve', refund: r })}>Approve</Button>
                <Button size="sm" onClick={() => setPending({ kind: 'reject', refund: r })}>Reject</Button>
              </>
            )}
            {mine && <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'withdraw', refund: r })}>Withdraw</Button>}
            {can('payments.refund.approve') && mine && <span className="ct-small ct-muted" title="Four-eyes: someone else must approve">Your request</span>}
          </div>
        );
      },
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Refunds"
        subtitle="Refund requests on reconciled payments. Four-eyes: the requester can never approve their own request."
        breadcrumbs={[{ label: 'Payments', href: links.payments() }, { label: 'Refunds' }]}
      />
      <Card flush>
        <div className="ct-toolbar">
          <Select
            compact
            aria-label="Status"
            value={status}
            placeholder="All statuses"
            options={[
              { value: 'pending', label: 'Pending approval' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'withdrawn', label: 'Withdrawn' },
            ]}
            onChange={(e) => route.setQuery({ status: e.target.value || null })}
          />
          <div className="ct-spacer" />
          <Button size="sm" icon="refresh" onClick={data.refresh} aria-label="Refresh" />
        </div>
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          loading={data.loading}
          error={data.error}
          forbidden={isForbidden(data.errorObj)}
          onRetry={data.refresh}
          initialSort={{ key: 'at', dir: 'desc' }}
          empty={status === 'pending' ? 'No refunds waiting for approval' : 'No refund requests'}
          emptyHint="Refunds are requested from a reconciled payment’s detail page."
        />
      </Card>
      <ConfirmDialog
        open={pending?.kind === 'approve'}
        title={`Approve refund ${pending?.refund.id ?? ''}?`}
        description="Approving publishes payment.refund_requested on the payment log and the ledger posts the reversal journal. This cannot be undone."
        confirmLabel="Approve refund"
        reasonLabel="Approval comment"
        onCancel={() => setPending(null)}
        onConfirm={(c) => act(pending!, c)}
      />
      <ConfirmDialog
        open={pending?.kind === 'reject'}
        title={`Reject refund ${pending?.refund.id ?? ''}?`}
        description="The requester sees your comment. The payment stays reconciled."
        confirmLabel="Reject refund"
        variant="danger"
        reasonLabel="Rejection comment"
        onCancel={() => setPending(null)}
        onConfirm={(c) => act(pending!, c)}
      />
      <ConfirmDialog
        open={pending?.kind === 'withdraw'}
        title={`Withdraw refund ${pending?.refund.id ?? ''}?`}
        description="The request is closed without a review."
        confirmLabel="Withdraw"
        variant="danger"
        requireReason={false}
        onCancel={() => setPending(null)}
        onConfirm={(c) => act(pending!, c)}
      />
    </Page>
  );
}
