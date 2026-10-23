// M3 end to end: "Provider Orion goes down -> its failures trip a circuit breaker within seconds ->
// traffic re-routes to Lyra/Vega -> no payment is lost or duplicated -> when Orion recovers the breaker
// goes half-open, probe traffic succeeds, and Orion gets traffic back."
//
// Real stages + InMemoryBus + in-memory ledger, ambient traffic of 250 payments, and the control events
// control.provider_outage.started / .ended for 'orion' on the same log.
//
// Time compression: breakers, health and routing work ONLY on event timestamps (occurredAt), and the
// runner stamps events with `new Date()`. The test replaces the global Date with one whose clock runs
// SPEED (10x) faster than real time, so the scenario spans ~100 s of event time (default breaker:
// 20 s window, 15 s open; routing lag 2 s) while the test takes ~10 s. Stage delays are real
// milliseconds (stage 5 ms ~ 50 ms of event time, settlement 25 ms ~ 0.25 s), so the shape of the
// run is the same as a live demo with proportionally longer delays.
//
// Recovery budget after the outage ends at E: probes sent just before E can still be rejected, so the
// breaker may re-open at ~E+0.5 s -> half-open at ~E+15.5 s -> routing sees it 2 s later -> wait for a
// hash-selected probe (25% of payments; >8 s happens with p ~ 0.3%) -> its settlement -> routing sees
// the closed breaker 2 s later: worst case ~E+30 s. The run continues 50 s after E, so the recovery
// assertions always have traffic to look at. (At 20x and 80 s the margin was ~0 and the test flaked.)
import { afterEach, describe, expect, it } from 'vitest';
import { makeControlEvent, project, type AnyEvent, type PaymentState } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { InMemoryBus } from '@ct/event-bus';
import { createInMemoryLedger } from '@ct/ledger';
import { breakerDetails } from '@ct/market';
import { startAllStages, type StageHandle } from './runner';
import { HEALTH_LAG_MS } from './steps/routing';

const SPEED = 10;
const PAYMENTS = 250; // 100 s of event time; 50 s after the outage for recovery (see the budget above)
const SPACING_MS = 400; // event time between payments (2.5 payments/s)
const OUTAGE_START_AT = 50; // payment index (20 s)
const OUTAGE_END_AT = 125; // payment index (50 s)

const RealDate = Date;
function installFastClock(): { restore(): void } {
  const t0 = RealDate.now();
  const p0 = performance.now();
  const now = () => Math.floor(t0 + (performance.now() - p0) * SPEED);
  class FastDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now());
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return now();
    }
  }
  globalThis.Date = FastDate as DateConstructor;
  return { restore: () => void (globalThis.Date = RealDate) };
}

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let clock: { restore(): void } | undefined;
let bus: InMemoryBus | undefined;
let stages: StageHandle | undefined;
afterEach(async () => {
  await stages?.stop();
  await bus?.close();
  clock?.restore();
  stages = undefined;
  bus = undefined;
  clock = undefined;
});

describe('provider outage scenario end to end', () => {
  it('trips the breaker, re-routes, loses nothing, and gives Orion traffic back after recovery', async () => {
    bus = new InMemoryBus();
    const ledger = await createInMemoryLedger();
    clock = installFastClock();
    stages = await startAllStages({
      bus, stageDelayMs: 5, settlementDelayMs: 25, catchUpQuietMs: 10,
      services: { ledger, sim: { seed: 'outage-e2e', providerFailureScale: 1 } },
    });

    const start = Date.now();
    let outageStart = 0;
    let outageEnd = 0;
    const ids: string[] = [];
    for (let i = 0; i < PAYMENTS; i++) {
      const due = start + i * SPACING_MS;
      const wait = (due - Date.now()) / SPEED;
      if (wait > 0) await realSleep(wait);
      if (i === OUTAGE_START_AT) {
        outageStart = Date.now();
        await bus.publish(makeControlEvent('control.provider_outage.started', { providerId: 'orion', mode: 'down', reason: 'Scenario: Orion data centre outage', runId: 'run-e2e' }, {
          eventId: 'ctl-outage-start', occurredAt: new Date(outageStart).toISOString(), producer: 'orchestrator',
        }));
      }
      if (i === OUTAGE_END_AT) {
        outageEnd = Date.now();
        await bus.publish(makeControlEvent('control.provider_outage.ended', { providerId: 'orion', runId: 'run-e2e' }, {
          eventId: 'ctl-outage-end', occurredAt: new Date(outageEnd).toISOString(), producer: 'orchestrator',
        }));
      }
      const id = `outage-${String(i).padStart(3, '0')}`;
      ids.push(id);
      await bus.publish(makeEvent('payment.initiated', id, sampleInitiatedPayload({ idempotencyKey: `k-${id}` }), { occurredAt: new Date().toISOString() }) as AnyEvent);
    }

    // every payment ends terminal
    const deadline = performance.now() + 15_000;
    let states = new Map<string, PaymentState>();
    for (;;) {
      states = project(bus.events).states;
      if (ids.every((id) => ['reconciled', 'failed'].includes(states.get(id)?.status ?? ''))) break;
      if (performance.now() > deadline) throw new Error(`stuck: ${ids.filter((id) => !['reconciled', 'failed'].includes(states.get(id)?.status ?? '')).map((id) => `${id}=${states.get(id)?.status}`).join(', ')}`);
      await realSleep(10);
    }
    await bus.drain(60_000 * SPEED);
    const end = Date.now();
    await stages.stop();
    stages = undefined;
    clock.restore();
    clock = undefined;

    const events = bus.paymentEvents;
    const all = bus.events;
    // no payment lost or duplicated
    expect(new Set(all.map((e) => e.eventId)).size).toBe(all.length);
    const projected = project(all);
    expect(projected.rejected).toEqual([]);
    states = projected.states;
    const reconciled = ids.filter((id) => states.get(id)!.status === 'reconciled');
    const failed = ids.filter((id) => states.get(id)!.status === 'failed');
    expect(reconciled.length + failed.length).toBe(PAYMENTS);
    expect(failed.length).toBeLessThanOrEqual(2);
    expect((await ledger.invariants()).ok).toBe(true);
    for (const id of reconciled) expect(await ledger.journals({ paymentId: id })).toHaveLength(1);
    for (const id of failed) expect(await ledger.journals({ paymentId: id })).toHaveLength(0);

    // settlement honoured the outage: every outage reject happened between start and end (+ in-flight)
    const outageRejects = events.filter((e) => e.type === 'payment.send_failed' && e.trace?.reasonCodes.includes('PROVIDER_OUTAGE'));
    expect(outageRejects.length).toBeGreaterThan(0);
    for (const e of outageRejects) expect(Date.parse(e.occurredAt)).toBeGreaterThan(outageStart);

    // breaker timeline from the final log (event time), sampled every 100 ms
    const finalStates = [...states.values()];
    const timeline: { t: number; state: string }[] = [];
    for (let t = start; t <= end; t += 100) timeline.push({ t, state: breakerDetails(finalStates, t).orion!.state });
    const stateAt = (t: number) => breakerDetails(finalStates, t).orion!;
    const firstOpen = timeline.find((x) => x.t > outageStart && x.state === 'open')!;
    expect(firstOpen).toBeDefined();
    expect(timeline.filter((x) => x.t < outageStart).every((x) => x.state === 'closed')).toBe(true);
    const timeToOpenMs = firstOpen.t - outageStart;
    expect(timeToOpenMs).toBeLessThan(10_000); // "within seconds"
    const firstHalfOpen = timeline.find((x) => x.t > firstOpen.t && x.state === 'half-open')!;
    expect(firstHalfOpen).toBeDefined();
    const recovered = timeline.find((x) => x.t > outageEnd && x.state === 'closed')!;
    expect(recovered).toBeDefined();
    expect(stateAt(end)).toMatchObject({ state: 'closed' });
    expect(stateAt(end).recoveredAtMs).toBeGreaterThan(outageEnd);

    // routing: first attempts, judged at the routing cut-off (quoted time - lag)
    const firstRoutes = events
      .filter((e): e is Extract<AnyEvent, { type: 'payment.routed' }> => e.type === 'payment.routed' && (e.payload.attempt ?? 1) === 1)
      .map((e) => {
        const quoted = events.find((q) => q.eventId === e.causationId)!;
        const asOf = Date.parse(quoted.occurredAt) - HEALTH_LAG_MS;
        return { e, asOf, providerId: e.payload.providerId, breaker: stateAt(asOf).state };
      });
    expect(firstRoutes).toHaveLength(PAYMENTS);
    // Orion gets no first-attempt traffic while its breaker is open (as the trace and the replayed breaker both say)
    const whileOpen = firstRoutes.filter((r) => r.breaker === 'open');
    expect(whileOpen.length).toBeGreaterThan(10);
    expect(whileOpen.filter((r) => r.providerId === 'orion')).toEqual([]);
    for (const r of firstRoutes) {
      const traced = (r.e.trace!.inputs.breakers as Record<string, { state: string }>).orion!.state;
      expect(traced).toBe(r.breaker); // live decision == replayed breaker
      if (r.providerId === 'orion') expect(traced).not.toBe('open');
    }
    expect(whileOpen.every((r) => r.e.trace!.reasonCodes.includes('CIRCUIT_OPEN_REROUTED'))).toBe(true);
    // half-open probes went to Orion
    const probes = firstRoutes.filter((r) => r.e.trace!.reasonCodes.includes('CIRCUIT_HALF_OPEN_PROBE'));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((r) => r.providerId === 'orion' && r.breaker === 'half-open')).toBe(true);
    // Orion gets traffic back after recovery: the probe that closed the breaker settled, and from then on
    // Orion is eligible again for every payment (its share is then decided by M2 scoring alone).
    const recoveredAt = stateAt(end).recoveredAtMs!;
    const orionAfterOutage = firstRoutes.filter((r) => r.asOf >= outageEnd && r.providerId === 'orion');
    expect(orionAfterOutage.length).toBeGreaterThan(0);
    expect(orionAfterOutage.some((r) => states.get(r.e.paymentId)!.facts['payment.settled']?.providerId === 'orion')).toBe(true);
    const afterRecovery = firstRoutes.filter((r) => r.asOf > recoveredAt);
    expect(afterRecovery.length).toBeGreaterThan(5);
    for (const r of afterRecovery) {
      expect(r.breaker).toBe('closed');
      expect(r.e.payload.scoring!.find((s) => s.providerId === 'orion')).toMatchObject({ eligible: true });
      expect(r.e.trace!.inputs.healthResetAfterRecovery).toEqual({ orion: new Date(recoveredAt).toISOString() });
    }
    const orionAfter = afterRecovery.filter((r) => r.providerId === 'orion');
    // After recovery Orion must win its traffic back, not just be eligible (the on-stage story).
    expect(orionAfter.length / afterRecovery.length).toBeGreaterThan(0.5);

    const outageRoutes = firstRoutes.filter((r) => r.asOf >= outageStart && r.asOf < outageEnd);
    const rerouteShare = outageRoutes.filter((r) => r.providerId !== 'orion').length / outageRoutes.length;
    const summary = {
      payments: PAYMENTS, reconciled: reconciled.length, failed: failed.length, events: all.length,
      eventTimeSpanS: (end - start) / 1000,
      outage: { startS: (outageStart - start) / 1000, endS: (outageEnd - start) / 1000 },
      timeToOpenS: timeToOpenMs / 1000,
      firstHalfOpenS: (firstHalfOpen.t - start) / 1000,
      recoveredS: (stateAt(end).recoveredAtMs! - start) / 1000,
      recoveryAfterOutageEndS: (stateAt(end).recoveredAtMs! - outageEnd) / 1000,
      trips: stateAt(end).trips,
      outageRejects: outageRejects.length,
      firstAttemptsWhileOpen: whileOpen.length,
      rerouteShareDuringOutage: Math.round(rerouteShare * 1000) / 1000,
      probes: probes.length,
      orionFirstAttemptsAfterOutageEnd: orionAfterOutage.length,
      orionShareAfterRecovery: Math.round((orionAfter.length / afterRecovery.length) * 1000) / 1000,
    };
    console.log('[outage-e2e]', JSON.stringify(summary));
  }, 60_000);
});
