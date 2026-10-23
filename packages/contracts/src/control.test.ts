import { describe, expect, it } from 'vitest';
import { ControlTimeline, isControlEvent, makeControlEvent, project, type ControlEvent } from './index';
import { happyPath } from './testing';

const ctl = (n: number, e: Omit<ControlEvent, 'eventId' | 'schemaVersion' | 'paymentId' | 'occurredAt' | 'producer'>) =>
  makeControlEvent(e.type, e.payload as never, { eventId: `c-${n}`, occurredAt: `2026-01-01T00:00:0${n}.000Z`, producer: 'orchestrator' }) as ControlEvent;

describe('control timeline', () => {
  it('state at an offset only sees control events published before it', () => {
    const t = new ControlTimeline();
    t.apply(ctl(1, { type: 'control.provider_outage.started', payload: { providerId: 'orion', mode: 'down', reason: 'test' } }), 10);
    t.apply(ctl(2, { type: 'control.provider_outage.ended', payload: { providerId: 'orion' } }), 20);
    expect(t.at(5).outages).toEqual({});
    expect(t.at(10).outages).toEqual({}); // the event AT the offset is not "before" it
    expect(t.at(11).outages.orion?.mode).toBe('down');
    expect(t.at(20).outages.orion).toBeDefined();
    expect(t.at(21).outages).toEqual({});
    expect(t.current().outages).toEqual({});
  });

  it('tracks scenario, pacing and pause, and ignores duplicates', () => {
    const t = new ControlTimeline();
    const start = ctl(1, { type: 'control.scenario.started', payload: { runId: 'r1', scenarioId: 'provider-outage', title: 'Outage', seed: 's' } });
    t.apply(start, 1);
    t.apply(start, 1);
    t.apply(ctl(2, { type: 'control.scenario.step', payload: { runId: 'r1', scenarioId: 'provider-outage', stepId: 'down', title: 'Orion fails' } }), 2);
    t.apply(ctl(3, { type: 'control.demo.speed', payload: { stageDelayMs: 2000, settlementDelayMs: 4000, label: 'slow motion' } }), 3);
    t.apply(ctl(4, { type: 'control.demo.paused', payload: { paused: true } }), 4);
    const s = t.current();
    expect(s.scenario?.step?.stepId).toBe('down');
    expect(s.speed?.label).toBe('slow motion');
    expect(s.paused).toBe(true);
    t.apply(ctl(5, { type: 'control.scenario.ended', payload: { runId: 'r1', scenarioId: 'provider-outage', outcome: 'completed' } }), 5);
    expect(t.current().scenario).toBeNull();
  });

  it('project() skips control events instead of rejecting them', () => {
    const events = [...happyPath('p-1'), ctl(1, { type: 'control.demo.paused', payload: { paused: false } })];
    expect(isControlEvent(events.at(-1)!)).toBe(true);
    const { states, rejected } = project(events);
    expect(rejected).toEqual([]);
    expect(states.get('p-1')?.status).toBe('reconciled');
    expect(states.has('__control__')).toBe(false);
  });

  it('applies approved config updates in version order and ignores stale ones (M4)', () => {
    const actor = { userId: 'u-1', name: 'A', role: 'admin' };
    const t = new ControlTimeline();
    expect(t.current().config['risk.thresholds']).toEqual({ hold: 0.7, reject: 0.92 });
    t.apply(ctl(1, { type: 'control.config.updated', payload: { key: 'risk.thresholds', value: { hold: 0.6, reject: 0.9 }, version: 2, changeRequestId: 'CR-2', actor } }), 1);
    t.apply(ctl(2, { type: 'control.config.updated', payload: { key: 'risk.thresholds', value: { hold: 0.5, reject: 0.8 }, version: 1, changeRequestId: 'CR-1', actor } }), 2);
    expect(t.current().config['risk.thresholds']).toEqual({ hold: 0.6, reject: 0.9 });
    expect(t.at(1).config['risk.thresholds']).toEqual({ hold: 0.7, reject: 0.92 }); // not yet visible before offset 1
    t.apply(ctl(3, { type: 'control.fx_shock.started', payload: { shockId: 's1', corridorId: 'US-IN', driftBps: 300, noiseMultiplier: 4, rampMs: 5000, reason: 'spike' } }), 3);
    expect(Object.keys(t.current().fxShocks)).toEqual(['s1']);
    t.apply(ctl(4, { type: 'control.fx_shock.ended', payload: { shockId: 's1' } }), 4);
    expect(t.current().fxShocks).toEqual({});
  });
});
