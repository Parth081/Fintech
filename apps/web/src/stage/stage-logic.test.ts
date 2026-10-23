import { describe, expect, it } from 'vitest';
import type { BreakerView, ProviderOutage } from '@ct/contracts/browser';
import { breakerMap, hubStyle } from './hubstyle';
import { percentLabels, sharesOf, TrafficWindow } from './traffic';
import { PENDING_MS, StageIngest, type FeedPayment } from './ingest';
import { DEFAULT_DOT_CONFIG } from './dots';
import { parseControlView } from './data';

const breaker = (state: BreakerView['state'], extra: Partial<BreakerView> = {}): BreakerView => ({
  providerId: 'orion', state, since: null, failureRate: 0, attempts: 0, reason: '', ...extra,
});

describe('hubStyle', () => {
  it('open breaker: red CIRCUIT OPEN, routes muted', () => {
    const s = hubStyle('orion', breaker('open', { reason: '5 of the last 6 instructions rejected' }));
    expect(s).toMatchObject({ tone: 'open', label: 'CIRCUIT OPEN', color: 'var(--bad)', routesMuted: true, alert: true });
    expect(s.detail).toContain('5 of the last 6');
  });

  it('half-open: amber probing, routes live', () => {
    expect(hubStyle('orion', breaker('half-open'))).toMatchObject({ tone: 'half-open', color: 'var(--warn)', routesMuted: false, alert: true });
  });

  it('closed but an outage is injected: failing', () => {
    const outage: ProviderOutage = { providerId: 'orion', mode: 'down', reason: 'x', since: '' };
    expect(hubStyle('orion', breaker('closed'), outage)).toMatchObject({ tone: 'failing', label: 'FAILING', routesMuted: false });
    expect(hubStyle('orion', undefined, { ...outage, mode: 'degraded', failureRate: 0.4 }).detail).toBe('Degraded · 40% failing');
  });

  it('closed: provider colour and success rate', () => {
    const s = hubStyle('lyra', breaker('closed', { providerId: 'lyra', attempts: 20, failureRate: 0.05 }));
    expect(s).toMatchObject({ tone: 'closed', label: 'HEALTHY', color: 'var(--ms-lyra)', alert: false });
    expect(s.detail).toBe('95% success · 20 recent');
  });

  it('no breaker info: no status at all', () => {
    expect(hubStyle('vega', undefined)).toMatchObject({ tone: 'unknown', label: '', color: 'var(--ms-vega)', routesMuted: false });
  });

  it('breakerMap indexes by provider', () => {
    expect(breakerMap([breaker('open')]).get('orion')?.state).toBe('open');
    expect(breakerMap(undefined).size).toBe(0);
  });
});

describe('traffic share', () => {
  it('counts within the sliding window only', () => {
    const w = new TrafficWindow(60_000, 1000);
    w.record('orion', 0);
    w.record('orion', 30_000);
    w.record('lyra', 59_000, 2);
    expect(w.counts(59_500)).toEqual({ orion: 2, lyra: 2 });
    expect(w.counts(61_000)).toEqual({ orion: 1, lyra: 2 });
    expect(w.counts(200_000)).toEqual({});
  });

  it('shares and percent labels add up', () => {
    const s = sharesOf({ orion: 1, lyra: 1, vega: 1 }, ['orion', 'lyra', 'vega']);
    expect(s.map((x) => x.share.toFixed(3))).toEqual(['0.333', '0.333', '0.333']);
    const labels = percentLabels(s);
    expect(labels.reduce((t, l) => t + Number.parseInt(l, 10), 0)).toBe(100);
    expect(percentLabels(sharesOf({}, ['orion']))).toEqual(['—']);
    expect(sharesOf({ orion: 3, lyra: 1 }, ['orion'])[0]?.share).toBe(0.75);
  });
});

describe('StageIngest (feed -> dots + traffic)', () => {
  const routes = new Map([
    ['US-IN:orion', { hubT: 0.4 }],
    ['US-IN:lyra', { hubT: 0.5 }],
  ]);
  const pay = (id: string, status: FeedPayment['status'], providerId?: string): FeedPayment => ({ paymentId: id, corridor: 'US-IN', status, providerId });
  const ev = (type: string, paymentId = 'p1') => ({ type, paymentId });

  it('outage story: rejected at Orion, re-routed to Lyra, traffic share moves', () => {
    const s = new StageIngest({ routes });
    s.apply({ kind: 'update', payments: [pay('p1', 'routed', 'orion')], events: [ev('payment.routed')] }, 1000);
    s.apply({ kind: 'update', payments: [pay('p1', 'sent', 'orion')], events: [ev('payment.sent')] }, 1400);
    s.apply({ kind: 'update', payments: [pay('p1', 'retrying', 'orion')], events: [ev('payment.send_failed')] }, 1800);
    expect(s.engine.dots[0]?.phase).toBe('failing');
    s.apply({ kind: 'update', payments: [pay('p1', 'routed', 'lyra')], events: [ev('payment.routed')] }, 2200);
    expect(s.engine.active.get('p1')?.providerId).toBe('lyra');
    expect(s.traffic.counts(2200)).toEqual({ orion: 1, lyra: 1 });
    s.apply({ kind: 'update', payments: [pay('p1', 'settled', 'lyra')], events: [ev('payment.settled')] }, 4000);
    s.apply({ kind: 'update', payments: [pay('p1', 'reconciled', 'lyra')], events: [ev('payment.reconciled')] }, 4400);
    expect(s.engine.active.size).toBe(0);
    expect(s.refCount).toBe(0);
  });

  it('holds an event until its summary arrives (capped frames), then gives up after PENDING_MS', () => {
    const s = new StageIngest({ routes });
    s.apply({ kind: 'update', payments: [], events: [ev('payment.routed', 'a'), ev('payment.sent', 'a'), ev('payment.routed', 'b')] }, 0);
    expect(s.engine.dots).toHaveLength(0);
    expect(s.pendingCount).toBe(3);
    s.apply({ kind: 'update', payments: [pay('a', 'sent', 'orion')], events: [] }, 50);
    expect(s.engine.dots).toHaveLength(1);
    expect(s.pendingCount).toBe(1);
    s.apply({ kind: 'update', payments: [], events: [] }, PENDING_MS + 100);
    expect(s.pendingCount).toBe(0);
  });

  it('marks probes and ignores routes the map does not know', () => {
    const s = new StageIngest({ routes, isProbe: (p) => p === 'orion', config: DEFAULT_DOT_CONFIG });
    s.apply({ kind: 'snapshot', payments: [pay('a', 'routed', 'orion'), { ...pay('b', 'routed', 'vega') }] }, 0);
    s.apply({ kind: 'update', payments: [], events: [ev('payment.sent', 'a'), ev('payment.sent', 'b')] }, 10);
    expect(s.engine.dots).toHaveLength(1);
    expect(s.engine.dots[0]?.probe).toBe(true);
  });
});

describe('parseControlView', () => {
  it('accepts a ControlView and tolerates missing parts', () => {
    const v = parseControlView({ breakers: [breaker('open')], control: { outages: {}, scenario: null, speed: null, paused: false, lastOffset: 3 }, orchestrator: null, resetAvailable: false });
    expect(v?.breakers[0]?.state).toBe('open');
    expect(parseControlView({ breakers: [{ providerId: 'x', state: 'weird' }] })?.breakers).toEqual([]);
    expect(parseControlView({})?.control.outages).toEqual({});
    expect(parseControlView('nope')).toBeNull();
  });
});
