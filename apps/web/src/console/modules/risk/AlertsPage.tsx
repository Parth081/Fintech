// Alerts queue: every sanctions / fraud / AML alert, worst and oldest first, with live SLA countdowns.
// Dense table; filters by kind, severity, status and free text; bulk "assign to me" of the underlying cases.
import { useMemo, useState } from 'react';
import type { AlertKind, AlertView, Severity } from '@ct/contracts/browser';
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { useApi, useDebounced, useNow } from '../../ui/hooks';
import { Icon } from '../../ui/Icon';
import { formatPercent } from '../../lib/format';
import { riskApi, type CaseRow } from './data';
import {
  ALERT_KINDS,
  alertQueryParams,
  alertSla,
  bulkAssignTargets,
  caseSla,
  countBy,
  KIND_LABEL,
  SEVERITIES,
  sortAlerts,
  type AlertFilter,
  type AlertStatusFilter,
} from './lib/queue';
import { Badge, Button, Card, DateTime, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge, permGate, toastDone, toastError } from './kit';
import { isForbidden } from '../../ui/hooks';

const csv = <T extends string>(v: string | undefined, allowed: readonly T[]): T[] => (v ? v.split(',').filter((x): x is T => (allowed as readonly string[]).includes(x)) : []);

export default function AlertsPage() {
  const { user, can } = useSession();
  const route = useConsoleRoute();
  const now = useNow(1000);
  const filter: AlertFilter = {
    kinds: csv<AlertKind>(route.query.kind, ALERT_KINDS),
    severities: csv<Severity>(route.query.severity, SEVERITIES),
    status: (['open', 'closed', 'all'] as const).includes(route.query.status as AlertStatusFilter) ? (route.query.status as AlertStatusFilter) : 'open',
    q: route.query.q ?? '',
  };
  const [search, setSearch] = useState(filter.q);
  const q = useDebounced(search, 300);
  const effective = { ...filter, q };
  const params = alertQueryParams(effective, 500);

  const alerts = useApi((s) => riskApi.alerts(params, s), [params], { intervalMs: 10_000 });
  // Unfiltered counts for the severity chips (same status + kind scope, no severity filter).
  const scope = useApi((s) => riskApi.alerts(alertQueryParams({ ...effective, severities: [] }, 1000), s), [effective.status, effective.kinds, q], { intervalMs: 15_000 });
  const cases = useApi((s) => riskApi.cases({ limit: 1000 }, s), [], { intervalMs: 10_000 });

  const caseById = useMemo(() => new Map<string, CaseRow>((cases.data?.items ?? []).map((c) => [c.caseId, c])), [cases.data]);
  const rows = useMemo(() => sortAlerts(alerts.data?.items ?? []), [alerts.data]);
  const sevCounts = useMemo(() => countBy(scope.data?.items ?? [], (a) => a.severity), [scope.data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedAlerts = rows.filter((a) => selected.has(a.alertId));
  const targets = user ? bulkAssignTargets(selectedAlerts, caseById, user.id) : [];
  const [busy, setBusy] = useState(false);

  const setFilter = (patch: Partial<Record<'kind' | 'severity' | 'status' | 'q', string | null>>) => route.setQuery(patch);
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const assignGate = !can('cases.work') ? permGate(can, 'cases.work') : targets.length === 0 ? { allowed: false, reason: selected.size ? 'The selected alerts’ cases are closed or already yours' : 'Select alerts first' } : { allowed: true };

  async function assignToMe() {
    if (!user) return;
    setBusy(true);
    const ok: string[] = [];
    const failed: string[] = [];
    for (const caseId of targets) {
      try {
        await riskApi.assign(caseId, user.id);
        ok.push(caseId);
      } catch (err) {
        failed.push(`${caseId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    setSelected(new Set());
    cases.refresh();
    alerts.refresh();
    if (ok.length) {
      await toastDone(`Assigned ${ok.length} case${ok.length === 1 ? '' : 's'} to you`, { type: 'case', id: ok[ok.length - 1]!, paymentId: caseById.get(ok[ok.length - 1]!)?.paymentId }, can, ok.join(', '));
    }
    if (failed.length) toastError(new Error(failed.join('; ')), `${failed.length} assignment${failed.length === 1 ? '' : 's'} failed`);
  }

  const allChecked = rows.length > 0 && rows.every((a) => selected.has(a.alertId));
  const open = (a: AlertView) => route.navigate(a.caseId ? links.case(a.caseId) : links.payment(a.paymentId));

  return (
    <div className="ct-page">
      <PageHeader
        breadcrumb={[{ label: 'Risk & Compliance' }, { label: 'Alerts' }]}
        title="Alerts"
        subtitle="Sanctions, fraud and AML alerts raised by screening and risk scoring. Alerts on the same payment roll up into one case."
        actions={
          <>
            <Button icon="cases" onClick={() => route.navigate(links.cases())}>
              Cases
            </Button>
            <Button icon="refresh" onClick={() => (alerts.refresh(), cases.refresh())} busy={alerts.fetching && !alerts.loading}>
              Refresh
            </Button>
          </>
        }
      />
      <Card flush>
        <div className="ct-toolbar">
          <div className="ctm-row" role="group" aria-label="Severity">
            {SEVERITIES.map((s) => (
              <button key={s} type="button" className="ctm-chip" aria-pressed={filter.severities.includes(s)} onClick={() => setFilter({ severity: toggle(filter.severities, s).join(',') || null })}>
                <StatusBadge kind="severity" value={s} />
                <span className="ctm-chip-count">{sevCounts[s] ?? 0}</span>
              </button>
            ))}
          </div>
          <span className="ctm-sep" />
          <div className="ctm-row" role="group" aria-label="Kind">
            {ALERT_KINDS.map((k) => (
              <button key={k} type="button" className="ctm-chip" aria-pressed={filter.kinds.includes(k)} onClick={() => setFilter({ kind: toggle(filter.kinds, k).join(',') || null })}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <span className="ctm-sep" />
          <select className="ct-select" aria-label="Status" value={filter.status} onChange={(e) => setFilter({ status: e.target.value === 'open' ? null : e.target.value })}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All statuses</option>
          </select>
          <div className="ctm-row ctm-grow" style={{ justifyContent: 'flex-end' }}>
            <input
              className="ct-input"
              type="search"
              placeholder="Search alert, payment, case, party, rule…"
              aria-label="Search alerts"
              value={search}
              style={{ minWidth: 280 }}
              onChange={(e) => {
                setSearch(e.target.value);
                setFilter({ q: e.target.value || null });
              }}
            />
          </div>
        </div>
        <div className="ct-toolbar" style={{ justifyContent: 'space-between' }}>
          <span className="ct-muted ctm-small">
            {alerts.data ? `${alerts.data.total} alert${alerts.data.total === 1 ? '' : 's'}` : 'Loading…'}
            {selected.size > 0 && ` · ${selected.size} selected`}
          </span>
          <div className="ctm-row">
            {selected.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            )}
            <Button size="sm" variant="primary" icon="users" gate={assignGate} busy={busy} onClick={() => void assignToMe()}>
              Assign to me{targets.length ? ` (${targets.length} case${targets.length === 1 ? '' : 's'})` : ''}
            </Button>
          </div>
        </div>
        {alerts.error && !alerts.data ? (
          <ErrorState error={alerts.error} onRetry={alerts.refresh} forbidden={isForbidden(alerts.errorObj)} />
        ) : (
          <div className="ct-table-wrap">
            <table className="ct-table ctm-table-dense ctm-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      className="ctm-check"
                      aria-label="Select all"
                      checked={allChecked}
                      onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((a) => a.alertId)))}
                    />
                  </th>
                  <th>Severity</th>
                  <th>Kind</th>
                  <th>Alert</th>
                  <th>Payment</th>
                  <th className="ct-num">Amount</th>
                  <th>Parties</th>
                  <th>Case</th>
                  <th>SLA</th>
                  <th>Raised</th>
                </tr>
              </thead>
              {alerts.loading ? (
                <LoadingRows cols={10} />
              ) : rows.length === 0 ? (
                <tbody>
                  <tr>
                    <td colSpan={10}>
                      <EmptyState title="No alerts match these filters" hint={filter.status === 'open' ? 'The queue is clear. Try “All statuses” to see closed alerts.' : 'Try removing a filter.'} />
                    </td>
                  </tr>
                </tbody>
              ) : (
                <tbody>
                  {rows.map((a) => {
                    const c = a.caseId ? caseById.get(a.caseId) : undefined;
                    const sla = c ? caseSla(c, now) : alertSla(a, now);
                    const checked = selected.has(a.alertId);
                    return (
                      <tr key={a.alertId} className={`ct-row-link${checked ? ' ctm-selected' : ''}`} onClick={() => open(a)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="ctm-check"
                            aria-label={`Select ${a.alertId}`}
                            checked={checked}
                            onChange={() =>
                              setSelected((cur) => {
                                const n = new Set(cur);
                                if (n.has(a.alertId)) n.delete(a.alertId);
                                else n.add(a.alertId);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td>
                          <StatusBadge kind="severity" value={a.severity} />
                        </td>
                        <td>{KIND_LABEL[a.kind]}</td>
                        <td>
                          <div className="ctm-strong ctm-ellipsis" title={a.summary}>
                            {a.summary}
                          </div>
                          <div className="ct-muted ctm-small">
                            <span className="ct-mono">{a.rule}</span>
                            {a.score !== undefined && ` · score ${formatPercent(a.score > 1 ? a.score / 100 : a.score, 0)}`}
                          </div>
                        </td>
                        <td>
                          <a className="ctm-link ct-mono" href={links.payment(a.paymentId)} onClick={(e) => e.stopPropagation()}>
                            {a.paymentId}
                          </a>
                          <div className="ct-muted ctm-small">
                            {a.payment.corridor} · <StatusBadge kind="payment" value={a.payment.status} />
                          </div>
                        </td>
                        <td className="ct-num">
                          <Money value={a.payment.amount} />
                        </td>
                        <td className="ctm-small">
                          <div className="ctm-ellipsis" style={{ maxWidth: 200 }} title={`${a.payment.debtorName} → ${a.payment.creditorName}`}>
                            {a.payment.debtorName}
                          </div>
                          <div className="ct-muted ctm-ellipsis" style={{ maxWidth: 200 }}>
                            → {a.payment.creditorName}
                          </div>
                        </td>
                        <td>
                          {a.caseId ? (
                            <>
                              <span className="ct-mono">{a.caseId}</span>
                              <div className="ctm-row ctm-small" style={{ gap: 4 }}>
                                {c && <StatusBadge kind="case" value={c.status} />}
                                <span className="ct-muted">{c?.assignee ? c.assignee.name : 'Unassigned'}</span>
                              </div>
                            </>
                          ) : (
                            <span className="ct-muted">—</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={sla.tone}>
                            <Icon name="clock" size={12} />
                            {sla.label}
                          </Badge>
                        </td>
                        <td className="ctm-small">
                          <DateTime iso={a.raisedAt} now={now} relative />
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
