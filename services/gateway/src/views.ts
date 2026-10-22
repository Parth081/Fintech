// Read models for the M2 endpoints, built from the projection plus the simulated market and the
// ISO 20022 builder. Market/ISO functions are injected (tests pass fakes; production uses
// @ct/market and @ct/iso20022) and every call is guarded so a missing implementation degrades
// to partial data instead of a 500.
import { CORRIDORS, PROVIDERS, type PaymentState, type StatementEntry } from '@ct/contracts';
import * as market from '@ct/market';
import * as iso from '@ct/iso20022';
import type { ProviderProfile, ProviderHealth } from '@ct/market';
import type { FxCorridorRates, ProviderView, StatementGroup } from './api-types';
import type { Projection } from './projection';

export interface MarketPort {
  rateAt(corridorId: string, atMs: number, seed?: string): { corridorId: string; mid: string; atMs: number };
  rateSeries(corridorId: string, fromMs: number, toMs: number, stepMs: number, seed?: string): { atMs: number; mid: string }[];
  providerHealth(states: Iterable<PaymentState>, providerId: string): ProviderHealth;
  providerProfile(id: string): ProviderProfile | undefined;
  catalog: readonly ProviderProfile[];
}

/** Input of @ct/iso20022 buildCamt053 (as agreed for M2). */
export interface Camt053Input {
  providerId: string;
  statementId: string;
  accountId: string;
  date: string;
  currency: string;
  entries: StatementEntry[];
  openingBalanceMinor?: number;
}

export interface IsoPort {
  buildCamt053(input: Camt053Input): string;
}

export const defaultMarket: MarketPort = {
  rateAt: market.rateAt,
  rateSeries: market.rateSeries,
  providerHealth: market.providerHealth,
  providerProfile: market.providerProfile,
  catalog: market.PROVIDER_CATALOG,
};

export const defaultIso: IsoPort = {
  buildCamt053(input) {
    // Resolved at call time: @ct/iso20022 is being built in parallel and may not export it yet.
    const fn = (iso as Record<string, unknown>).buildCamt053;
    if (typeof fn !== 'function') throw new Error('buildCamt053 not available in @ct/iso20022');
    const out = (fn as (i: Camt053Input) => unknown)(input);
    if (typeof out === 'string') return out;
    if (out && typeof out === 'object' && typeof (out as { xml?: unknown }).xml === 'string') return (out as { xml: string }).xml;
    throw new Error('buildCamt053 returned no XML');
  },
};

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const FX_SERIES_WINDOW_MS = 15 * 60_000;
export const FX_SERIES_STEP_MS = 15_000;

export function fxRates(projection: Projection, m: MarketPort, seed: string, nowMs: number): FxCorridorRates[] {
  return CORRIDORS.map((c) => {
    const out: FxCorridorRates = {
      corridorId: c.id,
      sourceCurrency: c.sourceCurrency,
      targetCurrency: c.targetCurrency,
      mid: null,
      atMs: nowMs,
      series: [],
      seriesStepMs: FX_SERIES_STEP_MS,
      quotes: projection.quoteStats(c.id),
    };
    try {
      const r = m.rateAt(c.id, nowMs, seed);
      out.mid = r.mid;
      out.atMs = r.atMs;
      const to = Math.floor(nowMs / FX_SERIES_STEP_MS) * FX_SERIES_STEP_MS;
      out.series = m.rateSeries(c.id, to - FX_SERIES_WINDOW_MS, to, FX_SERIES_STEP_MS, seed);
    } catch (err) {
      out.marketError = errMsg(err);
    }
    return out;
  });
}

export function providerViews(projection: Projection, m: MarketPort): ProviderView[] {
  const ids = new Set<string>([...PROVIDERS.map((p) => p.id), ...m.catalog.map((p) => p.id), ...projection.providers.keys()]);
  let totalSettled = 0;
  for (const a of projection.providers.values()) totalSettled += a.settled;
  const refs = projection.statementRefs(); // newest first
  return [...ids].map((id) => {
    const base = PROVIDERS.find((p) => p.id === id);
    const profile = m.providerProfile(id);
    const agg = projection.providers.get(id);
    const settled = agg?.settled ?? 0;
    const sendFailed = agg?.sendFailed ?? 0;
    const view: ProviderView = {
      providerId: id,
      name: profile?.name ?? base?.name ?? id,
      rail: profile?.rail ?? base?.rail ?? '',
      corridors: profile ? Object.keys(profile.fees) : (base?.corridors ?? []),
      catalogue: {
        baseSuccessRate: profile?.baseSuccessRate ?? null,
        latencyMs: profile?.latencyMs ?? null,
        fees: profile?.fees ?? {},
      },
      health: null,
      observed: {
        routed: agg?.routed ?? 0,
        sent: agg?.sent ?? 0,
        settled,
        sendFailed,
        successRate: settled + sendFailed > 0 ? settled / (settled + sendFailed) : null,
        avgLatencyMs: agg && agg.latencyCount > 0 ? Math.round(agg.latencySumMs / agg.latencyCount) : null,
      },
      shareOfVolume: totalSettled > 0 ? settled / totalSettled : 0,
      avgFeeBps: agg && agg.feeBpsCount > 0 ? Math.round((agg.feeBpsSum / agg.feeBpsCount) * 10) / 10 : null,
      avgFee: agg ? [...agg.feeByCurrency].map(([currency, v]) => ({ currency, amountMinor: Math.round(v.sum / v.count) })) : [],
      retriesCaused: sendFailed,
      recentFailures: agg ? [...agg.recentFailures].reverse() : [],
      failureReasons: agg ? { ...agg.failureReasons } : {},
    };
    if (profile?.bic) view.bic = profile.bic;
    try {
      const h = m.providerHealth(projection.states(), id);
      view.health = {
        attempts: h.attempts, settled: h.settled, failed: h.failed, successRate: h.successRate, avgLatencyMs: h.avgLatencyMs,
      };
    } catch (err) {
      view.healthError = errMsg(err);
    }
    const latest = refs.find((r) => r.providerId === id);
    if (latest) view.latestStatement = { date: latest.date, currency: latest.currency };
    return view;
  });
}

export function statementAccountId(providerId: string, currency: string): string {
  return `provider:${providerId}:nostro:${currency}`;
}

/** camt.053 for one statement group. */
export function camt053For(group: StatementGroup, isoPort: IsoPort): string {
  return isoPort.buildCamt053({
    providerId: group.providerId,
    statementId: group.statementId,
    accountId: statementAccountId(group.providerId, group.currency),
    date: group.date,
    currency: group.currency,
    entries: group.list,
  });
}
