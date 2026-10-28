// M4: occasional risky payments in synthetic traffic (`--risk-mix sanctions=0.5%,fraud=1%`).
// Deterministic per (seed, index): the same payment index is always risky in the same way. Nothing here
// tells the pipeline what to decide; the payments are shaped like what screening and the risk engine look
// for (a party close to a fictional sanctions-list entry; a structured amount from a brand-new account to a
// beneficiary many others are also paying). All names are fictional.
import { exponentOf, type Party } from '@ct/contracts';
import { hash32, mulberry32, type PaymentRequest } from './generator';

export const RISK_KINDS = ['sanctions', 'fraud'] as const;
export type RiskKind = (typeof RISK_KINDS)[number];
export type RiskMix = Partial<Record<RiskKind, number>>;

/**
 * Near-matches of entries on the fictional sanctions list used by screening: a transliteration, a dropped
 * or reordered word, a typo. Fuzzy matching should flag every one of them.
 */
export const SANCTIONS_NEAR_MATCHES: readonly { name: string; kind: 'entity' | 'person' }[] = [
  { name: 'Volkhov Maritime Holding', kind: 'entity' },
  { name: 'Darius Kael Morvane', kind: 'person' },
  { name: 'Obsidian Crescent Trading FZE', kind: 'entity' },
  { name: 'Severin Ashgrove-Malek', kind: 'person' },
  { name: 'Northwind Petrochem Ltd', kind: 'entity' },
];

/** "sanctions=0.5%,fraud=0.01" -> { sanctions: 0.005, fraud: 0.01 } */
export function parseRiskMix(text: string): RiskMix {
  const mix: RiskMix = {};
  let total = 0;
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, raw] = part.split('=');
    const p = Number(raw?.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : raw);
    if (!name || !(RISK_KINDS as readonly string[]).includes(name)) throw new Error(`bad risk mix entry "${part}" (kinds: ${RISK_KINDS.join(', ')})`);
    if (!Number.isFinite(p) || p < 0 || p > 1 || raw === undefined || raw === '') throw new Error(`bad risk mix entry "${part}" (expected kind=probability, e.g. fraud=0.01 or fraud=1%)`);
    mix[name as RiskKind] = p;
    total += p;
  }
  if (total > 1 + 1e-9) throw new Error(`risk mix probabilities sum to ${total} > 1`);
  return mix;
}

/** Risk kind for payment `index` (an independent draw: other payment fields are unaffected). */
export function riskFor(seed: number, index: number, mix: RiskMix | undefined): RiskKind | undefined {
  if (!mix) return undefined;
  let r = mulberry32(hash32(`risk:${seed}:${index}`))();
  for (const kind of RISK_KINDS) {
    const p = mix[kind];
    if (!p) continue;
    if (r < p) return kind;
    r -= p;
  }
  return undefined;
}

/** Make a generated request risky. Pure: returns a new request. */
export function applyRisk(kind: RiskKind, seed: number, index: number, body: PaymentRequest): PaymentRequest {
  const rand = mulberry32(hash32(`risk-shape:${kind}:${seed}:${index}`));
  const tag = hash32(`risk-acct:${seed}:${index}`).toString(16).toUpperCase().padStart(8, '0');
  if (kind === 'sanctions') {
    const match = SANCTIONS_NEAR_MATCHES[Math.floor(rand() * SANCTIONS_NEAR_MATCHES.length)]!;
    // Mostly the beneficiary; sometimes the sender.
    const onCreditor = rand() < 0.7;
    const swap = (p: Party): Party => ({ ...p, name: match.name, accountId: `SIM-${p.country}-SX${tag}` });
    return onCreditor ? { ...body, creditor: swap(body.creditor) } : { ...body, debtor: swap(body.debtor) };
  }
  // fraud: a brand-new sender account, an amount kept just below 10,000 (major units), paid to one of a few
  // "collector" beneficiaries per corridor, so fan-in builds up across risky payments.
  const scale = 10 ** exponentOf(body.amount.currency);
  const major = 9_000 + Math.floor(rand() * 990);
  const collector = Math.floor(rand() * 3) + 1;
  return {
    ...body,
    amount: { amountMinor: major * scale, currency: body.amount.currency },
    debtor: { ...body.debtor, accountId: `SIM-${body.debtor.country}-NEW${tag}` },
    creditor: { name: `Collector Account ${collector}`, country: body.creditor.country, accountId: `SIM-${body.creditor.country}-COLL${collector}` },
  };
}
