// Small browser-safe helpers: hashing, XML text building, amount formatting. No node: imports.
import { exponentOf, type Money } from '@ct/contracts/browser';

/** 32-bit FNV-1a over UTF-16 code units, with a seed folded in. */
function fnv1a32(input: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche (murmur3 fmix32) so nearby inputs differ in every bit
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic hex string of the given length (pure JS, not cryptographic). */
export function hashHex(input: string, length = 32): string {
  let out = '';
  for (let i = 0; out.length < length; i++) out += fnv1a32(input, Math.imul(i + 1, 0x9e3779b9)).toString(16).padStart(8, '0');
  return out.slice(0, length);
}

/** Deterministic UETR (UUID v4 layout: version nibble 4, variant 8..b) derived from a payment id. */
export function uetrFor(paymentId: string): string {
  const h = hashHex(`uetr|${paymentId}`, 32);
  const variant = '89ab'[Number.parseInt(h[16] ?? '0', 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Deterministic Max35Text reference with a prefix, e.g. ref('MSG', paymentId, 'pacs.008', '1'). */
export function ref(prefix: string, ...parts: string[]): string {
  return `${prefix}-${hashHex(parts.join('|'), 16).toUpperCase()}`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // strip characters that are not allowed in XML 1.0 at all
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

/** Integer minor units -> ISO 20022 decimal string with the currency's exponent ("1250.00", JPY "125000"). */
export function formatAmount(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error(`amountMinor must be a safe integer, got ${amountMinor}`);
  const exp = exponentOf(currency);
  const neg = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exp + 1, '0');
  const body = exp === 0 ? digits : `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
  return neg ? `-${body}` : body;
}

export function formatMoney(m: Money): string {
  return formatAmount(m.amountMinor, m.currency);
}

/** ISO 20022 decimal string -> integer minor units (exact, no float math). Returns null if malformed. */
export function parseAmount(text: string, currency: string): number | null {
  const m = /^(\d{1,18})(?:\.(\d{1,5}))?$/.exec(text);
  if (!m) return null;
  const exp = exponentOf(currency);
  const frac = m[2] ?? '';
  if (frac.length > exp) return null;
  const n = Number(`${m[1]}${frac.padEnd(exp, '0')}`);
  return Number.isSafeInteger(n) ? n : null;
}

/** Tiny element builder: el('Nm', 'text') or el('Amt', '1.00', { Ccy: 'USD' }) or el('Grp', [children]). */
export type Node = string | Node[];

export function el(name: string, content: string | number | Node[] | undefined | null, attrs?: Record<string, string>): string {
  if (content === undefined || content === null) return '';
  const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('') : '';
  if (Array.isArray(content)) {
    const inner = flatten(content).filter((s) => s !== '');
    if (inner.length === 0) return '';
    return `<${name}${a}>${inner.join('')}</${name}>`;
  }
  return `<${name}${a}>${escapeXml(String(content))}</${name}>`;
}

function flatten(nodes: Node[]): string[] {
  return nodes.flatMap((n) => (Array.isArray(n) ? flatten(n) : [n]));
}

/** Pretty-print a compact XML string built by el() (no mixed content), 2-space indent. */
export function document(namespace: string, body: string): string {
  const raw = `<Document xmlns="${namespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</Document>`;
  const tokens = raw.match(/<[^>]+>|[^<]+/g) ?? [];
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('</')) {
      depth--;
      lines.push(`${'  '.repeat(depth)}${t}`);
    } else if (t.startsWith('<')) {
      const text = tokens[i + 1];
      const close = tokens[i + 2];
      if (text !== undefined && !text.startsWith('<') && close?.startsWith('</')) {
        lines.push(`${'  '.repeat(depth)}${t}${text}${close}`);
        i += 2;
      } else {
        lines.push(`${'  '.repeat(depth)}${t}`);
        depth++;
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${lines.join('\n')}\n`;
}

export const isoDate = (iso: string): string => iso.slice(0, 10);

/** ISO date-time without milliseconds, UTC with Z (ISODateTime). */
export const isoDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date-time: ${iso}`);
  return `${d.toISOString().slice(0, 19)}Z`;
};
