import { describe, expect, it } from 'vitest';
import { INITIAL_CONTROL_STATE, type ControlState, type OrchestratorState } from '@ct/contracts/browser';
import { ATTRACT_LOOP } from '../../../../services/orchestrator/src/attract';
import { attractOnScreen, attractStatus, parseAttract, STORY_BEATS, storyCard, type AttractState } from './attract';
import { isKioskHash } from './kiosk';

const base: AttractState = {
  enabled: true,
  playing: true,
  idleMs: 120_000,
  idleForMs: 130_000,
  startsInMs: null,
  cycle: 2,
  run: { runId: 'run-4-attract', startedAt: '2026-01-01T09:00:00.000Z', elapsedMs: 15_000, stepId: 'orion-down' },
  lastStop: null,
  script: { id: 'attract', title: 'Booth loop', description: '', durationMs: 90_000, steps: [] },
};
const orch = (attract: unknown): OrchestratorState =>
  ({ ambient: { rate: 7, running: true, sent: 1 }, pace: 'normal', paused: false, scenarios: [], activeRun: null, attract }) as unknown as OrchestratorState;
const control = (scenarioId: string, stepId?: string, title = 'x'): ControlState => ({
  ...INITIAL_CONTROL_STATE,
  scenario: { runId: 'r', scenarioId, title: 't', startedAt: '', ...(stepId ? { step: { stepId, title, at: '' } } : {}) },
});

describe('attract state parsing', () => {
  it('parses the additive field and tolerates an older orchestrator', () => {
    expect(parseAttract(orch(base))).toEqual(base);
    expect(parseAttract(orch(undefined))).toBeNull();
    expect(parseAttract(null)).toBeNull();
    expect(parseAttract(orch({ enabled: 'yes', playing: true }))).toBeNull();
    const partial = parseAttract(orch({ enabled: true, playing: false, lastStop: 'weird', run: { nope: 1 } }))!;
    expect(partial).toMatchObject({ enabled: true, playing: false, idleMs: 0, startsInMs: null, run: null, lastStop: null, cycle: 0 });
    expect(partial.script.steps).toEqual([]);
  });
});

describe('story cards', () => {
  it('cover every step of the orchestrator loop, in order, with the booth captions', () => {
    expect(STORY_BEATS.map((b) => b.stepId)).toEqual(ATTRACT_LOOP.steps.map((s) => s.id));
    const heads = STORY_BEATS.map((b) => b.headline);
    expect(heads).toContain('Payments flowing across 3 corridors');
    expect(heads).toContain('Orion just failed');
    expect(heads).toContain('Traffic re-routed — nothing lost');
    expect(heads).toContain('Ledger still balanced to the cent');
  });

  it('follows the log step first, then the orchestrator run', () => {
    expect(storyCard(control('attract', 'rerouted'), base)).toMatchObject({ stepId: 'rerouted', tone: 'recover', index: 2, count: 7 });
    expect(storyCard(control('attract'), base)).toMatchObject({ stepId: 'orion-down', tone: 'alert', index: 1 }); // started, step not yet in the log
    expect(storyCard(INITIAL_CONTROL_STATE, base)).toMatchObject({ stepId: 'orion-down' });
    expect(storyCard(control('attract', 'mystery', 'Something new'), base)).toMatchObject({ headline: 'Something new', tone: 'calm' });
  });

  it('is not shown for a presenter scenario or when the loop is not playing', () => {
    expect(storyCard(control('provider-outage', 'orion-down'), base)).toBeNull();
    expect(attractOnScreen(control('provider-outage'), base)).toBe(false);
    expect(storyCard(INITIAL_CONTROL_STATE, { ...base, playing: false, run: null })).toBeNull();
    expect(storyCard(null, null)).toBeNull();
    expect(storyCard(control('attract', 'flow'), null)).toMatchObject({ stepId: 'flow', tone: 'calm' }); // log alone is enough
  });
});

describe('presenter status', () => {
  it('says what the loop is doing and when it starts', () => {
    expect(attractStatus(null, false, false).label).toBe('Unavailable');
    expect(attractStatus(base, false, false)).toMatchObject({ tone: 'ok', label: 'Playing', detail: expect.stringContaining('Cycle 2 · Orion just failed') });
    const idle = { ...base, playing: false, run: null };
    expect(attractStatus({ ...idle, enabled: false }, false, false).label).toBe('Off');
    expect(attractStatus(idle, true, false).label).toBe('Waiting');
    expect(attractStatus(idle, false, true)).toMatchObject({ label: 'Waiting', tone: 'warn' });
    expect(attractStatus({ ...idle, startsInMs: 83_000 }, false, false)).toMatchObject({ label: 'Armed', detail: expect.stringContaining('1:23') });
    expect(attractStatus({ ...idle, idleMs: 0 }, false, false).label).toBe('On');
  });
});

describe('kiosk route', () => {
  it('matches #/kiosk only', () => {
    expect(isKioskHash('#/kiosk')).toBe(true);
    expect(isKioskHash('#kiosk')).toBe(true);
    expect(isKioskHash('#/kiosk?x=1')).toBe(true);
    expect(isKioskHash('#/kiosks')).toBe(false);
    expect(isKioskHash('#/stage')).toBe(false);
    expect(isKioskHash('')).toBe(false);
  });
});
