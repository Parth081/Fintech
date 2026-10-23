// Main stage: control plane, outage story and degradation logic (pure modules only).
import { describe, expect, it } from 'vitest';
import { PROVIDERS, type BreakerView } from '@ct/contracts/browser';
import { hubStyle, RECOVERED_MS, stageAlert, type HubStyle } from './hubstyle';
import { newerControl, NO_CONTROL, parseControlView, parseTraffic } from './data';
import { pickCounts, sharesOf, TrafficWindow } from './traffic';
import { BACK_MS, RESET_GIVE_UP_MS, RESET_IDLE, stageResetReducer } from './reset';
import { kpiTiles, ledgerBadge } from './panels';
import { StageIngest, type FeedPayment } from './ingest';
import { applyDotEvents, clearDots, createDotEngine, DEFAULT_DOT_CONFIG, type SpawnInfo } from './dots';
import type { Stats } from '../lib/types';

const T0 = Date.parse('2026-10-23T10:00:00Z');
const breaker = (providerId: string, state: BreakerView['state'], extra: Partial<BreakerView> = {}): BreakerView => ({
  providerId, state, since: null, failureRate: 0, attempts: 0, reason: '', ...extra,
});
const SHORT = PROVIDERS.map((p) => ({ id: p.id, name: p.name.replace(/^Provider\s+/i, '') }));
const styles = (o: Record<string, HubStyle>) => ({ orion: hubStyle('orion', undefined), lyra: hubStyle('lyra', undefined), vega: hubStyle('vega', undefined), ...o });

describe('breaker -> hub style over the outage story', () => {
  it('closed -> failing -> open -> half-open -> recovered -> closed', () => {
    const outage = { providerId: 'orion', mode: 'down' as const, reason: 'Scenario', since: '' };
    expect(hubStyle('orion', breaker('orion', 'closed'), undefined, T0).tone).toBe('closed');
    expect(hubStyle('orion', breaker('orion', 'closed'), outage, T0).tone).toBe('failing');
    // an open breaker wins over the outage that caused it
    const open = hubStyle('orion', breaker('orion', 'open'), outage, T0);
    expect(open).toMatchObject({ tone: 'open', label: 'CIRCUIT OPEN', routesMuted: true });
    expect(hubStyle('orion', breaker('orion', 'half-open'), undefined, T0)).toMatchObject({ tone: 'half-open', routesMuted: false });
    const closedAt = new Date(T0).toISOString();
    expect(hubStyle('orion', breaker('orion', 'closed', { since: closedAt }), undefined, T0 + 2000)).toMatchObject({ tone: 'recovered', label: 'RECOVERED', color: 'var(--ok)' });
    expect(hubStyle('orion', breaker('orion', 'closed', { since: closedAt }), undefined, T0 + RECOVERED_MS + 1).tone).toBe('closed');
  });

  it('a garbage "since" is just closed', () => {
    expect(hubStyle('orion', breaker('orion', 'closed', { since: 'nope' }), undefined, T0).tone).toBe('closed');
  });
});

describe('stageAlert (the big map message)', () => {
  it('nothing to say when all is well or unknown', () => {
    expect(stageAlert(styles({}), SHORT)).toBeNull();
    expect(stageAlert(styles({ orion: hubStyle('orion', breaker('orion', 'closed')) }), SHORT)).toBeNull();
  });

  it('open: names the provider and where the traffic went', () => {
    const a = stageAlert(styles({ orion: hubStyle('orion', breaker('orion', 'open')) }), SHORT);
    expect(a).toMatchObject({ tone: 'open', providerId: 'orion', headline: 'ORION · CIRCUIT OPEN', sub: 'Traffic re-routed to Lyra and Vega' });
  });

  it('names only the providers that actually took the traffic, when shares are known', () => {
    const st = styles({ orion: hubStyle('orion', breaker('orion', 'open')) });
    expect(stageAlert(st, SHORT, { orion: 0, lyra: 0, vega: 1 })?.sub).toBe('Traffic re-routed to Vega');
    expect(stageAlert(st, SHORT, { orion: 1 })?.sub).toBe('Traffic re-routed to Lyra and Vega');
  });

  it('the most serious state wins', () => {
    const a = stageAlert(styles({ lyra: hubStyle('lyra', breaker('lyra', 'half-open')), vega: hubStyle('vega', breaker('vega', 'open')) }), SHORT);
    expect(a?.providerId).toBe('vega');
    expect(a?.sub).toBe('Traffic re-routed to Orion and Lyra');
  });

  it('failing, half-open and recovered have their own wording', () => {
    const fail = stageAlert(styles({ orion: hubStyle('orion', undefined, { providerId: 'orion', mode: 'down', reason: '', since: '' }) }), SHORT);
    expect(fail?.headline).toBe('ORION IS FAILING');
    expect(stageAlert(styles({ orion: hubStyle('orion', breaker('orion', 'half-open')) }), SHORT)?.headline).toBe('ORION · HALF-OPEN');
    const rec = hubStyle('orion', breaker('orion', 'closed', { since: new Date(T0).toISOString() }), undefined, T0 + 10);
    expect(stageAlert(styles({ orion: rec }), SHORT)?.headline).toBe('ORION RECOVERED');
  });

  it('every provider open: no false promise of a re-route', () => {
    const all = Object.fromEntries(PROVIDERS.map((p) => [p.id, hubStyle(p.id, breaker(p.id, 'open'))]));
    expect(stageAlert(all, SHORT)?.sub).toBe('Traffic held until a provider recovers');
  });
});

describe('control view parsing and merging', () => {
  const view = (atMs: number, state: BreakerView['state']) => ({
    control: { outages: {}, scenario: { runId: 'r', scenarioId: 'provider-outage', title: 'Provider outage', startedAt: '', step: { stepId: 's2', title: 'Breaker trips', at: '' } }, speed: null, paused: false, lastOffset: 4 },
    breakers: [breaker('orion', state)],
    orchestrator: null,
    resetAvailable: true,
    atMs,
    traffic: {
      bucketMs: 5000, buckets: 3, fromMs: 0, toMs: 15000,
      providers: [
        { providerId: 'orion', firstAttempt: [3, 2, 0], rerouted: [0, 0, 0], failed: [0, 2, 0], settled: [3, 0, 0], total: {} },
        { providerId: 'lyra', firstAttempt: [1, 1, 2], rerouted: [0, 2, 1], failed: [0, 0, 0], settled: [1, 3, 3], total: {} },
      ],
    },
    reroutes: [],
  });

  it('reads gateway extras: clock and per-provider routing counts', () => {
    const v = parseControlView(view(T0, 'open'))!;
    expect(v.atMs).toBe(T0);
    expect(v.traffic).toEqual({ orion: 5, lyra: 7 });
    expect(v.control.scenario?.step?.title).toBe('Breaker trips');
  });

  it('tolerates a view without traffic or clock, and bad traffic rows', () => {
    const v = parseControlView({ breakers: [], control: {} })!;
    expect(v.atMs).toBe(0);
    expect(v.traffic).toBeNull();
    expect(parseTraffic({ providers: [null, { providerId: 7 }, { providerId: 'x', firstAttempt: ['a', 2, null] }] })).toEqual({ x: 2 });
    expect(parseTraffic('x')).toBeNull();
  });

  it('newest view wins regardless of arrival order (WS push vs poll)', () => {
    const older = parseControlView(view(T0, 'open'));
    const newer = parseControlView(view(T0 + 1000, 'half-open'));
    expect(newerControl(older, newer)?.breakers[0]?.state).toBe('half-open');
    expect(newerControl(newer, older)?.breakers[0]?.state).toBe('half-open');
    expect(newerControl(null, older)).toBe(older);
    expect(newerControl(older, null)).toBe(older);
    // a gateway without a clock: the later arrival wins
    expect(newerControl(older, NO_CONTROL)).toBe(NO_CONTROL);
  });
});

describe('traffic share', () => {
  it('a short window shows the re-route right away; the minute window lags', () => {
    const w = new TrafficWindow(60_000, 1000);
    for (let s = 0; s < 40; s++) w.record('orion', s * 1000);
    for (let s = 40; s < 55; s++) w.record('lyra', s * 1000);
    const now = 54_500;
    expect(sharesOf(w.counts(now, 15_000), ['orion', 'lyra']).map((x) => x.share)).toEqual([0, 1]);
    expect(sharesOf(w.counts(now), ['orion', 'lyra'])[0]?.share).toBeCloseTo(40 / 55, 6);
    // the window can't be widened beyond what is kept
    expect(w.counts(now, 600_000)).toEqual(w.counts(now));
  });

  it('prefers the gateway meter once it reports traffic, else local counts', () => {
    expect(pickCounts({ orion: 2 }, { lyra: 5 })).toEqual({ orion: 2 });
    expect(pickCounts({ orion: 0 }, { lyra: 5 })).toEqual({ lyra: 5 });
    expect(pickCounts(null, { lyra: 5 })).toEqual({ lyra: 5 });
  });
});

describe('reset notice', () => {
  it('resetting -> back on the next snapshot -> idle', () => {
    let s = stageResetReducer(RESET_IDLE, { type: 'reset', failed: false, nowMs: 0 });
    expect(s.phase).toBe('resetting');
    s = stageResetReducer(s, { type: 'tick', nowMs: 5000 });
    expect(s.phase).toBe('resetting');
    s = stageResetReducer(s, { type: 'snapshot', nowMs: 9000 });
    expect(s.phase).toBe('back');
    s = stageResetReducer(s, { type: 'tick', nowMs: 9000 + BACK_MS + 1 });
    expect(s).toEqual(RESET_IDLE);
  });

  it('a failed reset or one that never finishes drops the notice; ordinary snapshots do nothing', () => {
    const r = stageResetReducer(RESET_IDLE, { type: 'reset', failed: false, nowMs: 0 });
    expect(stageResetReducer(r, { type: 'reset', failed: true, nowMs: 10 })).toEqual(RESET_IDLE);
    expect(stageResetReducer(r, { type: 'tick', nowMs: RESET_GIVE_UP_MS + 1 })).toEqual(RESET_IDLE);
    expect(stageResetReducer(RESET_IDLE, { type: 'snapshot', nowMs: 1 })).toEqual(RESET_IDLE);
    // a repeated reset notice does not restart the clock
    expect(stageResetReducer(r, { type: 'reset', failed: false, nowMs: 999 })).toBe(r);
  });

  it('StageIngest.reset forgets dots, traffic and payments', () => {
    const s = new StageIngest({ routes: new Map([['US-IN:orion', { hubT: 0.4 }]]) });
    s.apply({ kind: 'update', payments: [{ paymentId: 'p', corridor: 'US-IN', status: 'routed', providerId: 'orion' }], events: [{ type: 'payment.routed', paymentId: 'p' }] }, 1000);
    expect(s.engine.dots).toHaveLength(1);
    s.reset();
    expect(s.engine.dots).toHaveLength(0);
    expect(s.engine.active.size).toBe(0);
    expect(s.refCount).toBe(0);
    expect(s.traffic.counts(1000)).toEqual({});
    // a late outcome for a forgotten payment is harmless
    s.apply({ kind: 'update', payments: [], events: [{ type: 'payment.settled', paymentId: 'p' }] }, 1100);
    expect(s.engine.dots).toHaveLength(0);
  });

  it('clearDots keeps ids increasing', () => {
    const e = createDotEngine();
    const info: SpawnInfo = { routeKey: 'US-IN:orion', providerId: 'orion', hubT: 0.4 };
    applyDotEvents(e, [{ type: 'payment.routed', paymentId: 'a' }], () => info, DEFAULT_DOT_CONFIG);
    clearDots(e);
    applyDotEvents(e, [{ type: 'payment.routed', paymentId: 'b' }], () => info, DEFAULT_DOT_CONFIG);
    expect(e.dots[0]?.id).toBe(2);
  });
});

describe('side panel', () => {
  it('KPI tiles show dashes without stats and highlight retries / losses', () => {
    expect(kpiTiles(null).map((t) => t.value)).toEqual(['—', '—', '—', '—']);
    const stats = { reconciled: 1234, retriesTotal: 7, failed: 0, throughput: { paymentsPerMin: 240 } } as unknown as Stats;
    const tiles = Object.fromEntries(kpiTiles(stats).map((t) => [t.key, t]));
    expect(tiles.retries).toMatchObject({ value: '7', tone: 'warn' });
    expect(tiles.lost).toMatchObject({ value: '0', tone: 'ok' });
    expect(tiles.ppm?.value).toBe('240');
  });

  it('ledger badge: green balanced, red not balanced, hidden when unavailable', () => {
    expect(ledgerBadge({ balanced: true, journals: 12 })).toMatchObject({ tone: 'ok', mark: '✓', title: 'Ledger Balanced' });
    expect(ledgerBadge({ balanced: false, journals: 12 })?.tone).toBe('bad');
    expect(ledgerBadge(null)).toBeNull();
    expect(ledgerBadge({ error: 'not found' } as never)).toBeNull();
  });
});

describe('outage story through the feed', () => {
  const routes = new Map([
    ['GB-PH:orion', { hubT: 0.35 }],
    ['GB-PH:vega', { hubT: 0.3 }],
    ['GB-PH:lyra', { hubT: 0.45 }],
  ]);
  const pay = (id: string, status: FeedPayment['status'], providerId: string): FeedPayment => ({ paymentId: id, corridor: 'GB-PH', status, providerId });

  it('many payments rejected at Orion bounce at its hub and re-appear on other providers; shares move', () => {
    const s = new StageIngest({ routes });
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    s.apply({ kind: 'update', payments: ids.map((id) => pay(id, 'sent', 'orion')), events: ids.flatMap((id) => [{ type: 'payment.routed', paymentId: id }, { type: 'payment.sent', paymentId: id }]) }, 0);
    expect(s.engine.dots.every((d) => d.providerId === 'orion')).toBe(true);
    s.apply({ kind: 'update', payments: ids.map((id) => pay(id, 'retrying', 'orion')), events: ids.map((id) => ({ type: 'payment.send_failed', paymentId: id })) }, 500);
    expect(s.engine.dots.every((d) => d.phase === 'failing')).toBe(true);
    // each failing dot heads for Orion's hub, not the destination
    expect(s.engine.dots.every((d) => d.stopAt === 0.35)).toBe(true);
    s.apply({ kind: 'update', payments: ids.map((id, i) => pay(id, 'routed', i % 2 ? 'lyra' : 'vega')), events: ids.map((id) => ({ type: 'payment.routed', paymentId: id })) }, 1000);
    const live = [...s.engine.active.values()];
    expect(live).toHaveLength(10);
    expect(new Set(live.map((d) => d.providerId))).toEqual(new Set(['lyra', 'vega']));
    expect(s.traffic.counts(1000)).toEqual({ orion: 10, lyra: 5, vega: 5 });
  });
});
