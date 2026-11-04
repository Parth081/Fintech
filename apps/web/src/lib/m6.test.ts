import { describe, expect, it } from 'vitest';
import { parseControlView, NO_CONTROL } from '../stage/data';
import { healthRows, healthSummary, modeInfo, modeSwitchReady, newestOf, parseLauncherStatus, requiredAfterSwitch, ribbonDetail } from './mode';
import { resetReducer } from './control';
import type { Health } from './types';

const H = (o: Partial<Health>): Health => ({ ok: true, payments: 0, events: 0, replayed: true, replayMs: 1, instanceId: 'b', startedAt: '', ...o });

describe('modeInfo', () => {
  it('defaults to live and only trusts "safe"', () => {
    expect(modeInfo(null)).toEqual({ mode: 'live', recording: null, safe: false });
    expect(modeInfo({ mode: 'weird', recording: 'x' })).toMatchObject({ safe: false, recording: null });
    expect(modeInfo({ mode: 'safe', recording: 'outage' })).toEqual({ mode: 'safe', recording: 'outage', safe: true });
    expect(modeInfo({ mode: 'safe', recording: '' }).recording).toBeNull();
  });
  it('words the ribbon detail', () => {
    expect(ribbonDetail(modeInfo({ mode: 'safe', recording: 'r1' }))).toContain('r1');
    expect(ribbonDetail(modeInfo({ mode: 'safe' }))).toContain('recorded');
  });
});

describe('launcher status', () => {
  const raw = {
    mode: 'live',
    recording: null,
    services: [
      { name: 'broker', running: true, restarts: 0, lastRestartAt: null, lastExit: null },
      { name: 'fx', running: true, restarts: 2, lastRestartAt: 'x', lastExit: null },
      { name: 'ledger', running: false, restarts: 1 },
      { nonsense: 1 },
    ],
  };
  it('parses defensively and summarises', () => {
    const st = parseLauncherStatus(raw)!;
    expect(st.services.map((s) => s.name)).toEqual(['broker', 'fx', 'ledger']);
    const rows = healthRows(st);
    expect(rows.map((r) => r.tone)).toEqual(['ok', 'warn', 'bad']);
    expect(rows[1]!.label).toContain('2×');
    expect(healthSummary(rows)).toEqual({ tone: 'bad', text: '1 service down' });
    expect(healthSummary(rows.slice(0, 2)).tone).toBe('warn');
    expect(healthSummary(rows.slice(0, 1))).toEqual({ tone: 'ok', text: 'All services running' });
    expect(healthSummary([]).tone).toBe('warn');
    expect(parseLauncherStatus(null)).toBeNull();
    expect(parseLauncherStatus({ error: 'x' })).toBeNull();
  });
  it('newestOf picks the latest recording', () => {
    const m = (name: string, recordedAt: string) => ({ name, recordedAt, scenarioId: null, eventCount: 1, firstOccurredAt: recordedAt, lastOccurredAt: recordedAt, durationMs: 0, format: 1 as const });
    expect(newestOf([m('a', '2026-01-01T00:00:00Z'), m('b', '2026-02-01T00:00:00Z')])?.name).toBe('b');
    expect(newestOf([])).toBeUndefined();
  });
});

describe('safe-mode switch', () => {
  it('is only ready when the new gateway is replayed AND reports the target mode', () => {
    expect(modeSwitchReady(H({ mode: 'live' }), 'safe')).toBe(false);
    expect(modeSwitchReady(H({ mode: 'safe', replayed: false }), 'safe')).toBe(false);
    expect(modeSwitchReady(H({ mode: 'safe' }), 'safe')).toBe(true);
    expect(modeSwitchReady(H({}), 'live')).toBe(true);
    expect(modeSwitchReady(null, 'live')).toBe(false);
    expect(requiredAfterSwitch('safe')).toEqual([]);
    expect(requiredAfterSwitch('live')).toEqual(['ledger', 'orchestrator']);
  });
  it('reuses the reset state machine: down then back in the new mode completes', () => {
    let s = resetReducer({ phase: 'idle' }, { type: 'ask' });
    expect(s.phase).toBe('confirm');
    s = resetReducer(s, { type: 'start', nowMs: 0, beforeInstance: 'a' });
    s = resetReducer(s, { type: 'health', health: H({ instanceId: 'a' }), nowMs: 500 });
    expect(s.phase).toBe('resetting');
    s = resetReducer(s, { type: 'health', health: null, nowMs: 1500 });
    s = resetReducer(s, { type: 'health', health: H({ instanceId: 'b' }), nowMs: 4000 });
    expect(s).toMatchObject({ phase: 'back', tookMs: 4000 });
  });
  it('a 503 from the gateway fails the switch', () => {
    let s = resetReducer({ phase: 'idle' }, { type: 'start', nowMs: 0, beforeInstance: 'a' });
    s = resetReducer(s, { type: 'post', ok: false, status: 503, error: 'safe mode unavailable' });
    expect(s).toEqual({ phase: 'failed', error: 'safe mode unavailable' });
  });
});

describe('stage control carries the mode', () => {
  it('parses mode and recording from a control view', () => {
    expect(NO_CONTROL.mode).toBe('live');
    const v = parseControlView({ breakers: [], control: {}, orchestrator: null, atMs: 1, mode: 'safe', recording: 'r' })!;
    expect(v).toMatchObject({ mode: 'safe', recording: 'r' });
    expect(parseControlView({ breakers: [] })!.mode).toBe('live');
  });
});
