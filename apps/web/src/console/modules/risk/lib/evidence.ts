// Turn an alert's free-form `evidence` and `reasons` into investigator-ready views. The producers (screening and
// risk stages) own the evidence shape, so every reader here is defensive: it accepts the likely field names and
// degrades to "not provided" instead of throwing.
import type { AlertView, AuditEntry, Money } from '@ct/contracts/browser';
import type { HistoryItem } from './queue';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
function pick(o: Rec | undefined, ...keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

// ---------------------------------------------------------------------------------------------- sanctions

export interface SanctionsMatch {
  /** Name on the payment (screened party). */
  screenedName: string;
  partyRole: string; // "creditor" | "debtor" | ...
  screenedCountry?: string;
  /** Name on the list entry. */
  listName: string;
  listId?: string;
  listSource?: string; // list / program name
  listCountry?: string;
  aliases: string[];
  /** 0..1 */
  score: number | null;
  algorithm?: string;
  listVersion?: string;
  extra: [string, string][];
}

export function parseSanctions(a: Pick<AlertView, 'evidence' | 'score' | 'payment'>): SanctionsMatch {
  const ev = a.evidence;
  const entry = (isRec(pick(ev, 'listEntry', 'entry', 'matchedEntry', 'match')) ? pick(ev, 'listEntry', 'entry', 'matchedEntry', 'match') : undefined) as Rec | undefined;
  const party = (isRec(pick(ev, 'party', 'screenedParty')) ? pick(ev, 'party', 'screenedParty') : undefined) as Rec | undefined;
  const role = str(pick(ev, 'partyRole', 'role', 'field')) ?? str(pick(party, 'role')) ?? 'creditor';
  const fallbackName = role === 'debtor' ? a.payment.debtorName : a.payment.creditorName;
  const aliasesRaw = pick(entry, 'aliases', 'akas') ?? pick(ev, 'aliases');
  const used = new Set(['listEntry', 'entry', 'matchedEntry', 'match', 'party', 'screenedParty', 'partyRole', 'role', 'field', 'screenedName', 'partyName', 'name', 'matchedName', 'listName', 'score', 'matchScore', 'similarity', 'aliases', 'algorithm', 'listVersion', 'list']);
  const extra: [string, string][] = [];
  for (const [k, v] of Object.entries(ev)) if (!used.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) extra.push([k, String(v)]);
  const score = num(pick(ev, 'matchScore', 'score', 'similarity')) ?? num(pick(entry, 'score')) ?? a.score ?? null;
  return {
    screenedName: str(pick(ev, 'screenedName', 'partyName', 'name')) ?? str(pick(party, 'name')) ?? fallbackName,
    partyRole: role,
    screenedCountry: str(pick(party, 'country')) ?? str(pick(ev, 'partyCountry')),
    listName: str(pick(entry, 'name', 'primaryName')) ?? str(pick(ev, 'matchedName', 'listName')) ?? 'Not provided',
    listId: str(pick(entry, 'id', 'entryId', 'uid')),
    listSource: str(pick(entry, 'list', 'program', 'source')) ?? (typeof pick(ev, 'list') === 'string' ? str(pick(ev, 'list')) : undefined),
    listCountry: str(pick(entry, 'country', 'nationality')),
    aliases: Array.isArray(aliasesRaw) ? aliasesRaw.filter((x): x is string => typeof x === 'string') : [],
    score: score === null ? null : score > 1 ? score / 100 : score,
    algorithm: str(pick(ev, 'algorithm')),
    listVersion: str(pick(ev, 'listVersion')) ?? str(pick(entry, 'listVersion')),
    extra,
  };
}

export interface TokenCompare {
  token: string;
  /** Exact = same token appears on the other side; fuzzy = a close token (edit distance <= 2); none. */
  match: 'exact' | 'fuzzy' | 'none';
}

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Token-by-token comparison for the side-by-side name view. */
export function compareNames(left: string, right: string): { left: TokenCompare[]; right: TokenCompare[] } {
  const lt = norm(left).split(/\s+/).filter(Boolean);
  const rt = norm(right).split(/\s+/).filter(Boolean);
  const side = (mine: string[], other: string[]): TokenCompare[] =>
    mine.map((t) => ({
      token: t,
      match: other.includes(t) ? 'exact' : other.some((o) => editDistance(t, o) <= Math.min(2, Math.floor(Math.max(t.length, o.length) / 3))) ? 'fuzzy' : 'none',
    }));
  return { left: side(lt, rt), right: side(rt, lt) };
}

/** Simple similarity in 0..1 used only when the producer did not send a score. */
export function nameSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x && !y) return 1;
  const d = editDistance(x, y);
  return Math.max(0, 1 - d / Math.max(x.length, y.length));
}

// ---------------------------------------------------------------------------------------------- fraud

export interface Contribution {
  code: string;
  text: string;
  /** Signed weight as reported (positive raises risk). */
  weight: number;
  /** |weight| / max |weight|, 0..1, for bar length. */
  scaled: number;
  /** weight / sum of positive weights, for "explains 42% of the score". */
  share: number;
}

/**
 * Contributions for the bar chart. Reasons without a weight get an equal share of the score.
 * Sorted by absolute weight, largest first.
 */
export function contributions(reasons: AlertView['reasons'], score?: number): Contribution[] {
  if (!reasons.length) return [];
  const anyWeight = reasons.some((r) => typeof r.weight === 'number' && Number.isFinite(r.weight));
  const equal = (score ?? 1) / reasons.length;
  const rows = reasons.map((r) => ({ code: r.code, text: r.text, weight: anyWeight ? (Number.isFinite(r.weight) ? (r.weight as number) : 0) : equal }));
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.weight)), 0);
  const posSum = rows.reduce((s, r) => s + Math.max(0, r.weight), 0);
  return rows
    .map((r) => ({ ...r, scaled: maxAbs > 0 ? Math.abs(r.weight) / maxAbs : 0, share: posSum > 0 ? Math.max(0, r.weight) / posSum : 0 }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.code.localeCompare(b.code));
}

/** Plain English for a reason code when the producer's text is terse. */
export function humanizeCode(code: string): string {
  const s = code.replace(/[_.-]+/g, ' ').toLowerCase().trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

export function scoreBand(score: number | null | undefined, thresholds = { hold: 0.7, reject: 0.92 }): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (score === null || score === undefined) return { label: 'No score', tone: 'neutral' };
  if (score >= thresholds.reject) return { label: 'Above reject threshold', tone: 'bad' };
  if (score >= thresholds.hold) return { label: 'Above hold threshold', tone: 'warn' };
  return { label: 'Below hold threshold', tone: 'ok' };
}

// ---------------------------------------------------------------------------------------------- AML

export interface RelatedPayment {
  paymentId: string;
  debtorName: string;
  creditorName: string;
  amount: Money | null;
  at?: string;
  status?: string;
  corridor?: string;
  /** True for the payment the alert is about. */
  current: boolean;
}

function moneyFrom(v: unknown, currency?: unknown): Money | null {
  if (isRec(v)) {
    const m = num(v.amountMinor);
    const c = str(v.currency);
    return m !== undefined && c ? { amountMinor: m, currency: c } : null;
  }
  const m = num(v);
  const c = str(currency);
  return m !== undefined && c ? { amountMinor: m, currency: c } : null;
}

export function parseRelatedPayments(a: Pick<AlertView, 'evidence' | 'paymentId' | 'payment'>): RelatedPayment[] {
  // The risk engine emits relatedPaymentIds (ids only); details are filled in by enrichRelated().
  const raw = pick(a.evidence, 'relatedPayments', 'relatedPaymentIds', 'related', 'payments', 'cluster');
  const out: RelatedPayment[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (typeof r === 'string') {
        out.push({ paymentId: r, debtorName: '—', creditorName: '—', amount: null, current: r === a.paymentId });
        continue;
      }
      if (!isRec(r)) continue;
      const id = str(pick(r, 'paymentId', 'id'));
      if (!id) continue;
      const debtor = pick(r, 'debtor', 'sender', 'debtorName', 'from');
      const creditor = pick(r, 'creditor', 'beneficiary', 'creditorName', 'to');
      out.push({
        paymentId: id,
        debtorName: (isRec(debtor) ? str(debtor.name) : str(debtor)) ?? '—',
        creditorName: (isRec(creditor) ? str(creditor.name) : str(creditor)) ?? '—',
        amount: moneyFrom(pick(r, 'amount'), pick(r, 'currency')),
        at: str(pick(r, 'at', 'occurredAt', 'createdAt', 'initiatedAt')),
        status: str(pick(r, 'status')),
        corridor: str(pick(r, 'corridor')),
        current: id === a.paymentId,
      });
    }
  }
  if (!out.some((r) => r.current)) {
    out.unshift({ paymentId: a.paymentId, debtorName: a.payment.debtorName, creditorName: a.payment.creditorName, amount: a.payment.amount, corridor: a.payment.corridor, status: a.payment.status, current: true });
  }
  return out;
}

/** Fill in names/amount/status for related payments that arrived as bare ids. */
export function enrichRelated(
  related: RelatedPayment[],
  details: ReadonlyMap<string, { debtorName: string; creditorName: string; amount: Money | null; corridor?: string; status?: string; at?: string }>,
): RelatedPayment[] {
  return related.map((r) => {
    const d = details.get(r.paymentId);
    if (!d || (r.debtorName !== '—' && r.creditorName !== '—')) return r;
    return { ...r, debtorName: d.debtorName, creditorName: d.creditorName, amount: r.amount ?? d.amount, corridor: r.corridor ?? d.corridor, status: r.status ?? d.status, at: r.at ?? d.at };
  });
}

export interface NetNode {
  id: string;
  label: string;
  side: 'sender' | 'beneficiary';
  x: number;
  y: number;
  /** Highlighted: part of the alerted payment. */
  focus: boolean;
}
export interface NetEdge {
  from: string;
  to: string;
  count: number;
  focus: boolean;
}
export interface NetLayout {
  width: number;
  height: number;
  nodes: NetNode[];
  edges: NetEdge[];
}

/**
 * Bipartite layout: senders in a left column, beneficiaries in a right column, each sorted by degree (busiest in
 * the middle) so fan-in / fan-out patterns read at a glance. Deterministic for a given input.
 */
export function networkLayout(payments: readonly RelatedPayment[], opts: { width?: number; rowH?: number; pad?: number; maxPerSide?: number } = {}): NetLayout {
  const width = opts.width ?? 560;
  const rowH = opts.rowH ?? 38;
  const pad = opts.pad ?? 24;
  const maxPerSide = opts.maxPerSide ?? 12;
  const edgeMap = new Map<string, NetEdge>();
  const deg = { sender: new Map<string, number>(), beneficiary: new Map<string, number>() };
  const focus = { sender: new Set<string>(), beneficiary: new Set<string>() };
  for (const p of payments) {
    const s = p.debtorName;
    const b = p.creditorName;
    deg.sender.set(s, (deg.sender.get(s) ?? 0) + 1);
    deg.beneficiary.set(b, (deg.beneficiary.get(b) ?? 0) + 1);
    if (p.current) {
      focus.sender.add(s);
      focus.beneficiary.add(b);
    }
    const key = `${s}\u0000${b}`;
    const e = edgeMap.get(key) ?? { from: `s:${s}`, to: `b:${b}`, count: 0, focus: false };
    e.count += 1;
    e.focus ||= p.current;
    edgeMap.set(key, e);
  }
  const order = (m: Map<string, number>, f: Set<string>): string[] => {
    const byDeg = [...m.entries()].sort((a, b) => Number(f.has(b[0])) - Number(f.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k).slice(0, maxPerSide);
    // centre-out: busiest in the middle
    const out: string[] = [];
    byDeg.forEach((k, i) => (i % 2 === 0 ? out.push(k) : out.unshift(k)));
    return out;
  };
  const senders = order(deg.sender, focus.sender);
  const bens = order(deg.beneficiary, focus.beneficiary);
  const rows = Math.max(senders.length, bens.length, 1);
  const height = pad * 2 + (rows - 1) * rowH;
  const colY = (n: number, i: number) => pad + ((rows - n) * rowH) / 2 + i * rowH;
  const nodes: NetNode[] = [
    ...senders.map((k, i) => ({ id: `s:${k}`, label: k, side: 'sender' as const, x: Math.round(width * 0.28), y: colY(senders.length, i), focus: focus.sender.has(k) })),
    ...bens.map((k, i) => ({ id: `b:${k}`, label: k, side: 'beneficiary' as const, x: Math.round(width * 0.72), y: colY(bens.length, i), focus: focus.beneficiary.has(k) })),
  ];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...edgeMap.values()].filter((e) => ids.has(e.from) && ids.has(e.to));
  return { width, height, nodes, edges };
}

/** Pattern headline: fan-in (many senders -> one beneficiary), fan-out, or structuring/velocity. */
export function amlPattern(payments: readonly RelatedPayment[], rule: string): string {
  const senders = new Set(payments.map((p) => p.debtorName)).size;
  const bens = new Set(payments.map((p) => p.creditorName)).size;
  const r = rule.toUpperCase();
  if (r.includes('FAN_IN') || (bens === 1 && senders > 2)) return `Fan-in: ${senders} senders paying ${bens === 1 ? 'one beneficiary' : `${bens} beneficiaries`}`;
  if (r.includes('FAN_OUT') || (senders === 1 && bens > 2)) return `Fan-out: one sender paying ${bens} beneficiaries`;
  if (r.includes('STRUCT')) return `Structuring: ${payments.length} payments just under a reporting threshold`;
  if (r.includes('VELOCITY')) return `Velocity: ${payments.length} payments in a short window`;
  return `${payments.length} related payments between ${senders} senders and ${bens} beneficiaries`;
}

// ---------------------------------------------------------------------------------------------- audit trail

const ACTION_LABEL: Record<string, string> = {
  'case.assigned': 'Assigned',
  'case.unassigned': 'Unassigned',
  'case.note_added': 'Note added',
  'case.noted': 'Note added',
  'case.decided': 'Decision recorded',
  'case.proposed': 'Decision proposed',
  'case.approved': 'Decision approved',
  'case.returned': 'Returned for more work',
  'payment.released': 'Payment released',
  'payment.rejected': 'Payment rejected',
};

export function auditLabel(action: string): string {
  return ACTION_LABEL[action] ?? humanizeCode(action);
}

/** Audit entries as history items (dedupe against record-derived items is by the caller: same title + same second). */
export function auditToHistory(entries: readonly AuditEntry[]): HistoryItem[] {
  return entries.map((e) => {
    const d = e.details;
    const detail = str(d.reason) ?? str(d.comment) ?? str(d.text) ?? (isRec(d.assignee) ? `to ${str(d.assignee.name) ?? ''}` : undefined);
    return {
      at: e.at,
      title: auditLabel(e.action),
      detail: [detail, e.eventId ? `event ${e.eventId}` : undefined].filter(Boolean).join(' · ') || undefined,
      actor: e.actor.name,
      tone: e.action.includes('reject') ? 'bad' : e.action.includes('release') || e.action.includes('approve') ? 'ok' : 'neutral',
    };
  });
}

export function mergeHistory(a: readonly HistoryItem[], b: readonly HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  const out: HistoryItem[] = [];
  for (const h of [...a, ...b]) {
    const k = `${Math.floor(Date.parse(h.at) / 1000)}|${h.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}
