// Validation of proposed configuration values (maker-checker change requests). Shape + sane ranges per key.
// Returns the normalised value that will be published (provider maps are merged onto the current value so
// a change may name only the providers it touches).
import { CORRIDORS, PROVIDERS, type ConfigKey, type ConfigValues } from '@ct/contracts';

export const CONFIG_KEYS: readonly ConfigKey[] = ['risk.thresholds', 'risk.manualReviewAboveUsd', 'routing.weights', 'provider.enabled', 'provider.forcedBreaker'];

export function isConfigKey(v: unknown): v is ConfigKey {
  return typeof v === 'string' && (CONFIG_KEYS as readonly string[]).includes(v);
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

function exactKeys(v: Record<string, unknown>, keys: string[], errors: string[]): void {
  for (const k of keys) if (!(k in v)) errors.push(`missing field "${k}"`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) errors.push(`unknown field "${k}"`);
}

/** Providers that can actually carry traffic for every corridor under the given switches. */
function corridorCoverage(enabled: Record<string, boolean>, forced: Record<string, 'open' | null>): string[] {
  const errors: string[] = [];
  for (const c of CORRIDORS) {
    const usable = PROVIDERS.filter((p) => p.corridors.includes(c.id) && enabled[p.id] !== false && forced[p.id] !== 'open');
    if (usable.length === 0) errors.push(`corridor ${c.id} would have no usable provider`);
  }
  return errors;
}

export function validateConfigValue(key: ConfigKey, proposed: unknown, current: ConfigValues): ValidationResult {
  const errors: string[] = [];
  switch (key) {
    case 'risk.thresholds': {
      if (!isObj(proposed)) return { ok: false, errors: ['expected { hold, reject }'] };
      exactKeys(proposed, ['hold', 'reject'], errors);
      const { hold, reject } = proposed;
      if (!isNum(hold) || hold < 0.05 || hold > 0.99) errors.push('hold must be a number between 0.05 and 0.99');
      if (!isNum(reject) || reject < 0.1 || reject > 1) errors.push('reject must be a number between 0.10 and 1.00');
      if (isNum(hold) && isNum(reject) && !(hold < reject)) errors.push('hold must be lower than reject');
      return errors.length ? { ok: false, errors } : { ok: true, value: { hold, reject } };
    }
    case 'risk.manualReviewAboveUsd': {
      if (!isNum(proposed) || !Number.isInteger(proposed) || proposed < 0 || proposed > 10_000_000) {
        return { ok: false, errors: ['expected an integer USD amount between 0 (off) and 10,000,000'] };
      }
      return { ok: true, value: proposed };
    }
    case 'routing.weights': {
      if (!isObj(proposed)) return { ok: false, errors: ['expected { success, cost, speed }'] };
      exactKeys(proposed, ['success', 'cost', 'speed'], errors);
      for (const k of ['success', 'cost', 'speed'] as const) {
        const v = proposed[k];
        if (!isNum(v) || v < 0 || v > 1) errors.push(`${k} must be a number between 0 and 1`);
      }
      const sum = ['success', 'cost', 'speed'].reduce((s, k) => s + (isNum(proposed[k]) ? (proposed[k] as number) : 0), 0);
      if (!(sum > 0)) errors.push('at least one weight must be positive');
      return errors.length ? { ok: false, errors } : { ok: true, value: { success: proposed.success, cost: proposed.cost, speed: proposed.speed } };
    }
    case 'provider.enabled': {
      if (!isObj(proposed) || Object.keys(proposed).length === 0) return { ok: false, errors: ['expected { <providerId>: boolean }'] };
      for (const [k, v] of Object.entries(proposed)) {
        if (!PROVIDER_IDS.includes(k)) errors.push(`unknown provider "${k}"`);
        if (typeof v !== 'boolean') errors.push(`provider "${k}" must be true or false`);
      }
      if (errors.length) return { ok: false, errors };
      const merged = { ...current['provider.enabled'], ...(proposed as Record<string, boolean>) };
      const cov = corridorCoverage(merged, current['provider.forcedBreaker']);
      return cov.length ? { ok: false, errors: cov } : { ok: true, value: merged };
    }
    case 'provider.forcedBreaker': {
      if (!isObj(proposed) || Object.keys(proposed).length === 0) return { ok: false, errors: ['expected { <providerId>: "open" | null }'] };
      for (const [k, v] of Object.entries(proposed)) {
        if (!PROVIDER_IDS.includes(k)) errors.push(`unknown provider "${k}"`);
        if (v !== 'open' && v !== null) errors.push(`provider "${k}" must be "open" or null (automatic)`);
      }
      if (errors.length) return { ok: false, errors };
      const merged: Record<string, 'open' | null> = { ...current['provider.forcedBreaker'], ...(proposed as Record<string, 'open' | null>) };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      const cov = corridorCoverage(current['provider.enabled'], merged);
      return cov.length ? { ok: false, errors: cov } : { ok: true, value: merged };
    }
    default:
      return { ok: false, errors: [`unknown config key "${String(key)}"`] };
  }
}

/** Stable JSON (sorted keys) for equality checks. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
