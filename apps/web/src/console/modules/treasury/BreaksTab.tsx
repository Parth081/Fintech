// Reconciliation break queue and the break drawer (assign, resolve with code + note).
import { useMemo, useState } from 'react';
import type { ReconBreak } from '@ct/contracts/browser';
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { isForbidden, useApi } from '../../ui/hooks';
import { formatMoney } from '../../lib/format';
import { providerName } from '../../../lib/format';
import { treasuryApi } from './data';
import { ageLabel, breakDifference, breakReasonText, filterBreaks, RESOLUTION_CODES, validateResolution, type BreakFilter, type ResolutionCode } from './lib/treasury';
import { Badge, Button, Card, DateTime, Drawer, EmptyState, ErrorState, KeyValueList, LoadingBlock, LoadingRows, Money, StatusBadge, Tabs, permGate, toastDone, toastError } from '../risk/kit';

type BreakList = { items: (ReconBreak & { eventId?: string })[]; total: number };

export default function BreaksTab({ now, breaks }: { now: number; breaks: { data: BreakList | null; loading: boolean; error: string | null; errorObj: unknown; refresh(): void } }) {
  const { user, can } = useSession();
  const route = useConsoleRoute();
  const filter = (['open', 'mine', 'resolved', 'all'] as const).includes(route.query.filter as BreakFilter) ? (route.query.filter as BreakFilter) : 'open';
  const [q, setQ] = useState('');
  const all = breaks.data?.items ?? [];
  const me = user?.id ?? '';
  const rows = useMemo(() => filterBreaks(all, filter, me, q), [all, filter, me, q]);
  const count = (f: BreakFilter) => filterBreaks(all, f, me).length;
  const selectedId = route.segments[0] === 'treasury' && route.segments[1] === 'breaks' ? route.segments[2] : undefined;

  return (
    <>
      <Tabs
        label="Break filters"
        tabs={[
          { id: 'open', label: 'Open', count: count('open') },
          { id: 'mine', label: 'Assigned to me', count: count('mine'), hidden: !can('recon.resolve') },
          { id: 'resolved', label: 'Resolved', count: count('resolved') },
          { id: 'all', label: 'All', count: all.length },
        ]}
        value={filter}
        onChange={(id) => route.setQuery({ filter: id === 'open' ? null : id })}
      />
      <Card flush>
        <div className="ct-toolbar">
          <input className="ct-input" type="search" placeholder="Search break, payment, provider, reason…" aria-label="Search breaks" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 300 }} />
          <span className="ct-muted ctm-small">
            {rows.length} break{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        {breaks.error && !breaks.data ? (
          <ErrorState error={breaks.error} onRetry={breaks.refresh} forbidden={isForbidden(breaks.errorObj)} />
        ) : (
          <div className="ct-table-wrap">
            <table className="ct-table ctm-table-dense">
              <thead>
                <tr>
                  <th>Break</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Provider</th>
                  <th>Reason</th>
                  <th className="ct-num">Expected</th>
                  <th className="ct-num">Reported</th>
                  <th className="ct-num">Difference</th>
                  <th>Assignee</th>
                  <th>Age</th>
                </tr>
              </thead>
              {breaks.loading ? (
                <LoadingRows cols={10} />
              ) : rows.length === 0 ? (
                <tbody>
                  <tr>
                    <td colSpan={10}>
                      <EmptyState title={filter === 'open' ? 'No open breaks — statements and ledger agree' : 'No breaks match'} />
                    </td>
                  </tr>
                </tbody>
              ) : (
                <tbody>
                  {rows.map((b) => {
                    const diff = breakDifference(b);
                    return (
                      <tr key={b.breakId} className="ct-row-link" onClick={() => route.navigate(links.break(b.breakId), { query: route.query })}>
                        <td className="ct-mono">{b.breakId}</td>
                        <td>
                          <StatusBadge kind="break" value={b.status} />
                        </td>
                        <td>
                          <a className="ctm-link ct-mono" href={links.payment(b.paymentId)} onClick={(e) => e.stopPropagation()}>
                            {b.paymentId}
                          </a>
                        </td>
                        <td>{providerName(b.providerId)}</td>
                        <td className="ctm-small">{b.breaks.length ? b.breaks.map(breakReasonText).join('; ') : '—'}</td>
                        <td className="ct-num">
                          <Money value={b.expected} />
                        </td>
                        <td className="ct-num">{b.reported ? <Money value={b.reported} /> : <span className="ct-muted">missing</span>}</td>
                        <td className="ct-num" style={diff ? { color: 'var(--ct-bad)' } : undefined}>
                          {diff === null ? '—' : formatMoney({ amountMinor: diff, currency: b.expected.currency })}
                        </td>
                        <td>{b.assignee ? b.assignee.name : <span className="ct-muted">Unassigned</span>}</td>
                        <td className="ctm-small">{b.status === 'resolved' ? '—' : ageLabel(b.detectedAt, now)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              )}
            </table>
          </div>
        )}
      </Card>
      {selectedId && (
        <BreakDrawer
          breakId={selectedId}
          onClose={() => route.navigate(links.breaks(route.query))}
          onChanged={breaks.refresh}
          now={now}
        />
      )}
    </>
  );
}

function BreakDrawer({ breakId, onClose, onChanged, now }: { breakId: string; onClose(): void; onChanged(): void; now: number }) {
  const { user, can } = useSession();
  const b = useApi((s) => treasuryApi.breakById(breakId, s), [breakId]);
  const [code, setCode] = useState<ResolutionCode | ''>('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const gate = permGate(can, 'recon.resolve');
  const v = b.data;
  const invalid = validateResolution(code, note);

  async function run(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await fn();
      b.refresh();
      onChanged();
      await toastDone(success, { type: 'break', id: breakId, paymentId: v?.paymentId }, can);
      return true;
    } catch (err) {
      toastError(err);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const diff = v ? breakDifference(v) : null;
  const help = RESOLUTION_CODES.find((r) => r.code === code)?.help;
  return (
    <Drawer title={`Break ${breakId}`} subtitle={v ? `${providerName(v.providerId)} · detected ${new Date(v.detectedAt).toLocaleString()}` : undefined} onClose={onClose}>
      {b.loading ? (
        <LoadingBlock lines={6} />
      ) : !v ? (
        <ErrorState error={b.error ?? 'Break not found'} onRetry={b.refresh} />
      ) : (
        <div className="ctm-stack">
          <div className="ctm-row">
            <StatusBadge kind="break" value={v.status} />
            {v.status !== 'resolved' && <Badge tone="neutral">open for {ageLabel(v.detectedAt, now)}</Badge>}
          </div>
          <Card title="Statement vs ledger">
            <KeyValueList
              items={[
                ['Payment', <a className="ctm-link ct-mono" href={links.payment(v.paymentId)}>{v.paymentId}</a>],
                ['Provider', providerName(v.providerId)],
                ['Expected (ledger)', <Money value={v.expected} />],
                ['Reported (statement)', v.reported ? <Money value={v.reported} /> : <span className="ct-muted">Not on the statement</span>],
                ['Difference', diff === null ? (v.reported ? 'Currency differs' : '—') : <span style={{ color: diff ? 'var(--ct-bad)' : undefined }}>{formatMoney({ amountMinor: diff, currency: v.expected.currency })}</span>],
                v.eventId ? ['Detected by event', <span className="ct-mono">{v.eventId}</span>] : null,
              ]}
            />
            {v.breaks.length > 0 && (
              <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>
                {v.breaks.map((r) => (
                  <li key={r}>
                    {breakReasonText(r)} <span className="ct-mono ct-muted">{r}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {v.status === 'resolved' && v.resolution ? (
            <Card title="Resolution">
              <KeyValueList
                items={[
                  ['Code', RESOLUTION_CODES.find((r) => r.code === v.resolution!.code)?.label ?? v.resolution.code],
                  ['Note', v.resolution.note],
                  ['Resolved by', v.resolution.by.name],
                  ['At', <DateTime iso={v.resolution.at} />],
                ]}
              />
            </Card>
          ) : (
            <>
              <Card title="Ownership">
                <div className="ctm-between">
                  <span>
                    <span className="ct-muted">Assignee </span>
                    <strong>{v.assignee ? v.assignee.name : 'Unassigned'}</strong>
                  </span>
                  <div className="ctm-row">
                    {v.assignee?.userId !== user?.id && (
                      <Button size="sm" variant="primary" gate={gate} busy={busy === 'assign'} onClick={() => user && void run('assign', () => treasuryApi.assign(breakId, user.id), 'Break assigned to you')}>
                        Assign to me
                      </Button>
                    )}
                    {v.assignee && (
                      <Button size="sm" gate={gate} busy={busy === 'unassign'} onClick={() => void run('unassign', () => treasuryApi.assign(breakId, null), 'Break unassigned')}>
                        Unassign
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
              <Card title="Resolve">
                <div className="ctm-stack" style={{ gap: 10 }}>
                  <label className="ct-field">
                    <span className="ct-label">Resolution code</span>
                    <select className="ct-select" value={code} disabled={!gate.allowed} onChange={(e) => setCode(e.target.value as ResolutionCode | '')} title={gate.reason}>
                      <option value="">Choose…</option>
                      {RESOLUTION_CODES.map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.label} ({r.code})
                        </option>
                      ))}
                    </select>
                    {help && <span className="ct-muted ctm-small">{help}</span>}
                  </label>
                  <label className="ct-field">
                    <span className="ct-label">Note (required)</span>
                    <textarea className="ct-textarea" value={note} disabled={!gate.allowed} placeholder={gate.allowed ? 'What did you find, and what was done?' : gate.reason} onChange={(e) => setNote(e.target.value)} onBlur={() => setTouched(true)} />
                  </label>
                  {touched && invalid && <span className="ctm-error-text">{invalid}</span>}
                  {confirming ? (
                    <div className="ct-banner ct-banner-warn">
                      <div className="ctm-between">
                        <span>Resolve {breakId} as {RESOLUTION_CODES.find((r) => r.code === code)?.label}? The break leaves the open queue.</span>
                        <span className="ctm-row">
                          <Button size="sm" onClick={() => setConfirming(false)}>
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            busy={busy === 'resolve'}
                            onClick={() =>
                              void run('resolve', () => treasuryApi.resolve(breakId, code as ResolutionCode, note.trim()), `Break ${breakId} resolved`).then((ok) => {
                                setConfirming(false);
                                if (ok) {
                                  setNote('');
                                  setCode('');
                                }
                              })
                            }
                          >
                            Confirm
                          </Button>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="ctm-row" style={{ justifyContent: 'flex-end' }}>
                      <Button
                        variant="primary"
                        icon="check"
                        gate={gate}
                        onClick={() => {
                          setTouched(true);
                          if (!invalid) setConfirming(true);
                        }}
                      >
                        Resolve break
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
