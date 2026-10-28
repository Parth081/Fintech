// Fuzzy name matching for sanctions screening. Deterministic, dependency-free.
//
// 1. Normalise: Unicode NFKD, strip diacritics, lower-case, "&" -> "and", hyphens/punctuation -> space,
//    "SURNAME, Given" handled by token sorting, drop legal-form noise words (ltd, llc, fze, company, ...)
//    and stop words (the, of, and).
// 2. Score a name pair two ways and keep the higher:
//    a) joined token-sort Jaro-Winkler (tokens sorted and concatenated; catches split/merged words), used
//       only when near-exact (>= 0.97);
//    b) token alignment (order-independent, so it also catches reordering): for each token, its best JW against the other name's tokens, averaged weighted by
//       token length, in both directions; score = 0.7 x max(direction) + 0.3 x min(direction)
//       (catches a dropped / extra word and per-word typos or transliterations).
// 3. A party is compared against every entry's primary name and aliases; the best is its score.
//    score >= SANCTIONS_HIT_THRESHOLD -> potential match ('hit').
import { FICTIONAL_SANCTIONS_LIST, SANCTIONS_LIST_NAME, SANCTIONS_LIST_VERSION, type SanctionsEntry } from './sanctions-list';

export const MATCH_ALGORITHM = 'normalised token-sort + token-alignment Jaro-Winkler (p=0.1, prefix<=4)';
export const SANCTIONS_HIT_THRESHOLD = 0.88;
/** At or above this a hit is 'critical' (near-exact), below it 'high'. */
export const SANCTIONS_CRITICAL_THRESHOLD = 0.97;

const NOISE = new Set([
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'sa', 'ag', 'bv', 'nv',
  'fze', 'fzco', 'fzc', 'jsc', 'ojsc', 'pjsc', 'llp', 'lp', 'pte', 'pvt', 'srl', 'spa', 'the', 'of', 'and',
]);

export function normaliseName(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0 && !NOISE.has(t));
}

/** Jaro-Winkler similarity in [0, 1] (Winkler prefix scale 0.1, prefix up to 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = true;
      bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function coverage(from: string[], to: string[]): number {
  let num = 0;
  let den = 0;
  for (const t of from) {
    let best = 0;
    for (const u of to) best = Math.max(best, jaroWinkler(t, u));
    num += t.length * best;
    den += t.length;
  }
  return den ? num / den : 0;
}

/** Similarity of two (already normalised) token lists. */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  // Joined form catches split/merged words ("Ashgrove Malik" vs "Ashgrovemalik"); it is only trusted when
  // near-exact, because a long shared prefix inflates JW on whole strings.
  const joined = jaroWinkler([...a].sort().join(''), [...b].sort().join(''));
  const ab = coverage(a, b);
  const ba = coverage(b, a);
  const aligned = 0.7 * Math.max(ab, ba) + 0.3 * Math.min(ab, ba);
  return joined >= 0.97 ? Math.max(joined, aligned) : aligned;
}

export function nameSimilarity(a: string, b: string): number {
  return tokenSimilarity(normaliseName(a), normaliseName(b));
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

interface PreparedName { entry: SanctionsEntry; name: string; tokens: string[]; alias: boolean }
let prepared: PreparedName[] | undefined;
function preparedList(): PreparedName[] {
  prepared ??= FICTIONAL_SANCTIONS_LIST.flatMap((entry) => [
    { entry, name: entry.name, tokens: normaliseName(entry.name), alias: false },
    ...entry.aliases.map((a) => ({ entry, name: a, tokens: normaliseName(a), alias: true })),
  ]);
  return prepared;
}

export interface PartyMatch {
  field: 'debtor' | 'creditor';
  partyName: string;
  score: number;
  entry: { id: string; name: string; type: SanctionsEntry['type']; program: string; countries: readonly string[]; listedOn: string };
  matchedName: string;
  matchedAlias: boolean;
}

const MEMO_MAX = 20_000;
const memo = new Map<string, PartyMatch | null>();

/** Best list match for one name (null when the name normalises to nothing). Ties: higher score, then entry id. Memoised. */
export function bestMatch(field: PartyMatch['field'], partyName: string): PartyMatch | null {
  const key = `${field}\u0000${partyName}`;
  if (memo.has(key)) {
    const hit = memo.get(key) ?? null;
    return hit && { ...hit };
  }
  const result = computeBestMatch(field, partyName);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, result);
  return result && { ...result };
}

function computeBestMatch(field: PartyMatch['field'], partyName: string): PartyMatch | null {
  const tokens = normaliseName(partyName);
  if (!tokens.length) return null;
  let best: PartyMatch | null = null;
  for (const p of preparedList()) {
    const score = round4(tokenSimilarity(tokens, p.tokens));
    if (!best || score > best.score || (score === best.score && p.entry.id < best.entry.id)) {
      const { entry } = p;
      best = {
        field, partyName, score, matchedName: p.name, matchedAlias: p.alias,
        entry: { id: entry.id, name: entry.name, type: entry.type, program: entry.program, countries: entry.countries, listedOn: entry.listedOn },
      };
    }
  }
  return best;
}

export interface ScreeningResult {
  result: 'clear' | 'hit';
  /** Highest score over both parties (0..1). */
  score: number;
  listName: typeof SANCTIONS_LIST_NAME;
  listVersion: typeof SANCTIONS_LIST_VERSION;
  algorithm: string;
  threshold: number;
  /** Best match per party (always present, for the trace). */
  best: PartyMatch[];
  /** Matches at or above the threshold, highest first. */
  hits: PartyMatch[];
}

export function screenParties(debtorName: string, creditorName: string): ScreeningResult {
  const best = [bestMatch('debtor', debtorName), bestMatch('creditor', creditorName)].filter((m): m is PartyMatch => m !== null);
  const hits = best.filter((m) => m.score >= SANCTIONS_HIT_THRESHOLD).sort((a, b) => b.score - a.score);
  const score = best.reduce((s, m) => Math.max(s, m.score), 0);
  return {
    result: hits.length ? 'hit' : 'clear',
    score,
    listName: SANCTIONS_LIST_NAME,
    listVersion: SANCTIONS_LIST_VERSION,
    algorithm: MATCH_ALGORITHM,
    threshold: SANCTIONS_HIT_THRESHOLD,
    best,
    hits,
  };
}
