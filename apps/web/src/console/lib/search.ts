// Global search (pure): classify what the operator typed and build direct jumps.
import { links } from './routing';

export type SearchKind = 'case' | 'alert' | 'change' | 'refund' | 'break' | 'payment' | 'text';

export interface Jump {
  kind: SearchKind;
  label: string;
  href: string;
}

const CASE_RE = /^case-\d{4}-\d+$/i;
const CHANGE_RE = /^cr-\d+$/i;
const REFUND_RE = /^rf-\d+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalised query: trimmed, inner whitespace collapsed, capped. */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ').slice(0, 120);
}

export function classify(q: string): SearchKind {
  const s = normalizeQuery(q);
  if (CASE_RE.test(s)) return 'case';
  if (CHANGE_RE.test(s)) return 'change';
  if (REFUND_RE.test(s)) return 'refund';
  if (/^(alert|alr)[-_]/i.test(s)) return 'alert';
  if (/^(brk|break)[-_]/i.test(s)) return 'break';
  if (UUID_RE.test(s) || /^(pay|pmt)[-_]/i.test(s)) return 'payment';
  return 'text';
}

/** Direct jumps for an id-shaped query (shown first; Enter takes the first). */
export function directJumps(q: string): Jump[] {
  const s = normalizeQuery(q);
  if (s.length < 2) return [];
  switch (classify(s)) {
    case 'case':
      return [{ kind: 'case', label: `Open case ${s.toUpperCase()}`, href: links.case(s.toUpperCase()) }];
    case 'change':
      return [{ kind: 'change', label: `Open change request ${s.toUpperCase()}`, href: links.change(s.toUpperCase()) }];
    case 'refund':
      return [{ kind: 'refund', label: `Find refund ${s.toUpperCase()}`, href: links.refunds({ q: s.toUpperCase() }) }];
    case 'alert':
      return [{ kind: 'alert', label: `Open alert ${s}`, href: links.alert(s) }];
    case 'break':
      return [{ kind: 'break', label: `Open break ${s}`, href: links.break(s) }];
    case 'payment':
      return [{ kind: 'payment', label: `Open payment ${s}`, href: links.payment(s) }];
    default:
      return [];
  }
}

/** Should we hit the APIs for this query? (2+ characters) */
export function searchable(q: string): boolean {
  return normalizeQuery(q).length >= 2;
}

/** Move a highlighted index through `n` results with wrap-around. */
export function moveIndex(cur: number, delta: number, n: number): number {
  if (n <= 0) return -1;
  if (cur < 0) return delta > 0 ? 0 : n - 1;
  return (cur + delta + n) % n;
}
