// Compiles a validated ScenarioPack into the orchestrator's existing ScenarioScript. Nothing here is random
// at run time: generated payments depend only on the pack (name or seed, label, position), so the same pack
// always becomes the same script, and the orchestrator's idempotency keys make a replay send nothing twice.
import { corridorById, type Party } from '@ct/contracts';
import { SANCTIONS_NEAR_MATCHES } from '../../../../tools/traffic/risk';
import { validateScript, type CraftedPayment, type ScenarioAction, type ScenarioScript } from '../scenarios';
import type { PackEvent, ScenarioPack } from './schema';

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Fictional names only. Pools are per country so the synthetic parties look plausible on screen.
const NAMES: Record<string, { first: string[]; last: string[] }> = {
  US: { first: ['Harper', 'Dashiell', 'Marlowe', 'Wren', 'Ellis', 'Quinn', 'Sutton', 'Rowan'], last: ['Ashford', 'Calloway', 'Brightwood', 'Fairbanks', 'Holloway', 'Pennington', 'Stanhope', 'Whitcomb'] },
  GB: { first: ['Imogen', 'Barnaby', 'Rosalind', 'Crispin', 'Tabitha', 'Linus', 'Philippa', 'Cedric'], last: ['Thistlewood', 'Ravenscroft', 'Hartley-Vane', 'Mossbank', 'Aldercott', 'Pemberley', 'Ironside', 'Foxley'] },
  DE: { first: ['Matthias', 'Greta', 'Lorenz', 'Annelie', 'Konrad', 'Fenja', 'Emil', 'Sieglinde'], last: ['Brandtner', 'Eichwald', 'Hartmeyer', 'Lindqvist', 'Rosenau', 'Steinfeld', 'Vollmer', 'Waldmann'] },
  IN: { first: ['Aarav', 'Meera', 'Dhruv', 'Anika', 'Kabir', 'Tanvi', 'Ishaan', 'Radhika'], last: ['Chandran', 'Deshmukh', 'Ganguly', 'Kulkarni', 'Mahajan', 'Pillai', 'Soman', 'Trivedi'] },
  PH: { first: ['Andres', 'Corazon', 'Dante', 'Felicia', 'Gabriel', 'Hazel', 'Isidro', 'Joselyn'], last: ['Alcantara', 'Buenaventura', 'Dizon', 'Evangelista', 'Fernandez', 'Ibarra', 'Magsaysay', 'Salonga'] },
  BR: { first: ['Caio', 'Larissa', 'Murilo', 'Bianca', 'Thiago', 'Yasmin', 'Rafael', 'Camila'], last: ['Albuquerque', 'Barreto', 'Cavalcanti', 'Drummond', 'Figueiredo', 'Guimaraes', 'Nogueira', 'Vasconcelos'] },
};

function person(rand: () => number, country: string, accountId: string): Party {
  const pool = NAMES[country] ?? NAMES.US!;
  const first = pool.first[Math.floor(rand() * pool.first.length)]!;
  const last = pool.last[Math.floor(rand() * pool.last.length)]!;
  return { name: `${first} ${last}`, country, accountId };
}

const ENTITY_MATCHES = SANCTIONS_NEAR_MATCHES.filter((m) => m.kind === 'entity');
const PERSON_MATCHES = SANCTIONS_NEAR_MATCHES.filter((m) => m.kind === 'person');

/** Names that the generated "listed party" payments use (so the dry run can recognise them). */
export const LISTED_PARTY_NAMES: ReadonlySet<string> = new Set(SANCTIONS_NEAR_MATCHES.map((m) => m.name));

export function trafficPayments(pack: ScenarioPack, e: Extract<PackEvent, { type: 'traffic' }>): CraftedPayment[] {
  const c = corridorById(e.corridor);
  if (!c) throw new Error(`${pack.name}: unknown corridor "${e.corridor}"`);
  const rand = rng(fnv(`${pack.seed ?? pack.name}:${e.label}`));
  const tag = e.label.replace(/-/g, '').toUpperCase();
  const out: CraftedPayment[] = [];
  for (let i = 0; i < e.count; i++) {
    const n = String(i + 1).padStart(3, '0');
    let debtor = person(rand, c.sourceCountry, `SIM-${c.sourceCountry}-{run}-${tag}D${n}`);
    let creditor = person(rand, c.targetCountry, `SIM-${c.targetCountry}-{run}-${tag}C${n}`);
    if (e.listedParty && i < e.listedParty.count) {
      if (e.listedParty.side === 'creditor') creditor = { ...creditor, name: ENTITY_MATCHES[i % ENTITY_MATCHES.length]!.name };
      else debtor = { ...debtor, name: PERSON_MATCHES[i % PERSON_MATCHES.length]!.name };
    }
    const major = e.amountMajor.min + rand() * (e.amountMajor.max - e.amountMajor.min);
    out.push({ amount: { amountMinor: Math.max(1, Math.round(major * 100)), currency: c.sourceCurrency }, targetCurrency: c.targetCurrency, corridor: c.id, debtor, creditor });
  }
  return out;
}

function toAction(pack: ScenarioPack, e: PackEvent): ScenarioAction {
  switch (e.type) {
    case 'traffic':
      return { kind: 'payments.send', label: e.label, payments: trafficPayments(pack, e), spacingMs: e.spacingMs };
    case 'ambient':
      return { kind: 'ambient.rate', rate: e.rate };
    case 'provider_outage':
      return { kind: 'outage.start', providerId: e.providerId, mode: e.mode, ...(e.failureRate !== undefined ? { failureRate: e.failureRate } : {}), reason: e.reason };
    case 'provider_recovery':
      return { kind: 'outage.end', providerId: e.providerId };
    case 'fx_shock':
      return { kind: 'fx_shock.start', shockId: e.shockId, corridorId: e.corridor, driftBps: e.driftBps, noiseMultiplier: e.noiseMultiplier, rampMs: e.rampMs, reason: e.reason };
    case 'fx_shock_end':
      return { kind: 'fx_shock.end', shockId: e.shockId };
  }
}

/** Throws (with the orchestrator's own validateScript message) if the pack cannot run. */
export function compilePack(pack: ScenarioPack): ScenarioScript {
  const script: ScenarioScript = {
    id: pack.name,
    title: pack.title,
    description: pack.description,
    durationMs: pack.durationMs,
    steps: pack.steps.map((s) => ({
      id: s.id,
      atMs: s.atMs,
      title: s.title,
      narration: s.narration,
      ...(s.events?.length ? { actions: s.events.map((e) => toAction(pack, e)) } : {}),
    })),
  };
  validateScript(script);
  return script;
}
