// Display formatting for the console (pure). Money always goes through @ct/contracts formatMoney.
import { exponentOf, formatMoney as contractFormatMoney, type Money } from '@ct/contracts/browser';

export { exponentOf };

export function formatMoney(m: Money | null | undefined): string {
  if (!m || !Number.isFinite(m.amountMinor)) return '—';
  return contractFormatMoney(m);
}

/** Signed money for ledger-style display: "-USD 1,250.00" for debits shown as outflow. */
export function formatSignedMoney(m: Money, sign: 1 | -1): string {
  const s = contractFormatMoney({ ...m, amountMinor: Math.abs(m.amountMinor) });
  return sign < 0 ? `−${s}` : s;
}

/** Compact USD for KPI tiles: 1234567 -> "$1.23M". `usd` is in major units. */
export function formatUsdCompact(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** 0.9734 -> "97.3%". */
export function formatPercent(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "23 Oct 2026, 14:05:09" in local time. */
export function formatDateTime(iso: string | number | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${opts.seconds === false ? '' : `:${pad(d.getSeconds())}`}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
}

export function formatTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "just now", "3 min ago", "in 12 min", "2 h ago", "3 d ago". */
export function formatRelative(iso: string | number | null | undefined, nowMs: number): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = nowMs - t;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  let text: string;
  if (s < 45) return future ? 'in a few seconds' : 'just now';
  if (s < 90 * 60) text = `${Math.max(1, Math.round(s / 60))} min`;
  else if (s < 36 * 3600) text = `${Math.round(s / 3600)} h`;
  else text = `${Math.round(s / 86400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Duration "850 ms", "4.2 s", "3 min 05 s", "2 h 10 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (a < 3_600_000) return `${Math.floor(a / 60_000)} min ${pad(Math.floor((a % 60_000) / 1000))} s`;
  return `${Math.floor(a / 3_600_000)} h ${pad(Math.floor((a % 3_600_000) / 60_000))} min`;
}

/** Human label from a snake/dot code: "pending_approval" -> "Pending approval", "case.assigned" -> "Case assigned". */
export function humanize(code: string): string {
  const s = code.replace(/[._-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Shorten long ids in dense tables: keep the start and end. */
export function shortId(id: string, max = 18): string {
  if (id.length <= max) return id;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

/** Local date input value (YYYY-MM-DD) -> ISO bounds for that day. */
export function dayBounds(date: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(start.getTime()) || start.getMonth() !== Number(m[2]) - 1 || start.getDate() !== Number(m[3])) return null;
  const end = new Date(start.getTime() + 86_400_000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Major units -> Money in minor units (for filters). */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** exponentOf(currency));
}
