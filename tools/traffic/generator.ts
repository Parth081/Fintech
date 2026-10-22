// Deterministic synthetic payment generator. Same (seed, index, scenario) => same request, byte for byte.
// All names, accounts and amounts are fictional.
import { CORRIDORS, exponentOf, type Corridor, type Money, type Party } from '@ct/contracts';

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a, used to mix seed and index into an independent per-payment PRNG seed. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const FIRST_NAMES = [
  'Avery', 'Bram', 'Calla', 'Darin', 'Elowen', 'Fenn', 'Greta', 'Hollis', 'Isolde', 'Jory',
  'Kestrel', 'Linnea', 'Marlo', 'Nerys', 'Oren', 'Perrin', 'Quill', 'Rowan', 'Sabine', 'Tamsin',
  'Ulric', 'Vesna', 'Wren', 'Yara', 'Zephyr', 'Anika', 'Ravi', 'Meera', 'Tomas', 'Lucia',
];
const LAST_NAMES = [
  'Ashdown', 'Brightwater', 'Coldridge', 'Dunmore', 'Everhart', 'Fairhollow', 'Greystone', 'Hawthorne',
  'Ivesdale', 'Juniper', 'Kettleby', 'Larkspur', 'Mossgrove', 'Northcote', 'Oakhurst', 'Penhallow',
  'Quarrington', 'Ravenscar', 'Stillwater', 'Thornbury', 'Underhill', 'Valemont', 'Whitlock', 'Yarrowby',
];
const BUSINESS_SUFFIX = ['Trading Co.', 'Textiles Ltd', 'Imports', 'Studio', 'Exports', 'Supplies'];

/** Request body for POST /payments (mirrors the payment.initiated payload, minus the idempotency key). */
export interface PaymentRequest {
  amount: Money;
  targetCurrency: string;
  corridor: string;
  debtor: Party;
  creditor: Party;
  scenario?: string;
}

export interface GeneratedPayment {
  index: number;
  idempotencyKey: string;
  body: PaymentRequest;
}

export const SCENARIOS = ['force-hold'] as const;

export function idempotencyKey(seed: number, index: number, scenario?: string): string {
  return `traffic-s${seed}-i${index}${scenario ? `-${scenario}` : ''}`;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick() from empty list');
  return item;
}

function accountId(rand: () => number, country: string): string {
  let digits = '';
  for (let i = 0; i < 10; i++) digits += Math.floor(rand() * 10);
  return `SIM-${country}-${digits}`;
}

function party(rand: () => number, country: string, business: boolean): Party {
  const last = pick(rand, LAST_NAMES);
  const name = business ? `${last} ${pick(rand, BUSINESS_SUFFIX)}` : `${pick(rand, FIRST_NAMES)} ${last}`;
  return { name, country, accountId: accountId(rand, country) };
}

/** Major-unit range for a payment, by "kind" of remittance. */
const AMOUNT_BANDS = [
  { weight: 0.55, min: 20, max: 500 }, // family remittance
  { weight: 0.3, min: 500, max: 5_000 }, // tuition / rent
  { weight: 0.15, min: 5_000, max: 50_000 }, // small business invoice
] as const;

/** Plausible integer minor-unit amount in the source currency. */
export function amountMinor(rand: () => number, currency: string): number {
  let r = rand();
  let band: (typeof AMOUNT_BANDS)[number] = AMOUNT_BANDS[0];
  for (const b of AMOUNT_BANDS) {
    band = b;
    if (r < b.weight) break;
    r -= b.weight;
  }
  // Log-uniform within the band so small amounts are more common than large ones.
  const major = Math.exp(Math.log(band.min) + rand() * (Math.log(band.max) - Math.log(band.min)));
  const scale = 10 ** exponentOf(currency);
  // People tend to send round numbers: 40% whole units, otherwise any minor amount.
  const roundWhole = rand() < 0.4;
  const minor = roundWhole ? Math.round(major) * scale : Math.round(major * scale);
  return Math.max(scale, minor);
}

export function generatePayment(
  seed: number,
  index: number,
  opts: { scenario?: string; corridors?: readonly Corridor[] } = {},
): GeneratedPayment {
  const rand = mulberry32(hash32(`${seed}:${index}`));
  const corridor = pick(rand, opts.corridors ?? CORRIDORS);
  const business = rand() < 0.25;
  const body: PaymentRequest = {
    amount: { amountMinor: amountMinor(rand, corridor.sourceCurrency), currency: corridor.sourceCurrency },
    targetCurrency: corridor.targetCurrency,
    corridor: corridor.id,
    debtor: party(rand, corridor.sourceCountry, business),
    creditor: party(rand, corridor.targetCountry, false),
  };
  if (opts.scenario) body.scenario = opts.scenario;
  return { index, idempotencyKey: idempotencyKey(seed, index, opts.scenario), body };
}

export function generatePayments(seed: number, count: number, opts: { scenario?: string; start?: number } = {}): GeneratedPayment[] {
  const start = opts.start ?? 0;
  return Array.from({ length: count }, (_, i) => generatePayment(seed, start + i, opts));
}
