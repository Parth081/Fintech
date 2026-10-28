// Orchestrator: ambient traffic, the scenario engine and the presenter HTTP API (see @ct/contracts
// orchestrator-api.ts). Scenario steps and demo controls are published as control events on the payment
// log; every service reacts to them at the same log position.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ControlTimeline,
  deterministicId,
  isControlEvent,
  makeControlEvent,
  newId,
  type ControlEvent,
  type ControlEventType,
  type ControlPayloadMap,
  type PacePreset,
} from '@ct/contracts';
import type { EventBus, Subscription } from '@ct/event-bus';
import { AmbientTraffic, ambientIndexOf, MAX_AMBIENT_RATE, type PaymentSender } from './ambient';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { craftedKey, craftedRequest, SCENARIOS, scenarioInfo, validateScript, type CraftedPayment, type ScenarioAction, type ScenarioScript } from './scenarios';
import { ATTRACT_LOOP, type AttractState, type OrchestratorStateWithAttract } from './attract';
import { sendPayment } from '../../../tools/traffic/send';

export const PACE_PRESETS: Record<PacePreset, { stageDelayMs: number | null; settlementDelayMs: number | null }> = {
  normal: { stageDelayMs: null, settlementDelayMs: null },
  slow: { stageDelayMs: 1500, settlementDelayMs: 3000 },
  fast: { stageDelayMs: 0, settlementDelayMs: 150 },
};

export interface OrchestratorOptions {
  bus: EventBus;
  host?: string;
  port?: number;
  paymentApiUrl: string;
  /** Seed for ambient traffic and the default scenario seed. */
  seed: string;
  /** Ambient payments per second at startup (0 = none). */
  ambientRate: number;
  scenarios?: readonly ScenarioScript[];
  clock?: Clock;
  /** Replaces the HTTP POST to the Payment API (tests). */
  send?: PaymentSender;
  log?: (line: string) => void;
  /** Max time to wait for the log replay on startup. */
  catchUpTimeoutMs?: number;
  /**
   * M5 attract loop. idleMs: start it by itself after this long without a presenter command, kiosk touch
   * or presenter scenario (0 = never by itself; the default, so tests and tools are not surprised).
   * enabled: initial switch (default: idleMs > 0). script: the loop (default ATTRACT_LOOP; tests).
   */
  attract?: { idleMs?: number; enabled?: boolean; script?: ScenarioScript };
}

export interface OrchestratorHandle {
  port: number;
  /** Stops the active run cleanly (restores outages) unless `restore: false`, then stops serving. */
  close(opts?: { restore?: boolean }): Promise<void>;
  state(): OrchestratorStateWithAttract;
  /** Resolves when every queued control-event publish has completed (tests). */
  idle(): Promise<void>;
}

interface ActiveRun {
  runId: string;
  script: ScenarioScript;
  seed: string;
  startedAtIso: string;
  /** Scenario time accumulated before the current resume (the scenario clock stops while paused). */
  elapsedBase: number;
  resumedAt: number | null;
  nextStep: number;
  stepId: string | null;
  timer: TimerHandle | undefined;
  openOutages: Set<string>;
  /** FX shocks this run started and has not ended yet: script shockId -> published shockId. */
  openShocks: Map<string, string>;
  /** Crafted payments not sent yet, in scenario-time order (the queue stops while paused). */
  sendQueue: { dueMs: number; key: string; payment: CraftedPayment }[];
  sendTimer: TimerHandle | undefined;
  /** Crafted payments sent so far (accepted or duplicate) and those that failed after retries. */
  crafted: { sent: number; failed: number };
  ambientBefore: number;
  finishing: boolean;
  /** A cycle of the attract loop (not a presenter scenario). */
  attract: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) {
    super(code);
  }
}

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return reject(new HttpError(400, 'validation_failed', ['body must be a JSON object']));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startOrchestrator(options: OrchestratorOptions): Promise<OrchestratorHandle> {
  const { bus, seed } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const scripts = options.scenarios ?? SCENARIOS;
  for (const s of scripts) validateScript(s);
  const scriptById = new Map(scripts.map((s) => [s.id, s]));
  const infos = scripts.map(scenarioInfo);
  const attractScript = options.attract?.script ?? ATTRACT_LOOP;
  validateScript(attractScript);
  if (scriptById.has(attractScript.id)) throw new Error(`orchestrator: attract loop id "${attractScript.id}" clashes with a scenario`);
  const attractInfo = scenarioInfo(attractScript);
  const iso = () => new Date(clock.now()).toISOString();

  // ---- log projection: control timeline + ambient progress (ephemeral, from earliest) ----
  const timeline = new ControlTimeline();
  let appliedOffset = -1;
  let maxAmbientIndex = -1;
  let ambientInLog = 0;
  const ambientKeysSeen = new Set<number>();
  let runsInLog = 0;
  let run: ActiveRun | null = null;
  /** Set once ambient traffic exists; called when another producer ends our active run. */
  let onRunEndedElsewhere: (r: ActiveRun) => void = () => {};
  const sub: Subscription = await bus.subscribe(
    { group: `orchestrator-projection-${process.pid}-${Math.random().toString(36).slice(2, 10)}`, from: 'earliest', ephemeral: true },
    (event, meta) => {
      if (isControlEvent(event)) {
        timeline.apply(event, meta.offset);
        if (event.type === 'control.scenario.started') runsInLog += 1;
        if (event.type === 'control.scenario.ended' && run && run.runId === event.payload.runId && !run.finishing) onRunEndedElsewhere(run);
      } else if (event.type === 'payment.initiated') {
        const idx = ambientIndexOf(seed, event.payload.idempotencyKey);
        if (idx !== undefined && !ambientKeysSeen.has(idx)) {
          ambientKeysSeen.add(idx);
          ambientInLog += 1;
          if (idx > maxAmbientIndex) maxAmbientIndex = idx;
        }
      }
      appliedOffset = meta.offset;
    },
  );
  const head = await bus.head();
  const deadline = Date.now() + (options.catchUpTimeoutMs ?? 30_000);
  while (appliedOffset < head - 1) {
    if (Date.now() > deadline) {
      await sub.unsubscribe();
      throw new Error(`orchestrator: log replay did not reach offset ${head - 1} in time`);
    }
    await realSleep(5);
  }
  ambientKeysSeen.clear(); // only needed during replay

  // ---- serialized, retried publishing (eventIds are deterministic, so a retry never duplicates) ----
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const publishNow = async <T extends ControlEventType>(type: T, payload: ControlPayloadMap[T], eventId: string) => {
    const event = makeControlEvent(type, payload, { eventId, occurredAt: iso(), producer: 'orchestrator' });
    for (let attempt = 0; ; attempt++) {
      try {
        const meta = await bus.publish(event as ControlEvent);
        log(`[orchestrator] published ${type} @${meta.offset}`);
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        log(`[orchestrator] publish ${type} failed (${(err as Error).message}); retrying`);
        await realSleep(Math.min(2000, 100 * 2 ** attempt));
      }
    }
  };
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.then(
      () => undefined,
      (err: unknown) => log(`[orchestrator] control publish failed: ${(err as Error).message}`),
    );
    return p;
  };

  // ---- restart recovery: never leave the system stuck in an outage or a half-finished scenario ----
  {
    const s = timeline.current();
    for (const outage of Object.values(s.outages)) {
      const id = outage.runId ? deterministicId('orchestrator', outage.runId, 'restore', outage.providerId) : deterministicId('orchestrator', 'recover', outage.providerId, outage.since);
      log(`[orchestrator] recovery: ending dangling ${outage.mode} outage of ${outage.providerId}`);
      await publishNow('control.provider_outage.ended', { providerId: outage.providerId, ...(outage.runId ? { runId: outage.runId } : {}) }, id);
    }
    for (const shock of Object.values(s.fxShocks)) {
      const runId = (shock as { runId?: string }).runId;
      const id = runId ? deterministicId('orchestrator', runId, 'restore-fx', shock.shockId) : deterministicId('orchestrator', 'recover-fx', shock.shockId, shock.since);
      log(`[orchestrator] recovery: ending dangling FX shock ${shock.shockId} on ${shock.corridorId}`);
      await publishNow('control.fx_shock.ended', { shockId: shock.shockId, ...(runId ? { runId } : {}) }, id);
    }
    if (s.scenario) {
      log(`[orchestrator] recovery: closing interrupted scenario run ${s.scenario.runId}`);
      await publishNow(
        'control.scenario.ended',
        { runId: s.scenario.runId, scenarioId: s.scenario.scenarioId, outcome: 'stopped' },
        deterministicId('orchestrator', s.scenario.runId, 'ended'),
      );
    }
  }

  const initial = timeline.current();
  let paused = initial.paused;
  let pace: PacePreset = 'normal';
  if (initial.speed && (initial.speed.label === 'slow' || initial.speed.label === 'fast')) pace = initial.speed.label;

  // ---- ambient traffic ----
  const ambient = new AmbientTraffic({ seed, paymentApiUrl: options.paymentApiUrl, clock, rate: options.ambientRate, send: options.send, log });
  ambient.resumeFrom(maxAmbientIndex + 1, ambientInLog);
  ambient.setPaused(paused);
  ambient.start();

  // ---- scenario engine ----
  let runCounter = runsInLog;
  onRunEndedElsewhere = (r) => {
    // e.g. a second orchestrator instance recovered the log: stop driving this run, restore our traffic.
    log(`[orchestrator] run ${r.runId} was ended by another producer; abandoning it`);
    r.finishing = true;
    clock.clearTimeout(r.timer);
    r.timer = undefined;
    cancelSends(r);
    ambient.setRate(r.ambientBefore);
    if (run === r) run = null;
    afterRunEnded(r, 'elsewhere');
  };

  const elapsed = (r: ActiveRun) => r.elapsedBase + (r.resumedAt === null ? 0 : clock.now() - r.resumedAt);

  // ---- crafted payments (M4): sent through the Payment API on the scenario clock ----
  const sender = options.send ?? sendPayment;
  const sendsInFlight = new Set<Promise<void>>();
  function cancelSends(r: ActiveRun): void {
    clock.clearTimeout(r.sendTimer);
    r.sendTimer = undefined;
    if (r.sendQueue.length > 0) log(`[orchestrator] run ${r.runId}: ${r.sendQueue.length} crafted payment(s) not sent (run ended)`);
    r.sendQueue.length = 0;
  }
  const sendCrafted = (r: ActiveRun, key: string, payment: CraftedPayment) => {
    const p: Promise<void> = (async () => {
      for (let attempt = 1; ; attempt++) {
        const res = await sender(options.paymentApiUrl, { index: -1, idempotencyKey: key, body: payment });
        if (res.outcome !== 'error') {
          r.crafted.sent += 1;
          return;
        }
        // Same Idempotency-Key on every attempt: a retry can never create a second payment.
        const retryable = res.status === undefined || res.status >= 500 || res.status === 429;
        if (!retryable || attempt >= 5 || closed) {
          r.crafted.failed += 1;
          log(`[orchestrator] crafted payment ${key} failed (${res.status ?? '-'} ${res.detail ?? ''})`);
          return;
        }
        await realSleep(200 * attempt);
      }
    })()
      .catch((err: unknown) => {
        r.crafted.failed += 1;
        log(`[orchestrator] crafted payment ${key} failed: ${(err as Error).message}`);
      })
      .finally(() => sendsInFlight.delete(p));
    sendsInFlight.add(p);
  };
  const scheduleSends = (r: ActiveRun): void => {
    clock.clearTimeout(r.sendTimer);
    r.sendTimer = undefined;
    if (r.finishing || r.resumedAt === null || r.sendQueue.length === 0) return;
    const fire = () => {
      r.sendTimer = undefined;
      if (r.finishing || run !== r) return;
      const now = elapsed(r);
      while (r.sendQueue.length > 0 && r.sendQueue[0]!.dueMs <= now) {
        const item = r.sendQueue.shift()!;
        sendCrafted(r, item.key, item.payment);
      }
      scheduleSends(r);
    };
    const delay = r.sendQueue[0]!.dueMs - elapsed(r);
    if (delay <= 0) fire();
    else r.sendTimer = clock.setTimeout(fire, delay);
  };

  const applyAction = async (r: ActiveRun, stepId: string, a: ScenarioAction, i: number) => {
    const id = deterministicId('orchestrator', r.runId, 'step', stepId, 'action', String(i));
    switch (a.kind) {
      case 'outage.start':
        r.openOutages.add(a.providerId);
        await publishNow(
          'control.provider_outage.started',
          { providerId: a.providerId, mode: a.mode, ...(a.failureRate !== undefined ? { failureRate: a.failureRate } : {}), reason: a.reason, runId: r.runId },
          id,
        );
        return;
      case 'outage.end':
        await publishNow('control.provider_outage.ended', { providerId: a.providerId, runId: r.runId }, id);
        r.openOutages.delete(a.providerId);
        return;
      case 'ambient.rate':
        ambient.setRate(a.rate);
        return;
      case 'fx_shock.start': {
        const shockId = `${a.shockId}@${r.runId}`;
        r.openShocks.set(a.shockId, shockId);
        await publishNow(
          'control.fx_shock.started',
          { shockId, corridorId: a.corridorId, driftBps: a.driftBps, noiseMultiplier: a.noiseMultiplier, rampMs: a.rampMs, reason: a.reason, runId: r.runId },
          id,
        );
        return;
      }
      case 'fx_shock.end': {
        const shockId = r.openShocks.get(a.shockId) ?? `${a.shockId}@${r.runId}`;
        await publishNow('control.fx_shock.ended', { shockId, runId: r.runId }, id);
        r.openShocks.delete(a.shockId);
        return;
      }
      case 'payments.send': {
        // Due times are on the scenario clock, counted from the step's scheduled time (not from when this
        // action ran after earlier publishes), so the schedule is the same on every run.
        const step = r.script.steps.find((x) => x.id === stepId);
        const base = step ? step.atMs : elapsed(r);
        a.payments.forEach((p, k) => {
          r.sendQueue.push({ dueMs: base + k * (a.spacingMs ?? 0), key: craftedKey(r.runId, stepId, a.label, k), payment: craftedRequest(p, r.runId) });
        });
        r.sendQueue.sort((x, y) => x.dueMs - y.dueMs);
        scheduleSends(r);
        return;
      }
    }
  };

  /** End the run: restore anything still open, publish scenario.ended, put ambient traffic back. */
  const finish = (r: ActiveRun, outcome: 'completed' | 'stopped') => {
    r.finishing = true;
    clock.clearTimeout(r.timer);
    r.timer = undefined;
    cancelSends(r);
    return enqueue(async () => {
      for (const providerId of [...r.openOutages]) {
        await publishNow('control.provider_outage.ended', { providerId, runId: r.runId }, deterministicId('orchestrator', r.runId, 'restore', providerId));
        r.openOutages.delete(providerId);
      }
      for (const [scriptShockId, shockId] of [...r.openShocks]) {
        await publishNow('control.fx_shock.ended', { shockId, runId: r.runId }, deterministicId('orchestrator', r.runId, 'restore-fx', shockId));
        r.openShocks.delete(scriptShockId);
      }
      await publishNow('control.scenario.ended', { runId: r.runId, scenarioId: r.script.id, outcome }, deterministicId('orchestrator', r.runId, 'ended'));
      ambient.setRate(r.ambientBefore);
      if (run === r) run = null;
      log(`[orchestrator] scenario ${r.script.id} run ${r.runId} ${outcome}`);
      afterRunEnded(r, outcome);
    });
  };

  const scheduleNext = (r: ActiveRun) => {
    clock.clearTimeout(r.timer);
    r.timer = undefined;
    if (r.finishing || r.resumedAt === null) return; // paused: the scenario clock is stopped
    const step = r.script.steps[r.nextStep];
    const dueAt = step ? step.atMs : r.script.durationMs;
    const fire = () => {
      r.timer = undefined;
      if (r.finishing || run !== r) return;
      const s = r.script.steps[r.nextStep];
      if (!s) {
        void finish(r, 'completed');
        return;
      }
      r.nextStep += 1;
      r.stepId = s.id;
      void enqueue(async () => {
        if (r.finishing) return;
        await publishNow(
          'control.scenario.step',
          { runId: r.runId, scenarioId: r.script.id, stepId: s.id, title: s.title, ...(s.narration !== undefined ? { narration: s.narration } : {}) },
          deterministicId('orchestrator', r.runId, 'step', s.id),
        );
        let i = 0;
        for (const a of s.actions ?? []) {
          if (r.finishing) return;
          await applyAction(r, s.id, a, i++);
        }
      });
      scheduleNext(r);
    };
    const delay = dueAt - elapsed(r);
    if (delay <= 0) fire(); // due now (e.g. the step at 0 ms): publish without waiting for a timer tick
    else r.timer = clock.setTimeout(fire, delay);
  };

  const startRun = async (scenarioId: string, runSeed: string): Promise<string> => {
    const script = scriptById.get(scenarioId);
    if (!script) throw new HttpError(404, 'unknown_scenario', { scenarioId, available: [...scriptById.keys()] });
    return startScript(script, runSeed, false);
  };

  const startScript = async (script: ScenarioScript, runSeed: string, isAttract: boolean): Promise<string> => {
    const scenarioId = script.id;
    if (run) throw new HttpError(409, 'scenario_active', { runId: run.runId, scenarioId: run.script.id });
    runCounter += 1;
    const runId = `run-${runCounter}-${scenarioId}`;
    const r: ActiveRun = {
      runId,
      script,
      seed: runSeed,
      startedAtIso: iso(),
      elapsedBase: 0,
      resumedAt: paused ? null : clock.now(),
      nextStep: 0,
      stepId: null,
      timer: undefined,
      openOutages: new Set(),
      openShocks: new Map(),
      sendQueue: [],
      sendTimer: undefined,
      crafted: { sent: 0, failed: 0 },
      ambientBefore: ambient.rate,
      finishing: false,
      attract: isAttract,
    };
    run = r;
    await enqueue(() => publishNow('control.scenario.started', { runId, scenarioId, title: script.title, seed: runSeed }, deterministicId('orchestrator', runId, 'started')));
    log(`[orchestrator] scenario ${scenarioId} started (run ${runId}, seed ${runSeed})`);
    if (run === r) scheduleNext(r);
    return runId;
  };

  const stopRun = async (): Promise<boolean> => {
    const r = run;
    if (!r) return false;
    if (!r.finishing) await finish(r, 'stopped');
    else await queue;
    return true;
  };

  const setPaused = async (value: boolean) => {
    await enqueue(() => publishNow('control.demo.paused', { paused: value }, newId()));
    paused = value;
    ambient.setPaused(value);
    const r = run;
    if (r && !r.finishing) {
      if (value && r.resumedAt !== null) {
        r.elapsedBase += clock.now() - r.resumedAt;
        r.resumedAt = null;
        clock.clearTimeout(r.timer);
        r.timer = undefined;
        clock.clearTimeout(r.sendTimer);
        r.sendTimer = undefined;
      } else if (!value && r.resumedAt === null) {
        r.resumedAt = clock.now();
        scheduleNext(r);
        scheduleSends(r);
      }
    }
  };

  const setPace = async (preset: PacePreset) => {
    const p = PACE_PRESETS[preset];
    await enqueue(() => publishNow('control.demo.speed', { ...p, label: preset }, newId()));
    pace = preset;
  };

  // ---- attract loop (M5): plays by itself when nobody is using the demo ----
  // Each cycle is an ordinary scenario run of the attract script (same control events, deterministic ids
  // from the run id). It starts after `idleMs` without activity, never while a presenter scenario runs or the
  // demo is paused, and any presenter command or kiosk touch stops it (finish() closes any open outage).
  const attract = {
    idleMs: Math.max(0, options.attract?.idleMs ?? 0),
    enabled: false,
    playing: false,
    cycle: 0,
    lastActivity: clock.now(),
    lastStop: null as AttractState['lastStop'],
    timer: undefined as TimerHandle | undefined,
  };
  attract.enabled = options.attract?.enabled ?? attract.idleMs > 0;

  const attractStartsInMs = (): number | null => {
    if (!attract.enabled || attract.playing || run || paused || closed || attract.idleMs <= 0) return null;
    return Math.max(0, attract.lastActivity + attract.idleMs - clock.now());
  };

  /** (Re)arm the idle timer from the current state. Safe to call any time. */
  const armIdle = () => {
    clock.clearTimeout(attract.timer);
    attract.timer = undefined;
    const due = attractStartsInMs();
    if (due === null) return;
    attract.timer = clock.setTimeout(() => {
      attract.timer = undefined;
      const left = attractStartsInMs();
      if (left === null) return;
      if (left > 0) return armIdle(); // activity moved the deadline
      log('[orchestrator] attract loop: idle, starting');
      void startAttract().catch((err: unknown) => log(`[orchestrator] attract start failed: ${(err as Error).message}`));
    }, due);
  };

  const startAttractCycle = async () => {
    if (!attract.playing || run || closed) return;
    attract.cycle += 1;
    await startScript(attractScript, seed, true);
  };

  const startAttract = async () => {
    if (!attract.enabled || attract.playing || run || paused || closed) return;
    clock.clearTimeout(attract.timer);
    attract.timer = undefined;
    attract.playing = true;
    attract.cycle = 0;
    attract.lastStop = null;
    log('[orchestrator] attract loop playing');
    await startAttractCycle();
  };

  /** Stop the loop (if playing), closing anything the current cycle opened. */
  const stopAttract = async (reason: NonNullable<AttractState['lastStop']>) => {
    if (attract.playing) {
      attract.playing = false;
      attract.lastStop = reason;
      log(`[orchestrator] attract loop stopped (${reason})`);
    }
    const r = run;
    if (r && r.attract) {
      if (!r.finishing) await finish(r, 'stopped');
      else await queue;
    }
  };

  /** A presenter command or kiosk touch: someone is here. */
  const activity = () => {
    attract.lastActivity = clock.now();
  };

  function afterRunEnded(r: ActiveRun, outcome: 'completed' | 'stopped' | 'elsewhere'): void {
    if (r.attract) {
      if (outcome === 'elsewhere' && attract.playing) {
        attract.playing = false;
        attract.lastStop = 'ended-elsewhere';
      }
      if (outcome === 'completed' && attract.playing) {
        // next cycle straight away (outside the publish queue job that is running now)
        void Promise.resolve()
          .then(startAttractCycle)
          .catch((err: unknown) => log(`[orchestrator] attract cycle failed: ${(err as Error).message}`));
        return;
      }
    } else {
      activity(); // idle counts from the end of a presenter scenario
    }
    armIdle();
  }

  const attractState = (): AttractState => {
    const r = run && run.attract ? run : null;
    return {
      enabled: attract.enabled,
      playing: attract.playing,
      idleMs: attract.idleMs,
      idleForMs: Math.max(0, clock.now() - attract.lastActivity),
      startsInMs: attractStartsInMs(),
      cycle: attract.cycle,
      run: r ? { runId: r.runId, startedAt: r.startedAtIso, elapsedMs: Math.round(elapsed(r)), stepId: r.stepId } : null,
      lastStop: attract.lastStop,
      script: attractInfo,
    };
  };

  const state = (): OrchestratorStateWithAttract => ({
    ambient: { rate: ambient.rate, running: ambient.running, sent: ambient.sent },
    pace,
    paused,
    scenarios: infos,
    activeRun: run
      ? { runId: run.runId, scenarioId: run.script.id, startedAt: run.startedAtIso, elapsedMs: Math.round(elapsed(run)), stepId: run.stepId }
      : null,
    attract: attractState(),
  });

  /** Presenter command: counts as activity and takes over from the attract loop. */
  const presenterCommand = async () => {
    activity();
    await stopAttract('presenter');
  };
  armIdle();

  // ---- HTTP API ----
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const only = (m: string) => {
      if (method !== m) throw new HttpError(405, 'method_not_allowed');
    };
    const route = async () => {
      if (path === '/health') {
        only('GET');
        return send(res, 200, { ok: true });
      }
      if (path === '/state') {
        only('GET');
        return send(res, 200, state());
      }
      if (path === '/scenarios/stop') {
        only('POST');
        const wasAttract = run?.attract ?? false;
        await presenterCommand();
        const stopped = (await stopRun()) || wasAttract;
        armIdle();
        return send(res, 200, { stopped });
      }
      if (path === '/attract') {
        only('POST');
        const body = await readJson(req);
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'validation_failed', ['enabled must be true or false']);
        const idleMs = body.idleMs;
        if (idleMs !== undefined && (typeof idleMs !== 'number' || !Number.isFinite(idleMs) || idleMs < 0 || idleMs > 3_600_000)) {
          throw new HttpError(400, 'validation_failed', ['idleMs must be a number of milliseconds between 0 and 3600000']);
        }
        if (typeof idleMs === 'number') attract.idleMs = Math.round(idleMs);
        attract.enabled = body.enabled;
        if (body.enabled) {
          await startAttract(); // plays now unless a presenter scenario runs or the demo is paused
        } else {
          activity();
          await stopAttract('disabled');
        }
        armIdle();
        return send(res, 200, state());
      }
      if (path === '/attract/touch') {
        only('POST');
        await readJson(req);
        activity();
        await stopAttract('touch');
        armIdle();
        return send(res, 200, state());
      }
      const m = /^\/scenarios\/([^/]+)\/start$/.exec(path);
      if (m) {
        only('POST');
        const body = await readJson(req);
        if (body.seed !== undefined && typeof body.seed !== 'string' && typeof body.seed !== 'number') {
          throw new HttpError(400, 'validation_failed', ['seed must be a string']);
        }
        const runSeed = body.seed === undefined || body.seed === '' ? seed : String(body.seed);
        const scenarioId = decodeURIComponent(m[1]!);
        if (!scriptById.has(scenarioId)) throw new HttpError(404, 'unknown_scenario', { scenarioId, available: [...scriptById.keys()] });
        await presenterCommand(); // takes over from the attract loop (its outage is closed first)
        const runId = await startRun(scenarioId, runSeed);
        return send(res, 200, { runId });
      }
      if (path === '/ambient') {
        only('POST');
        const body = await readJson(req);
        const rate = body.rate;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > MAX_AMBIENT_RATE) {
          throw new HttpError(400, 'validation_failed', [`rate must be a number between 0 and ${MAX_AMBIENT_RATE}`]);
        }
        await presenterCommand();
        if (run && !run.finishing) run.ambientBefore = rate; // a scenario holds its own rate; this applies after it
        else ambient.setRate(rate);
        armIdle();
        return send(res, 200, state());
      }
      if (path === '/pace') {
        only('POST');
        const body = await readJson(req);
        const preset = body.preset;
        if (preset !== 'normal' && preset !== 'slow' && preset !== 'fast') {
          throw new HttpError(400, 'validation_failed', ['preset must be one of normal, slow, fast']);
        }
        await presenterCommand();
        await setPace(preset);
        armIdle();
        return send(res, 200, state());
      }
      if (path === '/pause') {
        only('POST');
        const body = await readJson(req);
        if (typeof body.paused !== 'boolean') throw new HttpError(400, 'validation_failed', ['paused must be true or false']);
        await presenterCommand();
        await setPaused(body.paused);
        armIdle();
        return send(res, 200, state());
      }
      throw new HttpError(404, 'not_found');
    };
    if (closed) return send(res, 503, { error: 'shutting_down' });
    route().catch((err: unknown) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
      log(`[orchestrator] internal error: ${(err as Error)?.stack ?? String(err)}`);
      send(res, 500, { error: 'internal_error' });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await ambient.stop();
    await sub.unsubscribe();
    throw err;
  }
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  return {
    port,
    state,
    idle: async () => {
      for (;;) {
        const q = queue;
        await q;
        if (q === queue) return;
      }
    },
    close: (opts) =>
      (closing ??= (async () => {
        closed = true;
        attract.playing = false;
        clock.clearTimeout(attract.timer);
        attract.timer = undefined;
        const r = run;
        if (r && opts?.restore !== false) {
          if (!r.finishing) await finish(r, 'stopped').catch(() => {});
        } else if (r) {
          clock.clearTimeout(r.timer);
          clock.clearTimeout(r.sendTimer);
          r.finishing = true;
        }
        await queue;
        await Promise.allSettled([...sendsInFlight]);
        await ambient.stop();
        await sub.unsubscribe();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      })()),
  };
}
