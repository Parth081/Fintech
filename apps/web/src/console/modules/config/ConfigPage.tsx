// Routing & Providers: the effective configuration as readable cards with live provider health beside the
// controls. Editing never changes anything directly: it opens a change request that a different approver
// must accept (maker-checker); the approved value is published on the log as control.config.updated.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_CONFIG, PROVIDERS, type BreakerView, type ChangeRequest, type ConfigKey, type ConfigValues, type ControlView } from '@ct/contracts/browser';
import { useSession } from '../../session';
import { links, useConsoleRoute } from '../../route';
import { isForbidden, useApi, useNow } from '../../ui/hooks';
import { formatNumber, formatPercent, formatRelative } from '../../lib/format';
import { configApi, type EffectiveConfig } from './data';
import { FAILURE_SPAN, KEY_INFO, pendingFor, previewRouting, providerProposals, validateProposal, weightPercents, type Weights } from './lib/config';
import { DiffTable } from './DiffTable';
import { Badge, Button, Card, ErrorState, KeyValueList, LoadingBlock, PageHeader, ReasonDialog, permGate, latestAuditRef, toast, type Gate, type Tone } from '../risk/kit';

type Proposal = { key: ConfigKey; value: unknown }[];

export default function ConfigPage() {
  const { can } = useSession();
  const route = useConsoleRoute();
  const now = useNow(5000);
  const config = useApi((s) => configApi.config(s), [], { intervalMs: 10_000 });
  const pending = useApi((s) => configApi.changes({ status: 'pending' }, s), [], { intervalMs: 10_000 });
  const control = useApi((s) => configApi.control(s), [], { intervalMs: 5_000 });
  const [proposal, setProposal] = useState<{ title: string; changes: Proposal; onDone(): void } | null>(null);

  const values = config.data?.values;
  const pendingList = pending.data?.items ?? [];

  const editGate = (key: ConfigKey): Gate => {
    if (!can('config.request')) return permGate(can, 'config.request');
    const p = pendingFor(pendingList, key)[0];
    return p ? { allowed: false, reason: `${p.id} for this setting is pending review` } : { allowed: true };
  };
  const pendingBanner = (key: ConfigKey) => {
    const p = pendingFor(pendingList, key)[0];
    return p ? (
      <div className="ct-banner ct-banner-warn ctm-small">
        Change request <a className="ctm-link" href={links.change(p.id)}>{p.id}</a> by {p.requestedBy.name} is waiting for approval.
      </div>
    ) : null;
  };

  async function submit(changes: Proposal, reason: string) {
    const created: ChangeRequest[] = [];
    for (const c of changes) created.push(await configApi.propose(c.key, c.value, reason));
    pending.refresh();
    const last = created[created.length - 1]!;
    const ref = await latestAuditRef({ type: 'config', id: last.id }, can);
    toast({
      tone: 'ok',
      title: `Change request${created.length > 1 ? 's' : ''} ${created.map((c) => c.id).join(', ')} submitted`,
      detail: ['A different approver must review it before it takes effect', ref].filter(Boolean).join(' · '),
      href: links.change(last.id),
      hrefLabel: 'Open change request',
    });
  }

  return (
    <div className="ct-page">
      <PageHeader
        breadcrumb={[{ label: 'Platform' }, { label: 'Routing & providers' }]}
        title="Routing & providers"
        subtitle="Effective configuration of the payment pipeline. Every edit becomes a change request; a different approver must accept it (maker-checker)."
        actions={
          <Button icon="changes" onClick={() => route.navigate(links.changes())}>
            Change requests{pendingList.length ? ` (${pendingList.length} pending)` : ''}
          </Button>
        }
      />
      {config.error && !values ? (
        <Card>
          <ErrorState error={config.error} onRetry={config.refresh} forbidden={isForbidden(config.errorObj)} />
        </Card>
      ) : !values ? (
        <div className="ct-split">
          <Card>
            <LoadingBlock lines={8} />
          </Card>
          <Card>
            <LoadingBlock lines={5} />
          </Card>
        </div>
      ) : (
        <div className="ct-split">
          <div className="ctm-stack">
            <ProvidersCard values={values} versions={config.data!.versions} control={control.data} gate={[editGate('provider.enabled'), editGate('provider.forcedBreaker')]} banner={<>{pendingBanner('provider.enabled')}{pendingBanner('provider.forcedBreaker')}</>} onPropose={(changes, done) => setProposal({ title: 'Provider availability change', changes, onDone: done })} />
            <WeightsCard values={values} version={config.data!.versions['routing.weights']} gate={editGate('routing.weights')} banner={pendingBanner('routing.weights')} onPropose={(changes, done) => setProposal({ title: 'Routing weights change', changes, onDone: done })} />
            <div className="ct-grid ct-grid-2">
              <ThresholdsCard values={values} version={config.data!.versions['risk.thresholds']} gate={editGate('risk.thresholds')} banner={pendingBanner('risk.thresholds')} onPropose={(changes, done) => setProposal({ title: 'Risk thresholds change', changes, onDone: done })} />
              <ManualReviewCard values={values} version={config.data!.versions['risk.manualReviewAboveUsd']} gate={editGate('risk.manualReviewAboveUsd')} banner={pendingBanner('risk.manualReviewAboveUsd')} onPropose={(changes, done) => setProposal({ title: 'Manual review limit change', changes, onDone: done })} />
            </div>
          </div>
          <div className="ctm-stack">
            <LiveHealthCard control={control.data} error={control.error} now={now} />
            <Card title="Pending change requests" actions={<a className="ctm-link ctm-small" href={links.changes()}>All →</a>}>
              {pendingList.length === 0 ? (
                <div className="ct-muted">Nothing waiting for review.</div>
              ) : (
                <div className="ctm-stack" style={{ gap: 8 }}>
                  {pendingList.map((c) => (
                    <a key={c.id} href={links.change(c.id)} className="ctm-note" style={{ textDecoration: 'none', color: 'inherit' }}>
                      <div className="ctm-note-head">
                        <span className="ct-mono">{c.id}</span>
                        <span>{formatRelative(c.requestedAt, now)}</span>
                      </div>
                      <div className="ctm-strong">{KEY_INFO[c.key]?.title ?? c.key}</div>
                      <div className="ct-muted ctm-small">by {c.requestedBy.name}</div>
                    </a>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
      {proposal && values && (
        <ReasonDialog
          title={`Submit change request — ${proposal.title}`}
          description="Nothing changes until a different user with config.approve approves it. The reason is recorded in the audit trail."
          confirmLabel={proposal.changes.length > 1 ? `Submit ${proposal.changes.length} change requests` : 'Submit change request'}
          placeholder="Why is this change needed? (e.g. incident reference, partner notice)"
          onConfirm={async (reason) => {
            await submit(proposal.changes, reason);
            proposal.onDone();
          }}
          onClose={() => setProposal(null)}
        >
          {proposal.changes.map((c) => (
            <div key={c.key}>
              <div className="ctm-section-title">{KEY_INFO[c.key].title}</div>
              <DiffTable configKey={c.key} before={values[c.key]} after={c.value} />
            </div>
          ))}
        </ReasonDialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- shared

function useDraft<T>(current: T, editing: boolean): [T, (v: T) => void] {
  const [draft, setDraft] = useState<T>(current);
  const key = JSON.stringify(current);
  useEffect(() => {
    if (!editing) setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, editing]);
  return [draft, setDraft];
}

function EditFooter({ editing, gate, error, dirty, onEdit, onCancel, onSubmit, hint }: { editing: boolean; gate: Gate; error: string | null; dirty: boolean; onEdit(): void; onCancel(): void; onSubmit(): void; hint?: ReactNode }) {
  if (!editing)
    return (
      <Button size="sm" icon="changes" gate={gate} onClick={onEdit}>
        Propose change
      </Button>
    );
  return (
    <div className="ctm-row">
      {hint}
      <Button size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" disabled={!dirty || !!error} title={error ?? undefined} onClick={onSubmit}>
        Review & submit…
      </Button>
    </div>
  );
}

const versionLabel = (v: number | undefined) => (v ? `version ${v}` : 'default');

// ---------------------------------------------------------------------------------------------- providers

function breakerTone(b: BreakerView | undefined): Tone {
  return !b ? 'neutral' : b.state === 'open' ? 'bad' : b.state === 'half-open' ? 'warn' : 'ok';
}

function ProvidersCard({ values, versions, control, gate, banner, onPropose }: { values: ConfigValues; versions: EffectiveConfig['versions']; control: ControlView | null; gate: [Gate, Gate]; banner: ReactNode; onPropose(c: Proposal, done: () => void): void }) {
  const [editing, setEditing] = useState(false);
  const current = { 'provider.enabled': values['provider.enabled'], 'provider.forcedBreaker': values['provider.forcedBreaker'] };
  const [draft, setDraft] = useDraft(current, editing);
  const { changes, errors } = providerProposals(current, draft);
  const ids = [...new Set([...PROVIDERS.map((p) => p.id), ...Object.keys(values['provider.enabled'])])];
  const combinedGate: Gate = !gate[0].allowed ? gate[0] : !gate[1].allowed ? gate[1] : gate[0];
  return (
    <Card
      title="Providers"
      subtitle={`Availability ${versionLabel(versions['provider.enabled'])} · forced breakers ${versionLabel(versions['provider.forcedBreaker'])}`}
      actions={<EditFooter editing={editing} gate={combinedGate} error={errors[0] ?? null} dirty={changes.length > 0} onEdit={() => setEditing(true)} onCancel={() => setEditing(false)} onSubmit={() => onPropose(changes, () => setEditing(false))} />}
      flush
    >
      {banner && <div style={{ padding: '12px 16px 0' }}>{banner}</div>}
      <div className="ct-table-wrap">
        <table className="ct-table ctm-table-dense">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Corridors</th>
              <th>Live breaker</th>
              <th>Routing</th>
              <th>Breaker override</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const meta = PROVIDERS.find((p) => p.id === id);
              const b = control?.breakers.find((x) => x.providerId === id);
              const outage = control?.control.outages[id];
              const enabled = draft['provider.enabled'][id] !== false;
              const forced = draft['provider.forcedBreaker'][id] === 'open';
              const changedEn = enabled !== (values['provider.enabled'][id] !== false);
              const changedFo = forced !== (values['provider.forcedBreaker'][id] === 'open');
              return (
                <tr key={id}>
                  <td>
                    <div className="ctm-strong">{meta?.name ?? id}</div>
                    <div className="ct-muted ctm-small ct-mono">{id}</div>
                  </td>
                  <td className="ctm-small">{meta?.corridors.join(', ') ?? '—'}</td>
                  <td>
                    <Badge tone={breakerTone(b)} dot title={b?.reason}>
                      {b ? b.state : 'unknown'}
                    </Badge>
                    {b && b.attempts > 0 && <div className="ct-muted ctm-small">{formatPercent(b.failureRate, 0)} failures · {b.attempts} tries</div>}
                    {outage && (
                      <div className="ctm-small" style={{ color: 'var(--ct-bad)' }}>
                        outage: {outage.mode}
                      </div>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <label className="ctm-row ctm-small" style={{ gap: 6 }}>
                        <input type="checkbox" className="ctm-check" checked={enabled} onChange={(e) => setDraft({ ...draft, 'provider.enabled': { ...draft['provider.enabled'], [id]: e.target.checked } })} />
                        <span className={changedEn ? 'ctm-diff-after' : ''}>{enabled ? 'Enabled' : 'Disabled'}</span>
                      </label>
                    ) : (
                      <Badge tone={enabled ? 'ok' : 'bad'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <select
                        className="ct-select"
                        value={forced ? 'open' : 'auto'}
                        aria-label={`Breaker override for ${id}`}
                        onChange={(e) => setDraft({ ...draft, 'provider.forcedBreaker': { ...draft['provider.forcedBreaker'], [id]: e.target.value === 'open' ? 'open' : null } })}
                        style={changedFo ? { borderColor: 'var(--ct-ok)' } : undefined}
                      >
                        <option value="auto">Automatic</option>
                        <option value="open">Forced open</option>
                      </select>
                    ) : (
                      <Badge tone={forced ? 'warn' : 'neutral'}>{forced ? 'Forced open' : 'Automatic'}</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && errors.length > 0 && (
        <div style={{ padding: '0 16px 12px' }}>
          {errors.map((e) => (
            <div key={e} className="ctm-error-text">
              {e}
            </div>
          ))}
        </div>
      )}
      <div className="ct-muted ctm-small" style={{ padding: '8px 16px 12px' }}>
        {KEY_INFO['provider.enabled'].help} {KEY_INFO['provider.forcedBreaker'].help}
      </div>
    </Card>
  );
}

function LiveHealthCard({ control, error, now }: { control: ControlView | null; error: string | null; now: number }) {
  return (
    <Card title="Live provider health" subtitle="Circuit breakers from the event log · refreshes every 5 s">
      {!control ? (
        error ? <ErrorState error={error} /> : <LoadingBlock lines={3} />
      ) : (
        <div className="ctm-stack" style={{ gap: 10 }}>
          {control.breakers.length === 0 && <div className="ct-muted">No breaker data yet.</div>}
          {control.breakers.map((b) => {
            const outage = control.control.outages[b.providerId];
            return (
              <div key={b.providerId} className="ctm-note">
                <div className="ctm-between">
                  <span className="ctm-strong">{PROVIDERS.find((p) => p.id === b.providerId)?.name ?? b.providerId}</span>
                  <Badge tone={breakerTone(b)} dot>
                    {b.state}
                  </Badge>
                </div>
                <div className="ct-muted ctm-small">
                  {b.reason}
                  {b.since && ` · since ${formatRelative(b.since, now)}`}
                </div>
                <div className="ctm-meter" style={{ marginTop: 6 }} title={`Failure rate ${formatPercent(b.failureRate)}`}>
                  <span style={{ width: `${Math.round(b.failureRate * 100)}%`, background: b.failureRate > 0.5 ? 'var(--ct-bad)' : b.failureRate > 0.2 ? 'var(--ct-warn)' : 'var(--ct-ok)' }} />
                </div>
                {outage && (
                  <div className="ctm-small" style={{ color: 'var(--ct-bad)', marginTop: 4 }}>
                    Simulated outage ({outage.mode}) since {formatRelative(outage.since, now)}: {outage.reason}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------- routing weights

function WeightsCard({ values, version, gate, banner, onPropose }: { values: ConfigValues; version: number | undefined; gate: Gate; banner: ReactNode; onPropose(c: Proposal, done: () => void): void }) {
  const current = values['routing.weights'];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useDraft<Weights>(current, editing);
  const [preview, setPreview] = useState(false);
  const samples = useApi((s) => configApi.routingSamples(24, s), [], { enabled: preview });
  const error = editing ? validateProposal('routing.weights', draft, current, values) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const pct = weightPercents(editing ? draft : current);
  const opts = useMemo(
    () => ({
      disabled: new Set(Object.entries(values['provider.enabled']).filter(([, v]) => v === false).map(([k]) => k)),
      forcedOpen: new Set(Object.entries(values['provider.forcedBreaker']).filter(([, v]) => v === 'open').map(([k]) => k)),
    }),
    [values],
  );
  const result = samples.data ? previewRouting(samples.data, editing ? draft : current, opts) : null;
  const providersInPreview = result ? [...new Set([...Object.keys(result.shareBefore), ...Object.keys(result.shareAfter)])].sort() : [];
  const dims: { k: keyof Weights; label: string; help: string }[] = [
    { k: 'success', label: 'Success rate', help: 'prefer providers that fail least' },
    { k: 'cost', label: 'Cost', help: 'prefer the cheapest fee' },
    { k: 'speed', label: 'Speed', help: 'prefer the fastest expected payout' },
  ];
  return (
    <Card
      title="Routing weights"
      subtitle={`${KEY_INFO['routing.weights'].help} · ${versionLabel(version)}`}
      actions={<EditFooter editing={editing} gate={gate} error={error} dirty={dirty} onEdit={() => setEditing(true)} onCancel={() => setEditing(false)} onSubmit={() => onPropose([{ key: 'routing.weights', value: draft }], () => setEditing(false))} />}
    >
      <div className="ctm-stack">
        {banner}
        <div className="ct-grid ct-grid-3">
          {dims.map((d) => (
            <label key={d.k} className="ct-field">
              <span className="ctm-between">
                <span className="ct-label">{d.label}</span>
                <span className="ct-num ctm-strong">
                  {(editing ? draft : current)[d.k].toFixed(2)} <span className="ct-muted ctm-small">({pct[d.k]}%)</span>
                </span>
              </span>
              <input type="range" className="ctm-slider" min={0} max={1} step={0.05} disabled={!editing} value={(editing ? draft : current)[d.k]} onChange={(e) => setDraft({ ...draft, [d.k]: Number(e.target.value) })} aria-label={`${d.label} weight`} />
              <span className="ct-muted ctm-small">
                {d.help}
                {editing && draft[d.k] !== current[d.k] && <span className="ctm-diff-after"> (was {current[d.k].toFixed(2)})</span>}
              </span>
            </label>
          ))}
        </div>
        {error && <div className="ctm-error-text">{error}</div>}
        <details>
          <summary className="ctm-small ctm-link" style={{ cursor: 'pointer' }}>
            How the router scores providers
          </summary>
          <div className="ctm-formula" style={{ marginTop: 8 }}>
            {`score = (w_success·success + w_cost·cost + w_speed·speed) / (w_success + w_cost + w_speed)
success = 1 − (failure rate − best failure rate) / ${FAILURE_SPAN.toFixed(2)}   (clamped 0..1)
cost    = cheapest fee / this provider's fee
speed   = fastest expected latency / this provider's latency
The highest score among eligible providers wins (ties: lower fee, then higher success rate).`}
          </div>
        </details>
        <div>
          <div className="ctm-between">
            <div className="ctm-section-title" style={{ margin: 0 }}>
              Effect on recent payments
            </div>
            {!preview ? (
              <Button size="sm" icon="play" onClick={() => setPreview(true)}>
                Re-score recent payments
              </Button>
            ) : (
              <Button size="sm" icon="refresh" onClick={samples.refresh} busy={samples.fetching}>
                Reload sample
              </Button>
            )}
          </div>
          {preview && (
            <div style={{ marginTop: 8 }}>
              {samples.loading ? (
                <LoadingBlock lines={3} />
              ) : samples.error ? (
                <ErrorState error={samples.error} onRetry={samples.refresh} />
              ) : !result || result.rows.length === 0 ? (
                <div className="ct-muted">No recent payments recorded their routing scores yet.</div>
              ) : (
                <div className="ctm-stack" style={{ gap: 10 }}>
                  <div>
                    Re-scoring the recorded decisions of <strong>{result.rows.length}</strong> recent payments {editing && dirty ? 'with the proposed weights' : 'with the current weights'}:{' '}
                    <strong style={{ color: result.changed ? 'var(--ct-warn)' : 'var(--ct-ok)' }}>{result.changed}</strong> would route to a different provider
                    {result.unroutable > 0 && <span style={{ color: 'var(--ct-bad)' }}> · {result.unroutable} with no eligible provider</span>}.
                  </div>
                  <table className="ct-table ctm-table-dense">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th className="ct-num">Share as routed</th>
                        <th className="ct-num">Share under {editing && dirty ? 'proposal' : 'current weights'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providersInPreview.map((p) => {
                        const a = result.shareBefore[p] ?? 0;
                        const b = result.shareAfter[p] ?? 0;
                        return (
                          <tr key={p}>
                            <td>{p === 'none' ? 'No eligible provider' : (PROVIDERS.find((x) => x.id === p)?.name ?? p)}</td>
                            <td className="ct-num">{formatPercent(a, 0)}</td>
                            <td className="ct-num" style={{ color: b > a ? 'var(--ct-ok)' : b < a ? 'var(--ct-bad)' : undefined }}>
                              {formatPercent(b, 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {result.changed > 0 && (
                    <details>
                      <summary className="ctm-small ctm-link" style={{ cursor: 'pointer' }}>
                        {result.changed} payment{result.changed === 1 ? '' : 's'} that would move
                      </summary>
                      <KeyValueList
                        items={result.rows
                          .filter((r) => r.changed)
                          .slice(0, 12)
                          .map((r) => [r.paymentId, `${r.corridor}: ${r.before} → ${r.after ?? 'none'}${r.margin !== null ? ` (margin ${r.margin.toFixed(3)})` : ''}`] as const)}
                      />
                    </details>
                  )}
                  <div className="ct-muted ctm-small">Uses each payment’s recorded fees, success rates and latencies; breakers at the time of routing are kept, providers disabled or forced open now are excluded.</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------- risk

function ThresholdsCard({ values, version, gate, banner, onPropose }: { values: ConfigValues; version: number | undefined; gate: Gate; banner: ReactNode; onPropose(c: Proposal, done: () => void): void }) {
  const current = values['risk.thresholds'];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useDraft(current, editing);
  const v = editing ? draft : current;
  const error = editing ? validateProposal('risk.thresholds', draft, current, values) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const W = 300;
  return (
    <Card
      title="Risk decision thresholds"
      subtitle={versionLabel(version)}
      actions={<EditFooter editing={editing} gate={gate} error={error} dirty={dirty} onEdit={() => setEditing(true)} onCancel={() => setEditing(false)} onSubmit={() => onPropose([{ key: 'risk.thresholds', value: draft }], () => setEditing(false))} />}
    >
      <div className="ctm-stack" style={{ gap: 10 }}>
        {banner}
        <div className="ct-muted ctm-small">{KEY_INFO['risk.thresholds'].help}</div>
        <svg className="ctm-svg" viewBox={`0 0 ${W} 34`} width="100%" role="img" aria-label="Score bands">
          <rect x="0" y="6" width={W * v.hold} height="12" fill="var(--ct-ok-soft)" />
          <rect x={W * v.hold} y="6" width={Math.max(0, W * (v.reject - v.hold))} height="12" fill="var(--ct-warn-soft)" />
          <rect x={W * v.reject} y="6" width={Math.max(0, W * (1 - v.reject))} height="12" fill="var(--ct-bad-soft)" />
          <text x="4" y="31" fontSize="10" fill="var(--ct-ok)">approve</text>
          <text x={W * v.hold + 3} y="31" fontSize="10" fill="var(--ct-warn)">hold</text>
          <text x={Math.min(W - 30, W * v.reject + 3)} y="31" fontSize="10" fill="var(--ct-bad)">reject</text>
        </svg>
        {(['hold', 'reject'] as const).map((k) => (
          <label key={k} className="ct-field">
            <span className="ctm-between">
              <span className="ct-label">{k === 'hold' ? 'Hold for review at or above' : 'Reject at or above'}</span>
              <span className="ct-num ctm-strong">
                {v[k].toFixed(2)}
                {editing && draft[k] !== current[k] && <span className="ctm-diff-after ctm-small"> (was {current[k].toFixed(2)})</span>}
              </span>
            </span>
            <input type="range" className="ctm-slider" min={0.05} max={1} step={0.01} disabled={!editing} value={v[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} aria-label={k} />
          </label>
        ))}
        {error && <div className="ctm-error-text">{error}</div>}
      </div>
    </Card>
  );
}

function ManualReviewCard({ values, version, gate, banner, onPropose }: { values: ConfigValues; version: number | undefined; gate: Gate; banner: ReactNode; onPropose(c: Proposal, done: () => void): void }) {
  const current = values['risk.manualReviewAboveUsd'];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useDraft<number>(current, editing);
  const error = editing ? validateProposal('risk.manualReviewAboveUsd', draft, current, values) : null;
  return (
    <Card
      title="Manual review limit"
      subtitle={versionLabel(version)}
      actions={<EditFooter editing={editing} gate={gate} error={error} dirty={draft !== current} onEdit={() => setEditing(true)} onCancel={() => setEditing(false)} onSubmit={() => onPropose([{ key: 'risk.manualReviewAboveUsd', value: draft }], () => setEditing(false))} />}
    >
      <div className="ctm-stack" style={{ gap: 10 }}>
        {banner}
        <div className="ct-muted ctm-small">{KEY_INFO['risk.manualReviewAboveUsd'].help}</div>
        {editing ? (
          <label className="ct-field">
            <span className="ct-label">USD-equivalent amount (0 = off)</span>
            <input className="ct-input" type="number" min={0} step={1000} value={Number.isFinite(draft) ? draft : ''} onChange={(e) => setDraft(e.target.value === '' ? Number.NaN : Number(e.target.value))} />
            {draft !== current && <span className="ctm-small ctm-diff-after">was {current === 0 ? 'off' : `USD ${formatNumber(current)}`}</span>}
          </label>
        ) : (
          <div className="ct-metric-value">{current === 0 ? 'Off' : `USD ${formatNumber(current)}`}</div>
        )}
        {error && <div className="ctm-error-text">{error}</div>}
        <div className="ct-muted ctm-small">Default {`USD ${formatNumber(DEFAULT_CONFIG['risk.manualReviewAboveUsd'])}`}.</div>
      </div>
    </Card>
  );
}
