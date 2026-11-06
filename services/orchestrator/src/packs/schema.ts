// Prospect scenario packs (ADR 0022): a declarative, typed description of one prospect-specific scenario.
// A pack is plain JSON. It is validated here, compiled into the existing ScenarioScript (compile.ts) and then
// run by the unchanged orchestrator, so a new pack never needs a code change to a pipeline stage.
//
// What a pack can express: narration steps, traffic per corridor, provider outages and recoveries, FX shocks,
// listed-party (sanctions near-match) payments, ambient rate, and the outcomes the team expects to see.
// What it cannot: approved configuration changes (maker-checker, ops console) - those are not scenario actions.
import { PROVIDERS, corridorById } from '@ct/contracts';

export const PACK_SCHEMA_VERSION = 1 as const;
export const PACK_AUDIENCES = ['psp', 'bank', 'marketplace'] as const;
export type PackAudience = (typeof PACK_AUDIENCES)[number];

export type PackEvent =
  /** `count` synthetic payments on one corridor, one every `spacingMs`, amounts drawn from the range. */
  | {
      type: 'traffic';
      label: string;
      corridor: string;
      count: number;
      amountMajor: { min: number; max: number };
      spacingMs: number;
      /** The first `count` payments name a party that closely resembles a (fictional) sanctions-list entry. */
      listedParty?: { side: 'creditor' | 'debtor'; count: number };
    }
  | { type: 'ambient'; rate: number }
  | { type: 'provider_outage'; providerId: string; mode: 'down' | 'degraded'; failureRate?: number; reason: string }
  | { type: 'provider_recovery'; providerId: string }
  | { type: 'fx_shock'; shockId: string; corridor: string; driftBps: number; noiseMultiplier: number; rampMs: number; reason: string }
  | { type: 'fx_shock_end'; shockId: string };

export interface PackStep {
  id: string;
  atMs: number;
  title: string;
  narration: string;
  events?: PackEvent[];
}

/** A machine-checkable part of an expectation; without `check` the expectation is confirmed by a person in a live run. */
export type PackCheck =
  | { kind: 'payments'; min: number; corridor?: string }
  | { kind: 'listed-parties'; min: number }
  | { kind: 'event'; type: 'provider_outage.started' | 'provider_outage.ended' | 'fx_shock.started' | 'fx_shock.ended' };

export interface PackExpectation {
  id: string;
  text: string;
  check?: PackCheck;
}

export interface ScenarioPack {
  schemaVersion: typeof PACK_SCHEMA_VERSION;
  /** Lower-case slug; becomes the scenario id shown in the presenter console. */
  name: string;
  title: string;
  audience: PackAudience;
  description: string;
  durationMs: number;
  /** Optional text that seeds the generated traffic (default: the pack name). */
  seed?: string;
  steps: PackStep[];
  expected: PackExpectation[];
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SLUG_RE = /^[a-z0-9-]{1,24}$/;
export const MIN_DURATION_MS = 10_000;
export const MAX_DURATION_MS = 300_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ParseResult {
  pack?: ScenarioPack;
  errors: string[];
}

/** Validates unknown JSON. Never throws; every problem is reported with its path so a person can fix it. */
export function parsePack(input: unknown): ParseResult {
  const errors: string[] = [];
  const err = (p: string, m: string): void => void errors.push(`${p}: ${m}`);
  if (!isObj(input)) return { errors: ['pack: must be a JSON object'] };

  const str = (o: Record<string, unknown>, k: string, p: string, max: number, min = 1): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim().length < min) {
      err(`${p}.${k}`, `must be text of at least ${min} character(s)`);
      return '';
    }
    if (v.length > max) err(`${p}.${k}`, `is ${v.length} characters; the limit is ${max}`);
    return v;
  };
  const num = (o: Record<string, unknown>, k: string, p: string, lo: number, hi: number, integer = true): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) {
      err(`${p}.${k}`, `must be ${integer ? 'a whole number' : 'a number'} from ${lo} to ${hi}`);
      return lo;
    }
    return v;
  };
  const unknownKeys = (o: Record<string, unknown>, allowed: string[], p: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${p}.${k}`, 'is not a known field');
  };

  function parseEvent(raw: unknown, p: string, out: PackEvent[]): void {
    if (!isObj(raw)) return err(p, 'must be an object');
    switch (raw.type) {
      case 'traffic': {
        unknownKeys(raw, ['type', 'label', 'corridor', 'count', 'amountMajor', 'spacingMs', 'listedParty'], p);
        const label = str(raw, 'label', p, 24);
        if (label && !SLUG_RE.test(label)) err(`${p}.label`, 'must be a short lower-case slug');
        const corridor = typeof raw.corridor === 'string' ? raw.corridor : '';
        if (!corridorById(corridor)) err(`${p}.corridor`, 'is not a known corridor (US-IN, DE-BR or GB-PH)');
        const count = num(raw, 'count', p, 1, 50);
        let amountMajor = { min: 1, max: 1 };
        if (!isObj(raw.amountMajor)) err(`${p}.amountMajor`, 'must be { "min": n, "max": n } in major currency units');
        else {
          const min = num(raw.amountMajor, 'min', `${p}.amountMajor`, 1, 1_000_000);
          const max = num(raw.amountMajor, 'max', `${p}.amountMajor`, 1, 1_000_000);
          if (max < min) err(`${p}.amountMajor`, 'max must not be below min');
          amountMajor = { min, max };
        }
        const spacingMs = num(raw, 'spacingMs', p, 0, 60_000);
        let listedParty: { side: 'creditor' | 'debtor'; count: number } | undefined;
        if (raw.listedParty !== undefined) {
          const lp = raw.listedParty;
          if (!isObj(lp) || (lp.side !== 'creditor' && lp.side !== 'debtor')) err(`${p}.listedParty`, 'must be { "side": "creditor" | "debtor", "count": n }');
          else {
            const n = num(lp, 'count', `${p}.listedParty`, 1, 50);
            if (n > count) err(`${p}.listedParty.count`, 'cannot exceed the number of payments');
            listedParty = { side: lp.side, count: n };
          }
        }
        out.push({ type: 'traffic', label, corridor, count, amountMajor, spacingMs, ...(listedParty ? { listedParty } : {}) });
        return;
      }
      case 'ambient':
        unknownKeys(raw, ['type', 'rate'], p);
        out.push({ type: 'ambient', rate: num(raw, 'rate', p, 0, 50, false) });
        return;
      case 'provider_outage': {
        unknownKeys(raw, ['type', 'providerId', 'mode', 'failureRate', 'reason'], p);
        const providerId = typeof raw.providerId === 'string' ? raw.providerId : '';
        if (!PROVIDERS.some((x) => x.id === providerId)) err(`${p}.providerId`, `must be one of ${PROVIDERS.map((x) => x.id).join(', ')}`);
        if (raw.mode !== 'down' && raw.mode !== 'degraded') err(`${p}.mode`, 'must be "down" or "degraded"');
        const reason = str(raw, 'reason', p, 120);
        let failureRate: number | undefined;
        if (raw.mode === 'degraded') failureRate = num(raw, 'failureRate', p, 0.05, 0.95, false);
        else if (raw.failureRate !== undefined) err(`${p}.failureRate`, 'only applies to mode "degraded"');
        out.push({ type: 'provider_outage', providerId, mode: raw.mode === 'degraded' ? 'degraded' : 'down', ...(failureRate !== undefined ? { failureRate } : {}), reason });
        return;
      }
      case 'provider_recovery': {
        unknownKeys(raw, ['type', 'providerId'], p);
        const providerId = typeof raw.providerId === 'string' ? raw.providerId : '';
        if (!PROVIDERS.some((x) => x.id === providerId)) err(`${p}.providerId`, `must be one of ${PROVIDERS.map((x) => x.id).join(', ')}`);
        out.push({ type: 'provider_recovery', providerId });
        return;
      }
      case 'fx_shock': {
        unknownKeys(raw, ['type', 'shockId', 'corridor', 'driftBps', 'noiseMultiplier', 'rampMs', 'reason'], p);
        const shockId = str(raw, 'shockId', p, 24);
        if (shockId && !SLUG_RE.test(shockId)) err(`${p}.shockId`, 'must be a short lower-case slug');
        const corridor = typeof raw.corridor === 'string' ? raw.corridor : '';
        if (!corridorById(corridor)) err(`${p}.corridor`, 'is not a known corridor (US-IN, DE-BR or GB-PH)');
        out.push({
          type: 'fx_shock',
          shockId,
          corridor,
          driftBps: num(raw, 'driftBps', p, -1000, 1000, false),
          noiseMultiplier: num(raw, 'noiseMultiplier', p, 1, 10, false),
          rampMs: num(raw, 'rampMs', p, 0, 60_000),
          reason: str(raw, 'reason', p, 120),
        });
        return;
      }
      case 'fx_shock_end':
        unknownKeys(raw, ['type', 'shockId'], p);
        out.push({ type: 'fx_shock_end', shockId: str(raw, 'shockId', p, 24) });
        return;
      default:
        err(`${p}.type`, 'must be traffic, ambient, provider_outage, provider_recovery, fx_shock or fx_shock_end');
    }
  }

  unknownKeys(input, ['schemaVersion', 'name', 'title', 'audience', 'description', 'durationMs', 'seed', 'steps', 'expected'], 'pack');
  if (input.schemaVersion !== PACK_SCHEMA_VERSION) err('pack.schemaVersion', `must be ${PACK_SCHEMA_VERSION}`);
  const name = str(input, 'name', 'pack', 40);
  if (name && !NAME_RE.test(name)) err('pack.name', 'must be a lower-case slug of 3 to 40 characters (letters, digits, dashes)');
  const title = str(input, 'title', 'pack', 80);
  const description = str(input, 'description', 'pack', 600);
  const audience = input.audience;
  if (typeof audience !== 'string' || !(PACK_AUDIENCES as readonly string[]).includes(audience)) err('pack.audience', `must be one of ${PACK_AUDIENCES.join(', ')}`);
  const durationMs = num(input, 'durationMs', 'pack', MIN_DURATION_MS, MAX_DURATION_MS);
  if (input.seed !== undefined && (typeof input.seed !== 'string' || input.seed.length === 0 || input.seed.length > 64)) err('pack.seed', 'must be text of 1 to 64 characters');

  const steps: PackStep[] = [];
  if (!Array.isArray(input.steps) || input.steps.length < 3 || input.steps.length > 20) err('pack.steps', 'must be a list of 3 to 20 steps');
  else {
    input.steps.forEach((raw: unknown, i: number) => {
      const p = `pack.steps[${i}]`;
      if (!isObj(raw)) return err(p, 'must be an object');
      unknownKeys(raw, ['id', 'atMs', 'title', 'narration', 'events'], p);
      const id = str(raw, 'id', p, 24);
      if (id && !SLUG_RE.test(id)) err(`${p}.id`, 'must be a short lower-case slug');
      const atMs = num(raw, 'atMs', p, 0, MAX_DURATION_MS);
      const stepTitle = str(raw, 'title', p, 80);
      const narration = str(raw, 'narration', p, 500, 10);
      const events: PackEvent[] = [];
      if (raw.events !== undefined) {
        if (!Array.isArray(raw.events)) err(`${p}.events`, 'must be a list');
        else raw.events.forEach((e: unknown, j: number) => parseEvent(e, `${p}.events[${j}]`, events));
      }
      steps.push({ id, atMs, title: stepTitle, narration, ...(events.length ? { events } : {}) });
    });
  }

  const expected: PackExpectation[] = [];
  if (!Array.isArray(input.expected) || input.expected.length < 1 || input.expected.length > 12) err('pack.expected', 'must list 1 to 12 expected outcomes');
  else {
    const seen = new Set<string>();
    input.expected.forEach((raw: unknown, i: number) => {
      const p = `pack.expected[${i}]`;
      if (!isObj(raw)) return err(p, 'must be an object');
      unknownKeys(raw, ['id', 'text', 'check'], p);
      const id = str(raw, 'id', p, 24);
      if (id && !SLUG_RE.test(id)) err(`${p}.id`, 'must be a short lower-case slug');
      if (seen.has(id)) err(`${p}.id`, `duplicate expectation id "${id}"`);
      seen.add(id);
      const text = str(raw, 'text', p, 300, 10);
      let check: PackCheck | undefined;
      if (raw.check !== undefined) {
        const c = raw.check;
        if (!isObj(c)) err(`${p}.check`, 'must be an object');
        else if (c.kind === 'payments') {
          unknownKeys(c, ['kind', 'min', 'corridor'], `${p}.check`);
          const min = num(c, 'min', `${p}.check`, 1, 10_000);
          if (c.corridor !== undefined && (typeof c.corridor !== 'string' || !corridorById(c.corridor))) err(`${p}.check.corridor`, 'is not a known corridor');
          check = { kind: 'payments', min, ...(typeof c.corridor === 'string' ? { corridor: c.corridor } : {}) };
        } else if (c.kind === 'listed-parties') {
          unknownKeys(c, ['kind', 'min'], `${p}.check`);
          check = { kind: 'listed-parties', min: num(c, 'min', `${p}.check`, 1, 10_000) };
        } else if (c.kind === 'event') {
          unknownKeys(c, ['kind', 'type'], `${p}.check`);
          const t = c.type;
          if (t !== 'provider_outage.started' && t !== 'provider_outage.ended' && t !== 'fx_shock.started' && t !== 'fx_shock.ended') err(`${p}.check.type`, 'must be provider_outage.started, provider_outage.ended, fx_shock.started or fx_shock.ended');
          else check = { kind: 'event', type: t };
        } else err(`${p}.check.kind`, 'must be payments, listed-parties or event');
      }
      expected.push({ id, text, ...(check ? { check } : {}) });
    });
  }

  if (errors.length > 0) return { errors };
  return {
    pack: {
      schemaVersion: PACK_SCHEMA_VERSION,
      name,
      title,
      audience: audience as PackAudience,
      description,
      durationMs,
      ...(typeof input.seed === 'string' ? { seed: input.seed } : {}),
      steps,
      expected,
    },
    errors,
  };
}
