// Deterministic synthetic payment generator (traffic v2). Same (seed, index, scenario) => same request,
// byte for byte, independent of count, start offset or concurrency. All names, accounts and amounts are
// fictional.
//
// Model:
//  - a seeded population per corridor: a fixed set of senders (people and small businesses) and
//    recipients, so the same customers send repeatedly, as in real remittance traffic;
//  - weighted corridor mix (US-IN busiest);
//  - log-normal amounts per corridor (median and spread differ by corridor), rounded the way people pay;
//  - optional scenario mix (e.g. 2% provider-reject, 1% recon-break), drawn per payment.
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

/** Scenarios the pipeline understands (M2). */
export const SCENARIOS = ['force-hold', 'provider-reject', 'recon-break'] as const;

/** Per-corridor traffic profile: share of traffic and log-normal amount (major units of the source currency). */
export interface CorridorProfile {
  weight: number;
  /** Median amount in major units. */
  median: number;
  /** Log-space standard deviation. */
  sigma: number;
  /** Share of senders that are businesses. */
  businessShare: number;
}

export const CORRIDOR_PROFILES: Record<string, CorridorProfile> = {
  'US-IN': { weight: 0.5, median: 350, sigma: 1.0, businessShare: 0.2 },
  'GB-PH': { weight: 0.3, median: 220, sigma: 0.9, businessShare: 0.15 },
  'DE-BR': { weight: 0.2, median: 900, sigma: 1.2, businessShare: 0.4 },
};
const DEFAULT_PROFILE: CorridorProfile = { weight: 0.1, median: 300, sigma: 1.0, businessShare: 0.2 };

export const MIN_MAJOR = 1;
export const MAX_MAJOR = 50_000;
/** Senders and recipients per corridor in the synthetic population. */
export const POPULATION_PER_CORRIDOR = { senders: 400, recipients: 600 };

/** Scenario mix: scenario -> probability per payment (sum <= 1). */
export type ScenarioMix = Partial<Record<string, number>>;

/** "provider-reject=0.02,recon-break=0.01" -> { 'provider-reject': 0.02, 'recon-break': 0.01 } */
export function parseScenarioMix(text: string): ScenarioMix {
  const mix: ScenarioMix = {};
  let total = 0;
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, raw] = part.split('=');
    const p = Number(raw?.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : raw);
    if (!name || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`bad scenario mix entry "${part}" (expected name=probability, e.g. provider-reject=0.02 or provider-reject=2%)`);
    mix[name] = p;
    total += p;
  }
  if (total > 1 + 1e-9) throw new Error(`scenario mix probabilities sum to ${total} > 1`);
  return mix;
}

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

export interface Population {
  senders: Party[];
  recipients: Party[];
}

const populationCache = new Map<string, Population>();

/** The seeded population of one corridor (stable for a seed; cached). */
export function corridorPopulation(seed: number, corridor: Corridor): Population {
  const key = `${seed}:${corridor.id}`;
  const cached = populationCache.get(key);
  if (cached) return cached;
  const rand = mulberry32(hash32(`population:${key}`));
  const profile = CORRIDOR_PROFILES[corridor.id] ?? DEFAULT_PROFILE;
  const senders = Array.from({ length: POPULATION_PER_CORRIDOR.senders }, () => party(rand, corridor.sourceCountry, rand() < profile.businessShare));
  const recipients = Array.from({ length: POPULATION_PER_CORRIDOR.recipients }, () => party(rand, corridor.targetCountry, false));
  const pop = { senders, recipients };
  populationCache.set(key, pop);
  return pop;
}

/** Standard normal via Box-Muller (uses two draws). */
function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Log-normal integer minor-unit amount in the corridor's source currency, clamped to [1, 50,000] major units. */
export function amountMinor(rand: () => number, currency: string, profile: CorridorProfile = DEFAULT_PROFILE): number {
  const major = Math.min(MAX_MAJOR, Math.max(MIN_MAJOR, Math.exp(Math.log(profile.median) + profile.sigma * normal(rand))));
  const scale = 10 ** exponentOf(currency);
  // People tend to send round numbers: 40% whole units (half of those to the nearest 10), otherwise any minor amount.
  const r = rand();
  const minor = r < 0.2 && major >= 20 ? Math.round(major / 10) * 10 * scale : r < 0.4 ? Math.round(major) * scale : Math.round(major * scale);
  return Math.min(MAX_MAJOR * scale, Math.max(scale, minor));
}

function weightedCorridor(rand: () => number, corridors: readonly Corridor[]): Corridor {
  const weights = corridors.map((c) => (CORRIDOR_PROFILES[c.id] ?? DEFAULT_PROFILE).weight);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < corridors.length; i++) {
    r -= weights[i]!;
    if (r < 0) return corridors[i]!;
  }
  return corridors[corridors.length - 1]!;
}

/** Scenario for payment `index` under a mix (independent of the payment's other draws). */
export function scenarioFor(seed: number, index: number, mix: ScenarioMix | undefined): string | undefined {
  if (!mix) return undefined;
  let r = mulberry32(hash32(`scenario:${seed}:${index}`))();
  for (const [name, p] of Object.entries(mix)) {
    if (!p) continue;
    if (r < p) return name;
    r -= p;
  }
  return undefined;
}

export interface GenerateOptions {
  /** Fixed scenario for every payment (v1 flag --scenario). Wins over `mix`. */
  scenario?: string;
  /** Scenario mix, drawn per payment. */
  mix?: ScenarioMix;
  corridors?: readonly Corridor[];
}

export function generatePayment(seed: number, index: number, opts: GenerateOptions = {}): GeneratedPayment {
  const rand = mulberry32(hash32(`${seed}:${index}`));
  const corridor = weightedCorridor(rand, opts.corridors ?? CORRIDORS);
  const profile = CORRIDOR_PROFILES[corridor.id] ?? DEFAULT_PROFILE;
  const pop = corridorPopulation(seed, corridor);
  // Zipf-ish reuse: a few customers send a lot (squared uniform skews towards low indices).
  const sender = pop.senders[Math.floor(rand() ** 2 * pop.senders.length)]!;
  const recipient = pop.recipients[Math.floor(rand() * pop.recipients.length)]!;
  const body: PaymentRequest = {
    amount: { amountMinor: amountMinor(rand, corridor.sourceCurrency, profile), currency: corridor.sourceCurrency },
    targetCurrency: corridor.targetCurrency,
    corridor: corridor.id,
    debtor: { ...sender },
    creditor: { ...recipient },
  };
  const scenario = opts.scenario ?? scenarioFor(seed, index, opts.mix);
  if (scenario) body.scenario = scenario;
  return { index, idempotencyKey: idempotencyKey(seed, index, scenario), body };
}

export function generatePayments(seed: number, count: number, opts: GenerateOptions & { start?: number } = {}): GeneratedPayment[] {
  const start = opts.start ?? 0;
  return Array.from({ length: count }, (_, i) => generatePayment(seed, start + i, opts));
}
