// What the side panel shows (pure): KPI tiles and the ledger badge. Missing data never throws;
// a panel whose source is unavailable is simply left out (null).
import type { Stats } from '../lib/types';
import { formatCount } from '../lib/format';

export interface KpiTile {
  key: string;
  label: string;
  value: string;
  tone?: 'info' | 'ok' | 'warn' | 'bad';
}

/** Payments/min, reconciled, re-routes (provider rejects that were retried elsewhere), lost. */
export function kpiTiles(stats: Stats | null): KpiTile[] {
  const v = (n: number | undefined) => (stats ? formatCount(n ?? 0) : '—');
  const retries = stats?.retriesTotal ?? 0;
  const failed = stats?.failed ?? 0;
  return [
    { key: 'ppm', label: 'Payments / min', value: v(stats?.throughput?.paymentsPerMin), tone: 'info' },
    { key: 'reconciled', label: 'Reconciled', value: v(stats?.reconciled), tone: 'ok' },
    { key: 'retries', label: 'Retries · re-routed', value: v(retries), tone: retries > 0 ? 'warn' : undefined },
    { key: 'lost', label: 'Payments lost', value: v(failed), tone: !stats ? undefined : failed > 0 ? 'bad' : 'ok' },
  ];
}

export interface LedgerBadge {
  tone: 'ok' | 'bad';
  mark: string;
  title: string;
  sub: string;
}

/** The big "Ledger Balanced ✓" tile; null when the trial balance is unavailable (tile hidden). */
export function ledgerBadge(tb: { balanced?: unknown; journals?: unknown } | null | undefined): LedgerBadge | null {
  if (!tb || typeof tb.balanced !== 'boolean') return null;
  const journals = typeof tb.journals === 'number' ? tb.journals : null;
  const sub = journals === null ? 'debits = credits' : `debits = credits · ${formatCount(journals)} journals`;
  return tb.balanced
    ? { tone: 'ok', mark: '✓', title: 'Ledger Balanced', sub }
    : { tone: 'bad', mark: '✗', title: 'Ledger NOT balanced', sub: 'debits ≠ credits' };
}
