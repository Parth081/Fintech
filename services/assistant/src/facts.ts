// Facts: a Citation plus the kind of number it holds. Every number in an answer is rendered from a Fact
// with fmt(), and the verifier (verify.ts) maps every number it finds back to a Fact using the same rules.
//
// FORMATTING RULES (the verifier accepts exactly these renderings, plus correct roundings of them):
//   money  -> "USD 1,250.00"  ISO code, space, grouped amount at the currency's minor-unit exponent (exact)
//   ratio  -> "97.5%"         value 0..1 shown as a percentage with 1 decimal
//   bps    -> "35 bps"        integer basis points
//   rate   -> "83.2500"       decimal string verbatim as recorded
//   score  -> "0.8123"        number as recorded
//   count  -> "1,234"         integer with thousands separators
//   ms     -> "850 ms" below one second, else seconds with 1 decimal "6.2 s"
//   time   -> "10:00:05 UTC"  HH:MM:SS of the recorded ISO timestamp
//   text   -> verbatim (ids, codes, names; carries no number the verifier checks)
import { formatMoney, type Citation, type Money } from '@ct/contracts';

export type FactKind = 'money' | 'ratio' | 'bps' | 'rate' | 'score' | 'count' | 'ms' | 'time' | 'text';

export interface Fact extends Citation {
  kind: FactKind;
}

/** Read a dotted path such as "payload.scoring[1].score" or "trace.inputs.breakers.orion.state". */
export function pathGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[m[1]];
    }
    for (const idx of m[2]?.match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

interface EventLike {
  eventId: string;
  type: string;
}

/** A fact read from a recorded event field. Returns undefined when the field is absent. */
export function eventFact(event: EventLike, field: string, label: string, kind: FactKind): Fact | undefined {
  const value = pathGet(event, field);
  if (value === undefined || value === null) return undefined;
  return { eventId: event.eventId, eventType: event.type, field, value, label, kind };
}

/** Like eventFact but throws when the field is missing (for fields the contract guarantees). */
export function mustFact(event: EventLike, field: string, label: string, kind: FactKind): Fact {
  const f = eventFact(event, field, label, kind);
  if (!f) throw new Error(`missing ${field} on ${event.type} ${event.eventId}`);
  return f;
}

/** A computed aggregate over events; `source` says how it was computed. */
export function aggFact(value: unknown, label: string, kind: FactKind, source: string, field = 'aggregate'): Fact {
  return { eventId: null, field, value, label, kind, source };
}

export function isMoney(v: unknown): v is Money {
  return typeof v === 'object' && v !== null && typeof (v as Money).amountMinor === 'number' && typeof (v as Money).currency === 'string';
}

export function groupInt(n: number): string {
  const neg = n < 0;
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${s}` : s;
}

export function formatPct(ratio: number): string {
  return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
}

export function formatMs(ms: number): string {
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

export function formatTime(iso: string): string {
  const t = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return t ? `${t[1]} UTC` : iso;
}

export function formatMoneySafe(m: Money): string {
  if (m.amountMinor < 0) return formatMoney({ amountMinor: -m.amountMinor, currency: m.currency }).replace(' ', ' -');
  return formatMoney(m);
}

/** Render a fact per the formatting rules above. */
export function fmt(f: Fact): string {
  const v = f.value;
  switch (f.kind) {
    case 'money':
      return isMoney(v) ? formatMoneySafe(v) : String(v);
    case 'ratio':
      return typeof v === 'number' ? formatPct(v) : String(v);
    case 'bps':
      return `${typeof v === 'number' ? groupInt(v) : String(v)} bps`;
    case 'count':
      return typeof v === 'number' ? groupInt(v) : String(v);
    case 'ms':
      return typeof v === 'number' ? formatMs(v) : String(v);
    case 'time':
      return typeof v === 'string' ? formatTime(v) : String(v);
    case 'rate':
    case 'score':
    case 'text':
    default:
      return Array.isArray(v) ? v.map(String).join(', ') : String(v);
  }
}

/** Strip the internal `kind` so only contract fields go over the wire. */
export function toCitation(f: Fact): Citation {
  const c: Citation = { eventId: f.eventId, field: f.field, value: f.value, label: f.label };
  if (f.eventType !== undefined) c.eventType = f.eventType;
  if (f.source !== undefined) c.source = f.source;
  return c;
}

/** De-duplicate facts by (eventId, field, label). */
export function uniqueFacts(facts: (Fact | undefined)[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const f of facts) {
    if (!f) continue;
    const key = `${f.eventId ?? 'agg'}|${f.field}|${f.label}|${JSON.stringify(f.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function providerName(id: string): string {
  const known: Record<string, string> = { orion: 'Orion', lyra: 'Lyra', vega: 'Vega' };
  return known[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

const EXCLUSION_TEXT: Record<string, string> = {
  FAILED_THIS_PAYMENT: 'already refused this payment',
  CORRIDOR_NOT_SERVED: 'does not serve this corridor',
  CIRCUIT_OPEN: 'its circuit breaker was open',
  CIRCUIT_HALF_OPEN: 'its circuit breaker was half-open (test payments only)',
  PROVIDER_DISABLED: 'switched off by an operator',
};

export function exclusionText(code: string): string {
  return EXCLUSION_TEXT[code] ?? code;
}
