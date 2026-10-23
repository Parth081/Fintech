import { describe, expect, it } from 'vitest';
import { INITIAL_CONTROL_STATE, type ControlState, type OrchestratorState } from '@ct/contracts/browser';
import {
  ambientPresetFor,
  bannerFor,
  breakerSentence,
  breakerTone,
  explanationTarget,
  formatCountdown,
  providerStatusRows,
  RESET_GIVE_UP_MS,
  resetReducer,
  scenarioProgress,
  type ResetState,
} from './control';
import { parseFrame } from './api';
import { applyMessage, initialFeed } from './feed';
import { parseHash } from './route';
import type { GatewayControlView, Health } from './types';

const T0 = Date.parse('2026-10-22T09:00:00.000Z');

const ORCH: OrchestratorState = {
  ambient: { rate: 2, running: true, sent: 0 },
  pace: 'normal',
  paused: false,
  scenarios: [
    {
      id: 'provider-outage',
      title: 'Provider outage',
      description: 'Orion goes down',
      durationMs: 60_000,
      steps: [
        { id: 'calm', atMs: 0, title: 'Calm', narration: 'All three providers are healthy.' },
        { id: 'down', atMs: 10_000, title: 'Orion goes down', narration: 'Watch Orion turn red.' },
        { id: 'recover', atMs: 40_000, title: 'Recovery' },
      ],
    },
  ],
  activeRun: null,
};

function view(over: Partial<GatewayControlView> = {}, control: Partial<ControlState> = {}): GatewayControlView {
  return {
    control: { ...INITIAL_CONTROL_STATE, ...control },
    breakers: [],
    orchestrator: ORCH,
    resetAvailable: true,
    atMs: T0,
    traffic: { bucketMs: 5000, buckets: 12, fromMs: T0 - 60_000, toMs: T0, providers: [] },
    reroutes: [],
    ...over,
  };
}

const running = (elapsedMs: number, stepId: string | null, paused = false): GatewayControlView =>
  view({ orchestrator: { ...ORCH, paused, activeRun: { runId: 'r1', scenarioId: 'provider-outage', startedAt: new Date(T0).toISOString(), elapsedMs, stepId } } });

describe('scenarioProgress', () => {
  it('is null when nothing runs', () => {
    expect(scenarioProgress(view(), T0, T0)).toBeNull();
  });

  it('extrapolates elapsed time and picks current and next steps', () => {
    const p = scenarioProgress(running(5000, 'calm'), T0, T0 + 2000)!;
    expect(p.elapsedMs).toBe(7000);
    expect(p.fraction).toBeCloseTo(7000 / 60_000);
    expect(p.current?.id).toBe('calm');
    expect(p.narration).toBe('All three providers are healthy.');
    expect(p.next?.id).toBe('down');
    expect(p.nextInMs).toBe(3000);
  });

  it('trusts the reported step over the clock, freezes while paused, clamps to the duration', () => {
    expect(scenarioProgress(running(12_000, 'calm'), T0, T0)!.current?.id).toBe('calm');
    expect(scenarioProgress(running(12_000, null), T0, T0)!.current?.id).toBe('down');
    expect(scenarioProgress(running(12_000, 'down', true), T0, T0 + 9000)!.elapsedMs).toBe(12_000);
    const end = scenarioProgress(running(59_000, 'recover'), T0, T0 + 10_000)!;
    expect(end.elapsedMs).toBe(60_000);
    expect(end.next).toBeNull();
    expect(end.nextInMs).toBeNull();
    expect(end.narration).toBeNull();
  });

  it('falls back to the log when the orchestrator is down', () => {
    const v = view(
      { orchestrator: null },
      {
        scenario: {
          runId: 'r1', scenarioId: 'provider-outage', title: 'Provider outage', startedAt: new Date(T0).toISOString(),
          step: { stepId: 'down', title: 'Orion goes down', narration: 'Say this', at: new Date(T0 + 10_000).toISOString() },
        },
      },
    );
    const p = scenarioProgress(v, T0, T0 + 15_000)!;
    expect(p.title).toBe('Provider outage');
    expect(p.current?.title).toBe('Orion goes down');
    expect(p.narration).toBe('Say this');
    expect(p.elapsedMs).toBe(15_000);
  });
});

describe('bannerFor', () => {
  it('shows title and step but never the narration', () => {
    expect(bannerFor(view())).toBeNull();
    const b = bannerFor(
      view({}, { scenario: { runId: 'r', scenarioId: 'x', title: 'Outage', startedAt: '', step: { stepId: 's', title: 'Orion down', narration: 'secret', at: '' } } }),
    );
    expect(b).toEqual({ title: 'Outage', step: 'Orion down' });
    expect(JSON.stringify(b)).not.toContain('secret');
  });
});

describe('providers and breakers', () => {
  it('maps breaker states to tones and plain English', () => {
    expect(breakerTone('open')).toBe('bad');
    expect(breakerTone('half-open')).toBe('warn');
    expect(breakerTone('closed')).toBe('ok');
    expect(breakerTone(undefined)).toBe('dim');
    expect(breakerSentence({ providerId: 'orion', state: 'open', since: null, failureRate: 1, attempts: 6, reason: '6 of the last 6 rejected' })).toBe('6 of the last 6 rejected');
    expect(breakerSentence(undefined)).toMatch(/No breaker/);
    expect(breakerSentence({ providerId: 'o', state: 'open', since: null, failureRate: 1, attempts: 6, reason: '' })).toMatch(/routed around/);
  });

  it('lists catalogue providers with breaker and outage', () => {
    const rows = providerStatusRows(
      view(
        { breakers: [{ providerId: 'orion', state: 'open', since: null, failureRate: 1, attempts: 5, reason: 'x' }] },
        { outages: { orion: { providerId: 'orion', mode: 'down', reason: 'drill', since: '' }, zeta: { providerId: 'zeta', mode: 'degraded', failureRate: 0.5, reason: '', since: '' } } },
      ),
    );
    expect(rows.map((r) => r.providerId)).toEqual(['orion', 'lyra', 'vega', 'zeta']);
    expect(rows[0]).toMatchObject({ tone: 'bad', name: 'Provider Orion' });
    expect(rows[0]!.outage?.reason).toBe('drill');
    expect(rows[1]!.tone).toBe('dim');
    expect(rows[3]!.tone).toBe('bad');
    expect(providerStatusRows(null)).toHaveLength(3);
  });

  it('picks the newest re-route as the explanation target', () => {
    expect(explanationTarget(view())).toBeNull();
    const r = { paymentId: 'p2', fromProviderId: 'orion', toProviderId: 'lyra', attempt: 2, at: '' };
    expect(explanationTarget(view({ reroutes: [r, { ...r, paymentId: 'p1' }] }))?.paymentId).toBe('p2');
  });

  it('recognises ambient presets', () => {
    expect(ambientPresetFor({ rate: 0, running: false, sent: 0 })).toBe('off');
    expect(ambientPresetFor({ rate: 8, running: false, sent: 0 })).toBe('off');
    expect(ambientPresetFor({ rate: 8, running: true, sent: 0 })).toBe('busy');
    expect(ambientPresetFor({ rate: 3, running: true, sent: 0 })).toBeNull();
    expect(ambientPresetFor(undefined)).toBeNull();
  });

  it('formats countdowns', () => {
    expect(formatCountdown(0)).toBe('0s');
    expect(formatCountdown(2100)).toBe('3s');
    expect(formatCountdown(75_000)).toBe('1:15');
  });
});

describe('resetReducer', () => {
  const health = (instanceId: string, replayed = true): Health => ({ ok: true, payments: 0, events: 0, replayed, replayMs: 1, instanceId, startedAt: '' });
  const start = (): ResetState => resetReducer(resetReducer({ phase: 'idle' }, { type: 'ask' }), { type: 'start', nowMs: 0, beforeInstance: 'a' });

  it('confirm -> cancel', () => {
    const c = resetReducer({ phase: 'idle' }, { type: 'ask' });
    expect(c.phase).toBe('confirm');
    expect(resetReducer(c, { type: 'cancel' }).phase).toBe('idle');
  });

  it('waits through the old gateway and the outage, then is back on a new instance', () => {
    let s = start();
    s = resetReducer(s, { type: 'health', health: health('a'), nowMs: 500 });
    expect(s.phase).toBe('resetting');
    s = resetReducer(s, { type: 'post', ok: false, status: 0, error: 'Gateway unreachable' }); // killed mid-request
    expect(s.phase).toBe('resetting');
    s = resetReducer(s, { type: 'health', health: null, nowMs: 2000 });
    expect(s).toMatchObject({ phase: 'resetting', sawDown: true });
    s = resetReducer(s, { type: 'health', health: health('b', false), nowMs: 6000 }); // still replaying
    expect(s.phase).toBe('resetting');
    s = resetReducer(s, { type: 'health', health: health('b'), nowMs: 7000 });
    expect(s).toEqual({ phase: 'back', startedAtMs: 0, tookMs: 7000 });
    expect(resetReducer(s, { type: 'dismiss' }).phase).toBe('idle');
  });

  it('an accepted (202) POST does not end the reset while the old gateway is still up', () => {
    let s = resetReducer(start(), { type: 'post', ok: true });
    s = resetReducer(s, { type: 'health', health: health('a'), nowMs: 300 }); // same old instance, still replayed
    expect(s.phase).toBe('resetting');
    s = resetReducer(s, { type: 'health', health: health('b'), nowMs: 5000 });
    expect(s.phase).toBe('back');
  });

  it('a new instance id alone is enough (fast restart between polls)', () => {
    expect(resetReducer(start(), { type: 'health', health: health('z'), nowMs: 3000 }).phase).toBe('back');
  });

  it('fails on an HTTP error from the gateway (e.g. 503) and after the give-up time', () => {
    expect(resetReducer(start(), { type: 'post', ok: false, status: 503, error: 'reset unavailable' })).toEqual({ phase: 'failed', error: 'reset unavailable' });
    expect(resetReducer(start(), { type: 'health', health: null, nowMs: RESET_GIVE_UP_MS + 1 }).phase).toBe('failed');
  });
});

describe('wire changes', () => {
  it('parseFrame accepts control, reset and focus messages', () => {
    const v = view();
    const msgs = parseFrame(JSON.stringify([{ kind: 'control', view: v }, { kind: 'reset', startedAt: 'x' }, { kind: 'focus', paymentId: null }, { kind: 'control' }]));
    expect(msgs.map((m) => m.kind)).toEqual(['control', 'reset', 'focus']);
  });

  it('the payment feed ignores control-plane messages', () => {
    expect(applyMessage(initialFeed, { kind: 'control', view: view() })).toBe(initialFeed);
    expect(applyMessage(initialFeed, { kind: 'focus', paymentId: 'p' })).toBe(initialFeed);
  });

  it('routes: stage and presenter, with a configurable fallback', () => {
    expect(parseHash('#/presenter')).toBe('presenter');
    expect(parseHash('#/stage')).toBe('stage');
    expect(parseHash('', 'stage')).toBe('stage');
    expect(parseHash('#/nope')).toBe('live');
  });
});
