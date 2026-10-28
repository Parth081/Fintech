// Pure logic for Routing & Providers configuration: readable descriptions, current-vs-proposed diffs, proposal
// validation, and a client-side re-score of recent routing decisions under proposed weights / provider switches.
import type { ChangeRequest, ChangeStatus, ConfigKey, ConfigValues, ProviderScore } from '@ct/contracts/browser';
import { CORRIDORS, PROVIDERS } from '@ct/contracts/browser';

export const CONFIG_KEYS: readonly ConfigKey[] = ['provider.enabled', 'provider.forcedBreaker', 'routing.weights', 'risk.thresholds', 'risk.manualReviewAboveUsd'];

export const KEY_INFO: Record<ConfigKey, { title: string; help: string; area: 'providers' | 'routing' | 'risk' }> = {
  'provider.enabled': { title: 'Provider availability', help: 'A disabled provider is never routed to.', area: 'providers' },
  'provider.forcedBreaker': { title: 'Forced circuit breaker', help: 'Force a provider’s breaker open, overriding the automatic breaker.', area: 'providers' },
  'routing.weights': { title: 'Routing weights', help: 'How the router trades off success rate, cost and speed (normalised by their sum).', area: 'routing' },
  'risk.thresholds': { title: 'Risk decision thresholds', help: 'Combined risk score at or above “hold” is held for review; at or above “reject” is rejected.', area: 'risk' },
  'risk.manualReviewAboveUsd': { title: 'Manual review limit', help: 'Payments at or above this USD-equivalent amount always need review (0 = off).', area: 'risk' },
};

// ---------------------------------------------------------------------------------------------- diff

export interface DiffRow {
  path: string; // "success", "orion", "" for scalars
  before: unknown;
  after: unknown;
  kind: 'added' | 'removed' | 'changed' | 'same';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function flatten(v: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length && prefix) out.set(prefix, {});
    for (const k of keys.sort()) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, v);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level diff of two config values; absent/null are treated as "not set". */
export function diffValues(before: unknown, after: unknown, includeSame = false): DiffRow[] {
  const a = flatten(before);
  const b = flatten(after);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows: DiffRow[] = [];
  for (const p of paths) {
    const x = a.has(p) ? a.get(p) : undefined;
    const y = b.has(p) ? b.get(p) : undefined;
    const xSet = x !== undefined && x !== null;
    const ySet = y !== undefined && y !== null;
    const kind: DiffRow['kind'] = !xSet && ySet ? 'added' : xSet && !ySet ? 'removed' : same(x, y) ? 'same' : 'changed';
    if (kind === 'same' && !includeSame) continue;
    if (!xSet && !ySet) continue;
    rows.push({ path: p, before: x, after: y, kind });
  }
  return rows;
}

export function formatValue(key: ConfigKey, path: string, v: unknown): string {
  if (v === undefined || v === null) return key === 'provider.forcedBreaker' ? 'automatic' : '—';
  if (key === 'provider.enabled' && typeof v === 'boolean') return v ? 'enabled' : 'disabled';
  if (key === 'provider.forcedBreaker' && v === 'open') return 'forced open';
  if (key === 'risk.manualReviewAboveUsd' && typeof v === 'number') return v === 0 ? 'off' : `USD ${v.toLocaleString('en-US')}`;
  if (key === 'routing.weights' && typeof v === 'number') return v.toFixed(2);
  if (key === 'risk.thresholds' && typeof v === 'number') return v.toFixed(2);
  void path;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** One-line human summary of a change, e.g. "orion: enabled → disabled". */
export function summarizeChange(key: ConfigKey, before: unknown, after: unknown): string {
  const rows = diffValues(before, after);
  if (!rows.length) return 'No change';
  return rows.map((r) => `${r.path ? `${r.path}: ` : ''}${formatValue(key, r.path, r.before)} → ${formatValue(key, r.path, r.after)}`).join('; ');
}

// ---------------------------------------------------------------------------------------------- validation

/** Mirrors the server-side per-key validation so the form explains errors before submitting. */
export function validateProposal<K extends ConfigKey>(key: K, value: ConfigValues[K], current: ConfigValues[K], all?: ConfigValues): string | null {
  if (same(value, current)) return 'The proposed value is the same as the current value';
  switch (key) {
    case 'risk.thresholds': {
      const v = value as ConfigValues['risk.thresholds'];
      if (!(v.hold >= 0.05 && v.hold <= 0.99)) return 'Hold must be between 0.05 and 0.99';
      if (!(v.reject >= 0.1 && v.reject <= 1)) return 'Reject must be between 0.10 and 1.00';
      if (!(v.hold < v.reject)) return 'The hold threshold must be below the reject threshold';
      return null;
    }
    case 'risk.manualReviewAboveUsd': {
      const v = value as number;
      return Number.isFinite(v) && v >= 0 && v <= 10_000_000 && Number.isInteger(v) ? null : 'Enter a whole USD amount between 0 (off) and 10,000,000';
    }
    case 'routing.weights': {
      const v = value as ConfigValues['routing.weights'];
      if ([v.success, v.cost, v.speed].some((x) => !(x >= 0 && x <= 1))) return 'Each weight must be between 0 and 1';
      return v.success + v.cost + v.speed > 0 ? null : 'At least one weight must be above 0';
    }
    case 'provider.enabled': {
      const v = value as Record<string, boolean>;
      if (!Object.values(v).some(Boolean)) return 'At least one provider must stay enabled';
      return coverageErrors(v, {}, all)[0] ?? null;
    }
    case 'provider.forcedBreaker': {
      return coverageErrors({}, value as Record<string, 'open' | null>, all)[0] ?? null;
    }
    default:
      return null;
  }
}

/**
 * Corridors that would have no usable provider (same rule as the ops service). Pass the full proposed switch
 * maps; use `base` to merge onto the current values of the other key.
 */
export function coverageErrors(enabled: Record<string, boolean>, forced: Record<string, 'open' | null>, base?: Pick<ConfigValues, 'provider.enabled' | 'provider.forcedBreaker'>): string[] {
  const en = { ...(base?.['provider.enabled'] ?? {}), ...enabled };
  const fo = { ...(base?.['provider.forcedBreaker'] ?? {}), ...forced };
  const errors: string[] = [];
  for (const c of CORRIDORS) {
    const usable = PROVIDERS.filter((p) => p.corridors.includes(c.id) && en[p.id] !== false && fo[p.id] !== 'open');
    if (!usable.length) errors.push(`Corridor ${c.id} would have no usable provider`);
  }
  return errors;
}

export function validateChangeReason(reason: string): string | null {
  const t = reason.trim();
  if (!t) return 'A reason is required for every change request';
  return t.length < 10 ? 'Please write at least 10 characters' : null;
}

// ---------------------------------------------------------------------------------------------- change requests

export type ChangeTab = ChangeStatus | 'all';

export function filterChanges(list: readonly ChangeRequest[], tab: ChangeTab, key?: ConfigKey): ChangeRequest[] {
  return list
    .filter((c) => (tab === 'all' || c.status === tab) && (!key || c.key === key))
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
}

export function pendingFor(list: readonly ChangeRequest[], key: ConfigKey): ChangeRequest[] {
  return list.filter((c) => c.status === 'pending' && c.key === key);
}

export interface ReviewGate {
  allowed: boolean;
  reason?: string;
}

export function canReview(c: ChangeRequest, can: (p: 'config.approve') => boolean, userId: string | undefined): ReviewGate {
  if (!can('config.approve')) return { allowed: false, reason: 'Requires permission config.approve' };
  if (c.status !== 'pending') return { allowed: false, reason: `Already ${c.status}` };
  if (userId && c.requestedBy.userId === userId) return { allowed: false, reason: 'Four-eyes rule: you requested this change, another approver must review it' };
  return { allowed: true };
}

export function changeStatusTone(s: ChangeStatus): 'warn' | 'ok' | 'bad' | 'neutral' {
  return s === 'pending' ? 'warn' : s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : 'neutral';
}

// ---------------------------------------------------------------------------------------------- routing preview

export interface Weights {
  success: number;
  cost: number;
  speed: number;
}

/** Same formula as @ct/market scoreProviders (FAILURE_SPAN 0.1), on a recorded decision's inputs. */
export const FAILURE_SPAN = 0.1;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function rescore(rows: readonly ProviderScore[], w: Weights, opts: { disabled?: ReadonlySet<string>; forcedOpen?: ReadonlySet<string> } = {}): ProviderScore[] {
  const wSum = w.success + w.cost + w.speed;
  const out = rows.map((r) => {
    const blocked = opts.disabled?.has(r.providerId) ? 'PROVIDER_DISABLED' : opts.forcedOpen?.has(r.providerId) ? 'CIRCUIT_FORCED_OPEN' : undefined;
    const copy: ProviderScore = { ...r, score: 0, eligible: r.eligible && !blocked };
    if (blocked && r.eligible) copy.excludedReason = blocked;
    return copy;
  });
  const eligible = out.filter((r) => r.eligible);
  if (eligible.length && wSum > 0) {
    const minFail = Math.min(...eligible.map((r) => 1 - r.successRate));
    const minFee = Math.min(...eligible.map((r) => r.fee.amountMinor));
    const minLat = Math.min(...eligible.map((r) => r.latencyMs));
    for (const r of eligible) {
      const success = Math.min(1, Math.max(0, 1 - (1 - r.successRate - minFail) / FAILURE_SPAN));
      const cost = r.fee.amountMinor === 0 ? 1 : minFee / r.fee.amountMinor;
      const speed = r.latencyMs === 0 ? 1 : minLat / r.latencyMs;
      r.score = round4((w.success * success + w.cost * cost + w.speed * speed) / wSum);
    }
  }
  return out.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (!a.eligible) return 0;
    return b.score - a.score || a.fee.amountMinor - b.fee.amountMinor || b.successRate - a.successRate || a.providerId.localeCompare(b.providerId);
  });
}

export interface RoutingSample {
  paymentId: string;
  corridor: string;
  chosen: string;
  scoring: ProviderScore[];
}

export interface PreviewRow {
  paymentId: string;
  corridor: string;
  before: string;
  after: string | null; // null = no eligible provider
  changed: boolean;
  margin: number | null; // winner score - runner-up score under the proposal
}

export interface PreviewSummary {
  rows: PreviewRow[];
  changed: number;
  unroutable: number;
  /** Share of sampled payments per provider before / after. */
  shareBefore: Record<string, number>;
  shareAfter: Record<string, number>;
}

export function previewRouting(samples: readonly RoutingSample[], w: Weights, opts: { disabled?: ReadonlySet<string>; forcedOpen?: ReadonlySet<string> } = {}): PreviewSummary {
  const rows: PreviewRow[] = samples.map((s) => {
    const r = rescore(s.scoring, w, opts);
    const elig = r.filter((x) => x.eligible);
    const after = elig[0]?.providerId ?? null;
    return { paymentId: s.paymentId, corridor: s.corridor, before: s.chosen, after, changed: after !== s.chosen, margin: elig[0] && elig[1] ? round4(elig[0].score - elig[1].score) : null };
  });
  const share = (pick: (r: PreviewRow) => string | null) => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      const k = pick(r) ?? 'none';
      m[k] = (m[k] ?? 0) + 1;
    }
    for (const k of Object.keys(m)) m[k] = m[k]! / Math.max(1, rows.length);
    return m;
  };
  return { rows, changed: rows.filter((r) => r.changed).length, unroutable: rows.filter((r) => r.after === null).length, shareBefore: share((r) => r.before), shareAfter: share((r) => r.after) };
}

/** Normalised weights as percentages that add up to 100 (largest remainder). */
export function weightPercents(w: Weights): Weights {
  const sum = w.success + w.cost + w.speed;
  if (!(sum > 0)) return { success: 0, cost: 0, speed: 0 };
  const raw = { success: (w.success / sum) * 100, cost: (w.cost / sum) * 100, speed: (w.speed / sum) * 100 };
  const floor = { success: Math.floor(raw.success), cost: Math.floor(raw.cost), speed: Math.floor(raw.speed) };
  let rest = 100 - floor.success - floor.cost - floor.speed;
  const order = (['success', 'cost', 'speed'] as const).slice().sort((a, b) => raw[b] - floor[b] - (raw[a] - floor[a]));
  for (const k of order) {
    if (rest <= 0) break;
    floor[k] += 1;
    rest -= 1;
  }
  return floor;
}

/**
 * Routing samples from payment details: the first-attempt `payment.routed` decision of each payment that recorded
 * its full scoring (M2+). Payments without scoring are skipped.
 */
export function samplesFromEvents(payments: readonly { paymentId: string; corridor: string; events: readonly { type: string; payload: unknown }[] }[]): RoutingSample[] {
  const out: RoutingSample[] = [];
  for (const p of payments) {
    const routed = p.events.filter((e) => e.type === 'payment.routed');
    const first = routed.find((e) => ((e.payload as { attempt?: number }).attempt ?? 1) === 1) ?? routed[0];
    if (!first) continue;
    const pl = first.payload as { providerId?: string; scoring?: ProviderScore[] };
    if (!pl.providerId || !Array.isArray(pl.scoring) || pl.scoring.length === 0) continue;
    out.push({ paymentId: p.paymentId, corridor: p.corridor, chosen: pl.providerId, scoring: pl.scoring });
  }
  return out;
}

/** Edit-mode proposals for the providers card: which keys changed and the validation errors for the combination. */
export function providerProposals(
  current: Pick<ConfigValues, 'provider.enabled' | 'provider.forcedBreaker'>,
  draft: Pick<ConfigValues, 'provider.enabled' | 'provider.forcedBreaker'>,
): { changes: { key: 'provider.enabled' | 'provider.forcedBreaker'; value: unknown }[]; errors: string[] } {
  const changes: { key: 'provider.enabled' | 'provider.forcedBreaker'; value: unknown }[] = [];
  if (!same(current['provider.enabled'], draft['provider.enabled'])) changes.push({ key: 'provider.enabled', value: draft['provider.enabled'] });
  // Forced breaker: drop automatic (null) entries so the stored map stays minimal.
  const forced = Object.fromEntries(Object.entries(draft['provider.forcedBreaker']).filter(([, v]) => v === 'open')) as Record<string, 'open' | null>;
  const curForced = Object.fromEntries(Object.entries(current['provider.forcedBreaker']).filter(([, v]) => v === 'open'));
  if (!same(curForced, forced)) changes.push({ key: 'provider.forcedBreaker', value: forced });
  const errors: string[] = [];
  if (!Object.values(draft['provider.enabled']).some(Boolean)) errors.push('At least one provider must stay enabled');
  errors.push(...coverageErrors(draft['provider.enabled'], forced));
  return { changes, errors };
}
