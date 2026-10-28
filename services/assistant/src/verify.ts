// Number verification: every number, amount, percentage, duration and clock time in an answer must be
// matched to a cited Fact (see the formatting rules in facts.ts).
//
// MATCHING RULES
//   "USD 1,250.00", "$1,250.00", "1,250.00 USD" -> a money fact in that currency with exactly that amount
//                          (or, for USD, a 'usd' fact: a plain recorded number of dollars, to the cent)
//   "97.5%"                -> ratio fact (value x 100) or score fact in 0..1 (x 100) or bps fact (/ 100)
//   "35 bps"               -> bps fact
//   "6.2 s", "850 ms", "2 minutes" -> ms fact, converted to the token's unit
//   "10:00:05" (UTC)       -> time fact with that clock time (HH:MM or HH:MM:SS)
//   "2026-01-01"           -> a fact whose recorded value starts with that date
//   plain "83.25", "12"    -> count, rate, score, bps or ratio fact (never money: an amount needs its currency)
//   number words (two..twenty) -> count fact
// A token matches when it is a correct rounding of the fact at the token's displayed precision. Plain
// decimals must show at least min(2, recorded decimals) decimals for non-integer facts, so "1" never
// "verifies" a 0.97 success rate. Identifier digits (AC04, pacs.008, UUIDs, j-1, ISO 20022) are ignored.
import { exponentOf } from '@ct/contracts';
import { isMoney, type Fact } from './facts';

export type TokenKind = 'money' | 'percent' | 'bps' | 'duration' | 'time' | 'date' | 'number' | 'word';

export interface NumberToken {
  raw: string;
  kind: TokenKind;
  value: number;
  decimals: number;
  currency?: string;
  /** For durations: milliseconds per unit of the token. */
  unitMs?: number;
  /** For time/date tokens: the text to compare. */
  text?: string;
}

export interface VerifyResult {
  verified: boolean;
  tokens: NumberToken[];
  unmatched: NumberToken[];
  /** Facts that matched at least one token (in fact order). */
  matched: Fact[];
}

const KNOWN_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'BRL', 'PHP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'MXN', 'SGD', 'HKD', 'AED', 'ZAR', 'NGN', 'KES'];
const SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', 'R$': 'BRL', '₱': 'PHP', '¥': 'JPY' };
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000, million: 1_000_000,
};
const DURATION_UNITS: [RegExp, number][] = [
  [/^(ms|msec|milliseconds?)\b/i, 1],
  [/^(s|secs?|seconds?)\b/i, 1000],
  [/^(min|mins|minutes?)\b/i, 60_000],
  [/^(h|hrs?|hours?)\b/i, 3_600_000],
];
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

function parseNum(raw: string): { value: number; decimals: number } {
  const clean = raw.replace(/,/g, '').replace('−', '-');
  const dot = clean.indexOf('.');
  return { value: Number(clean), decimals: dot >= 0 ? clean.length - dot - 1 : 0 };
}

const isAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** Extract every number-like token from free text. */
export function extractNumbers(text: string, extraCurrencies: Iterable<string> = []): NumberToken[] {
  const tokens: NumberToken[] = [];
  const currencies = new Set([...KNOWN_CURRENCIES, ...extraCurrencies]);
  let s = ` ${text} `;
  const blank = (m: string) => 'ref'.padEnd(m.length, ' ');

  // 1. Vocabulary whose digits are names, not quantities.
  s = s.replace(/\bISO\s?20022\b/gi, blank).replace(/\b(pacs|camt|pain)\.\d{3}(\.\d+)*\b/gi, blank);

  // 2. Money with a currency code before or after, or a symbol before.
  const codeAlt = [...currencies].join('|');
  s = s.replace(new RegExp(String.raw`(?<![A-Za-z])(${codeAlt})\s?(-|−)?(${NUM})(?![\d])`, 'g'), (m, cur: string, neg: string | undefined, num: string) => {
    const { value, decimals } = parseNum(num);
    tokens.push({ raw: m.trim(), kind: 'money', value: neg ? -value : value, decimals, currency: cur });
    return blank(m);
  });
  s = s.replace(new RegExp(String.raw`(-|−)?(R\$|\$|€|£|₹|₱|¥)\s?(${NUM})`, 'g'), (m, neg: string | undefined, sym: string, num: string) => {
    const { value, decimals } = parseNum(num);
    tokens.push({ raw: m.trim(), kind: 'money', value: neg ? -value : value, decimals, currency: SYMBOLS[sym] ?? 'USD' });
    return blank(m);
  });
  s = s.replace(new RegExp(String.raw`(?<![\w.-])(-|−)?(${NUM})\s?(${codeAlt})\b`, 'g'), (m, neg: string | undefined, num: string, cur: string) => {
    const { value, decimals } = parseNum(num);
    tokens.push({ raw: m.trim(), kind: 'money', value: neg ? -value : value, decimals, currency: cur });
    return blank(m);
  });

  // 3. Clock times and dates.
  s = s.replace(/(?<![\w:.-])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?![\w:])/g, (m, h: string, mi: string, sec: string | undefined) => {
    tokens.push({ raw: m, kind: 'time', value: 0, decimals: 0, text: `${h.padStart(2, '0')}:${mi}${sec ? `:${sec}` : ''}` });
    return blank(m);
  });
  s = s.replace(/(?<![\w-])(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?(?![\w-])/g, (m, d: string) => {
    tokens.push({ raw: m, kind: 'date', value: 0, decimals: 0, text: d });
    return blank(m);
  });

  // 4. Remaining numbers, classified by their unit.
  const re = new RegExp(String.raw`(-|−)?(${NUM})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const start = m.index + (m[1] ? 1 : 0);
    let raw = m[2]!;
    const prev = s[start - 1];
    const prev2 = s[start - 2];
    // identifier context: glued to letters/digits, or joined by . - / # to an identifier
    if (isAlnum(prev)) continue;
    if (prev !== undefined && '.-/#'.includes(prev) && isAlnum(prev2) && !m[1]) continue;
    if (m[1] && isAlnum(s[m.index - 1])) continue; // "j-1"
    const after = s.slice(start + raw.length);
    if (/^[-/][A-Za-z0-9]/.test(after)) continue; // "12345678-ab..." uuid head
    const { value: v0, decimals } = parseNum(raw);
    const value = m[1] ? -v0 : v0;
    if (m[1]) raw = `-${raw}`;
    const unitText = after.replace(/^\s/, '');
    if (/^(%|percent\b|per\s?cent\b)/i.test(unitText)) {
      tokens.push({ raw: `${raw}%`, kind: 'percent', value, decimals });
      continue;
    }
    if (/^(bps\b|basis\s+points?\b|bp\b)/i.test(unitText)) {
      tokens.push({ raw: `${raw} bps`, kind: 'bps', value, decimals });
      continue;
    }
    const dur = DURATION_UNITS.find(([u]) => u.test(unitText));
    if (dur) {
      tokens.push({ raw: `${raw} ${unitText.split(/\s|\b/)[0]}`, kind: 'duration', value, decimals, unitMs: dur[1] });
      continue;
    }
    if (/^(st|nd|rd|th)\b/i.test(after)) {
      tokens.push({ raw, kind: 'number', value, decimals });
      continue;
    }
    if (/^[A-Za-z]/.test(after)) continue; // "3f2a..." identifier
    tokens.push({ raw, kind: 'number', value, decimals });
  }

  // 5. Number words.
  const wordRe = new RegExp(String.raw`\b(${Object.keys(NUMBER_WORDS).join('|')})\b`, 'gi');
  while ((m = wordRe.exec(s)) !== null) {
    tokens.push({ raw: m[1]!, kind: 'word', value: NUMBER_WORDS[m[1]!.toLowerCase()]!, decimals: 0 });
  }
  return tokens;
}

function near(x: number, c: number, decimals: number): boolean {
  return Math.abs(x - c) <= 0.5 * 10 ** -decimals + 1e-9;
}

function numericValue(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
}

function recordedDecimals(v: unknown): number {
  if (typeof v === 'string') {
    const i = v.indexOf('.');
    return i >= 0 ? v.length - i - 1 : 0;
  }
  if (typeof v === 'number') {
    const s = String(v);
    const i = s.indexOf('.');
    return i >= 0 ? s.length - i - 1 : 0;
  }
  return 0;
}

/** Does this token match this fact under the rules above? */
export function tokenMatches(t: NumberToken, f: Fact): boolean {
  const v = f.value;
  switch (t.kind) {
    case 'money': {
      if (f.kind === 'usd') return typeof v === 'number' && t.currency === 'USD' && t.decimals <= 2 && Math.abs(t.value - v) < 0.005 + 1e-9;
      if (f.kind !== 'money' || !isMoney(v) || v.currency !== t.currency) return false;
      const exp = exponentOf(v.currency);
      return t.decimals <= exp && Math.round(t.value * 10 ** exp) === v.amountMinor;
    }
    case 'percent': {
      const n = numericValue(v);
      if (n === undefined) return false;
      if (f.kind === 'ratio' || (f.kind === 'score' && n >= 0 && n <= 1)) return near(t.value, n * 100, t.decimals);
      if (f.kind === 'bps') return near(t.value, n / 100, t.decimals);
      return false;
    }
    case 'bps': {
      const n = numericValue(v);
      return f.kind === 'bps' && n !== undefined && near(t.value, n, t.decimals);
    }
    case 'duration': {
      const n = numericValue(v);
      return f.kind === 'ms' && n !== undefined && near(t.value, n / (t.unitMs ?? 1), t.decimals);
    }
    case 'time': {
      if (f.kind !== 'time' || typeof v !== 'string') return false;
      const clock = /T(\d{2}:\d{2}:\d{2})/.exec(v)?.[1];
      return clock !== undefined && clock.startsWith(t.text ?? '\u0000');
    }
    case 'date':
      return typeof v === 'string' && v.startsWith(t.text ?? '\u0000');
    case 'word': {
      const n = numericValue(v);
      return f.kind === 'count' && n === t.value;
    }
    case 'number': {
      if (f.kind === 'money' || f.kind === 'usd' || f.kind === 'time' || f.kind === 'text' || f.kind === 'ms') return false;
      const n = numericValue(v);
      if (n === undefined) return false;
      if (!Number.isInteger(n) && t.decimals < Math.min(2, recordedDecimals(v))) return false;
      if (f.kind === 'rate' && t.decimals > recordedDecimals(v)) return false;
      return near(t.value, n, t.decimals);
    }
  }
}

/** Verify an answer against the facts it may rely on. */
export function verifyAnswer(text: string, facts: readonly Fact[]): VerifyResult {
  const currencies = facts.flatMap((f) => (isMoney(f.value) ? [f.value.currency] : []));
  // Verbatim recorded text (a hold reason, an ISO reason text, an account name) may contain digits; quoting
  // it exactly is grounded by definition, so those spans are removed before numbers are extracted.
  let scrubbed = text;
  const texts = facts
    .filter((f) => f.kind === 'text')
    .flatMap((f) => (Array.isArray(f.value) ? [f.value.map(String).join(', '), ...f.value.map(String)] : [String(f.value)]))
    .filter((s) => s.length >= 3 && /\d/.test(s))
    .sort((a, b) => b.length - a.length);
  for (const t of texts) scrubbed = scrubbed.split(t).join(' ref ');
  const tokens = extractNumbers(scrubbed, currencies);
  const unmatched: NumberToken[] = [];
  const matchedSet = new Set<Fact>();
  for (const t of tokens) {
    const hits = facts.filter((f) => tokenMatches(t, f));
    if (hits.length === 0) unmatched.push(t);
    for (const h of hits) matchedSet.add(h);
  }
  return { verified: unmatched.length === 0, tokens, unmatched, matched: facts.filter((f) => matchedSet.has(f)) };
}
