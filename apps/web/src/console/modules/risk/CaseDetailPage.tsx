// Case detail: header (priority, status, SLA, assignee), payment summary, per-alert investigator explanation,
// notes, decision panel with four-eyes approval, and the case history.
import { useMemo, useState } from 'react';
import { DEFAULT_CONFIG, ROLE_PERMISSIONS, type CaseDecision } from '@ct/contracts/browser';
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { isForbidden, useApi, useNow } from '../../ui/hooks';
import { Icon } from '../../ui/Icon';
import { riskApi, type CaseDetail } from './data';
import { auditToHistory, mergeHistory } from './lib/evidence';
import { canAddNote, canApprove, canAssign, canDecide, caseHistory, caseSla, KIND_LABEL, requiresApproval, usersWith, type Gate } from './lib/queue';
import { AlertExplanation } from './EvidencePanels';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  ErrorState,
  KeyValueList,
  LoadingBlock,
  Money,
  PageHeader,
  ReasonDialog,
  StatusBadge,
  Timeline,
  toastDone,
  toastError,
} from './kit';

type Dialog = { kind: 'decide'; decision: CaseDecision } | { kind: 'approve' } | { kind: 'return' } | { kind: 'close' } | null;

export default function CaseDetailPage({ caseId }: { caseId: string }) {
  const { user, can } = useSession();
  const route = useConsoleRoute();
  const now = useNow(1000);
  const detail = useApi((s) => riskApi.caseById(caseId, s), [caseId], { intervalMs: 8_000 });
  const c = detail.data;
  const activity = useApi((s) => riskApi.activity(c!.paymentId, s), [c?.paymentId], { enabled: !!c?.paymentId && can('payments.read'), intervalMs: 15_000 });
  const users = useApi((s) => riskApi.users(s), [], { enabled: can('cases.work') });
  const config = useApi((s) => riskApi.config(s), [], { enabled: can('config.read') });
  const thresholds = config.data?.values['risk.thresholds'] ?? DEFAULT_CONFIG['risk.thresholds'];
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const me = user ? { userId: user.id, name: user.name, role: user.role } : null;
  const history = useMemo(() => {
    if (!c) return [];
    const own = caseHistory(c, c.alerts);
    const audit = auditToHistory((activity.data ?? []).filter((e) => e.target.id === c.caseId || e.target.id === c.paymentId));
    return mergeHistory(own, audit).reverse();
  }, [c, activity.data]);

  if (detail.loading) {
    return (
      <div className="ct-page">
        <PageHeader breadcrumb={[{ label: 'Risk & Compliance' }, { label: 'Cases', href: links.cases() }, { label: caseId }]} title={caseId} />
        <div className="ct-split">
          <Card>
            <LoadingBlock lines={6} />
          </Card>
          <Card>
            <LoadingBlock lines={4} />
          </Card>
        </div>
      </div>
    );
  }
  if (!c) {
    return (
      <div className="ct-page">
        <PageHeader breadcrumb={[{ label: 'Risk & Compliance' }, { label: 'Cases', href: links.cases() }, { label: caseId }]} title={caseId} />
        <Card>
          <ErrorState error={detail.error ?? 'Case not found'} onRetry={detail.refresh} forbidden={isForbidden(detail.errorObj)} />
        </Card>
      </div>
    );
  }

  const sla = caseSla(c, now);
  const assignGate = canAssign(c, can);
  const noteGate = canAddNote(c, can);
  const decideGate = canDecide(c, can, me);
  const approveGate = canApprove(c, can, me);
  const fourEyes = requiresApproval(c.priority);
  const assignable = usersWith(users.data ?? [], 'cases.work', ROLE_PERMISSIONS);
  const notHeld = c.actionable === false && c.status !== 'closed';

  async function act(label: string, run: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await run();
      detail.refresh();
      activity.refresh();
      await toastDone(success, { type: 'case', id: caseId, paymentId: c!.paymentId }, can);
    } catch (err) {
      toastError(err);
      throw err;
    } finally {
      setBusy(null);
    }
  }

  const assign = (userId: string | null) =>
    act('assign', () => riskApi.assign(caseId, userId), userId ? `Case assigned to ${userId === user?.id ? 'you' : (assignable.find((u) => u.id === userId)?.name ?? userId)}` : 'Case unassigned').catch(() => undefined);

  async function addNote() {
    const t = note.trim();
    if (!t) return;
    await act('note', () => riskApi.note(caseId, t), 'Note added')
      .then(() => setNote(''))
      .catch(() => undefined);
  }

  return (
    <div className="ct-page">
      <PageHeader
        breadcrumb={[{ label: 'Risk & Compliance' }, { label: 'Cases', href: links.cases() }, { label: c.caseId }]}
        title={
          <span className="ctm-row" style={{ gap: 10 }}>
            <span className="ct-mono" style={{ fontSize: 20 }}>
              {c.caseId}
            </span>
            <StatusBadge kind="severity" value={c.priority} />
            <StatusBadge kind="case" value={c.status} />
            <Badge tone={sla.tone} title={`SLA due ${new Date(c.slaDueAt).toLocaleString()}`}>
              <Icon name="clock" size={12} />
              {sla.label}
            </Badge>
          </span>
        }
        subtitle={`${c.alerts.map((a) => KIND_LABEL[a.kind]).filter((k, i, all) => all.indexOf(k) === i).join(' + ')} investigation · opened ${new Date(c.openedAt).toLocaleString()}`}
        actions={
          <>
            <span className="ctm-row ctm-small" style={{ gap: 6 }}>
              {c.assignee ? <Avatar name={c.assignee.name} /> : null}
              <span>
                <span className="ct-muted">Assignee </span>
                <strong>{c.assignee ? c.assignee.name : 'Unassigned'}</strong>
              </span>
            </span>
            {c.assignee?.userId !== user?.id && (
              <Button size="sm" variant="primary" gate={assignGate} busy={busy === 'assign'} onClick={() => user && void assign(user.id)}>
                Assign to me
              </Button>
            )}
            {assignGate.allowed ? (
              <select
                className="ct-select"
                aria-label="Reassign case"
                value=""
                disabled={busy !== null}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) void assign(v === '__none__' ? null : v);
                }}
              >
                <option value="">Reassign…</option>
                {assignable
                  .filter((u) => u.id !== c.assignee?.userId)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} — {u.title}
                    </option>
                  ))}
                {c.assignee && <option value="__none__">Unassign</option>}
              </select>
            ) : null}
          </>
        }
      />

      <div className="ct-split">
        <div className="ctm-stack">
          <Card title="Payment" actions={<a className="ctm-link ctm-small" href={links.payment(c.paymentId)}>Open payment →</a>}>
            {c.payment ? (
              <div className="ct-grid ct-grid-2">
                <KeyValueList
                  items={[
                    ['Payment', <a className="ctm-link ct-mono" href={links.payment(c.paymentId)}>{c.paymentId}</a>],
                    ['Amount', <Money value={c.payment.amount} />],
                    ['Corridor', c.payment.corridor],
                    ['Status', <StatusBadge kind="payment" value={c.payment.status} />],
                  ]}
                />
                <KeyValueList
                  items={[
                    ['Sender', c.payment.debtorName],
                    ['Beneficiary', c.payment.creditorName],
                    ['Alerts', `${c.alertIds.length} (${c.alerts.map((a) => a.severity).join(', ')})`],
                  ]}
                />
              </div>
            ) : (
              <KeyValueList items={[['Payment', <a className="ctm-link ct-mono" href={links.payment(c.paymentId)}>{c.paymentId}</a>]]} />
            )}
            {notHeld && (
              <div className="ct-banner ct-banner-info" style={{ marginTop: 12 }}>
                This payment is not held ({c.payment?.status ?? 'unknown'}), so there is nothing to release or reject. Close the case once reviewed.
              </div>
            )}
          </Card>

          {c.alerts.length === 0 ? (
            <Card title="Alerts">
              <EmptyState title="Alert details are not available" />
            </Card>
          ) : (
            c.alerts.map((a) => <AlertExplanation key={a.alertId} alert={a} thresholds={thresholds} />)
          )}

          <Card title={`Notes (${c.notes.length})`}>
            <div className="ctm-stack" style={{ gap: 8 }}>
              {c.notes.length === 0 && <div className="ct-muted">No notes yet. Record what you checked and why.</div>}
              {c.notes.map((n, i) => (
                <div key={i} className="ctm-note">
                  <div className="ctm-note-head">
                    <span className="ctm-row" style={{ gap: 6 }}>
                      <Avatar name={n.actor.name} />
                      <strong style={{ color: 'var(--ct-text)' }}>{n.actor.name}</strong>
                      <span>{n.actor.role.replace(/_/g, ' ')}</span>
                    </span>
                    <DateTime iso={n.at} now={now} />
                  </div>
                  <div className="ctm-note-text">{n.text}</div>
                </div>
              ))}
              <label className="ct-field" style={{ marginTop: 8 }}>
                <span className="ct-label">Add a note</span>
                <textarea
                  className="ct-textarea"
                  placeholder={noteGate.allowed ? 'Findings, checks performed, contact with the customer…' : noteGate.reason}
                  value={note}
                  disabled={!noteGate.allowed}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void addNote();
                  }}
                />
              </label>
              <div className="ctm-row" style={{ justifyContent: 'flex-end' }}>
                <Button size="sm" gate={noteGate} disabled={!note.trim()} busy={busy === 'note'} onClick={() => void addNote()}>
                  Add note
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <div className="ctm-stack">
          <DecisionPanel
            c={c}
            fourEyes={fourEyes}
            decideGate={decideGate}
            approveGate={approveGate}
            notHeld={notHeld}
            canApprovePerm={can('cases.approve')}
            myId={user?.id}
            onDialog={setDialog}
          />
          <Card title="Case history" subtitle="Newest first · from the case record and the audit trail">
            <Timeline items={history} now={now} />
          </Card>
        </div>
      </div>

      {dialog?.kind === 'decide' && (
        <ReasonDialog
          title={`${fourEyes ? 'Propose' : 'Confirm'} ${dialog.decision === 'release' ? 'release' : 'rejection'}`}
          description={
            <>
              {dialog.decision === 'release' ? 'The held payment continues processing (FX quote, routing, settlement).' : 'The payment is rejected and the sender is notified. This cannot be undone.'}
              {fourEyes && (
                <div className="ct-banner ct-banner-warn" style={{ marginTop: 8 }}>
                  This is a {c.priority} priority case: the decision requires approval by a Compliance Manager before it takes effect.
                </div>
              )}
            </>
          }
          confirmLabel={fourEyes ? 'Submit for approval' : dialog.decision === 'release' ? 'Release payment' : 'Reject payment'}
          variant={dialog.decision === 'reject' ? 'danger' : 'primary'}
          placeholder="Why is this the right decision? Reference the evidence you checked."
          onConfirm={(reason) =>
            act('decide', () => riskApi.decide(caseId, dialog.decision, reason), fourEyes ? `Decision proposed: ${dialog.decision} — waiting for a Compliance Manager` : `Payment ${dialog.decision === 'release' ? 'released' : 'rejected'}`)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'approve' && c.proposal && (
        <ReasonDialog
          title={`Approve ${c.proposal.decision}`}
          description={`You are the second pair of eyes on ${c.proposal.by.name}’s proposal to ${c.proposal.decision} this payment. Approving makes the decision take effect immediately.`}
          label="Comment"
          minLength={0}
          confirmLabel={`Approve and ${c.proposal.decision}`}
          variant={c.proposal.decision === 'reject' ? 'danger' : 'primary'}
          onConfirm={(comment) => act('approve', () => riskApi.approve(caseId, comment), `Approved: payment ${c.proposal?.decision === 'release' ? 'released' : 'rejected'}`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'return' && (
        <ReasonDialog
          title="Return for more work"
          description="The proposal is withdrawn and the case goes back to the analyst for further review."
          label="Comment"
          minLength={5}
          confirmLabel="Return case"
          placeholder="What needs to be checked or clarified?"
          onConfirm={(comment) => act('return', () => riskApi.returnCase(caseId, comment), 'Case returned to the analyst')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'close' && (
        <ReasonDialog
          title="Close case without action"
          description="The payment is not held, so no release or rejection is published. The case is closed with your reason."
          confirmLabel="Close case"
          onConfirm={(reason) => act('close', () => riskApi.close(caseId, reason), 'Case closed')}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function DecisionPanel({
  c,
  fourEyes,
  decideGate,
  approveGate,
  notHeld,
  canApprovePerm,
  myId,
  onDialog,
}: {
  c: CaseDetail;
  fourEyes: boolean;
  decideGate: Gate;
  approveGate: Gate;
  notHeld: boolean;
  canApprovePerm: boolean;
  myId: string | undefined;
  onDialog(d: Dialog): void;
}) {
  if (c.status === 'closed') {
    const d = c.decision;
    return (
      <Card title="Decision">
        {d ? (
          <div className="ctm-stack" style={{ gap: 8 }}>
            <div className="ctm-row">
              <Badge tone={d.decision === 'release' ? 'ok' : 'bad'}>{d.decision === 'release' ? 'Released' : 'Rejected'}</Badge>
              <span className="ct-muted ctm-small">
                <DateTime iso={d.at} />
              </span>
            </div>
            <KeyValueList items={[['Decided by', d.by.name], d.approvedBy ? ['Approved by', d.approvedBy.name] : null, ['Reason', d.reason]]} />
          </div>
        ) : (
          <div className="ct-muted">Closed.</div>
        )}
      </Card>
    );
  }
  if (c.status === 'pending_approval' && c.proposal) {
    const mine = c.proposal.by.userId === myId;
    return (
      <Card title="Awaiting approval" subtitle="Four-eyes: a Compliance Manager other than the proposer must approve">
        <div className="ctm-stack" style={{ gap: 10 }}>
          <div className="ctm-row">
            <Badge tone={c.proposal.decision === 'release' ? 'ok' : 'bad'}>Proposed: {c.proposal.decision}</Badge>
            <span className="ct-muted ctm-small">
              by {c.proposal.by.name} · <DateTime iso={c.proposal.at} relative />
            </span>
          </div>
          <div className="ctm-note">
            <div className="ctm-note-text">{c.proposal.reason}</div>
          </div>
          {mine && <div className="ct-banner ct-banner-warn">You proposed this decision. Another Compliance Manager must approve it — you cannot approve your own proposal.</div>}
          {!canApprovePerm && !mine && <div className="ct-banner">Waiting for a Compliance Manager (permission cases.approve).</div>}
          {canApprovePerm && (
            <div className="ctm-row">
              <Button variant={c.proposal.decision === 'reject' ? 'danger' : 'primary'} icon="check" gate={approveGate} onClick={() => onDialog({ kind: 'approve' })}>
                Approve {c.proposal.decision}
              </Button>
              <Button icon="chevronLeft" gate={approveGate} onClick={() => onDialog({ kind: 'return' })}>
                Return
              </Button>
            </div>
          )}
        </div>
      </Card>
    );
  }
  return (
    <Card title="Decision">
      <div className="ctm-stack" style={{ gap: 10 }}>
        {notHeld ? (
          <>
            <div className="ct-muted">Nothing to release or reject: the payment is not held.</div>
            <div>
              <Button gate={decideGate} onClick={() => onDialog({ kind: 'close' })}>
                Close without action
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="ct-muted ctm-small">Release lets the held payment continue; reject stops it. A reason is mandatory and goes to the audit trail.</div>
            {fourEyes && (
              <div className="ct-banner ct-banner-warn ctm-small">
                <Icon name="shield" size={14} /> {c.priority === 'critical' ? 'Critical' : 'High'} priority: requires approval by a Compliance Manager.
              </div>
            )}
            <div className="ctm-row">
              <Button variant="primary" icon="check" gate={decideGate} onClick={() => onDialog({ kind: 'decide', decision: 'release' })}>
                {fourEyes ? 'Propose release' : 'Release'}
              </Button>
              <Button variant="danger" icon="x" gate={decideGate} onClick={() => onDialog({ kind: 'decide', decision: 'reject' })}>
                {fourEyes ? 'Propose reject' : 'Reject'}
              </Button>
            </div>
            {!decideGate.allowed && <div className="ct-muted ctm-small">{decideGate.reason}</div>}
          </>
        )}
      </div>
    </Card>
  );
}
