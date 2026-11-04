// verify:m6 chaos phase: kill -9 every class of service while visitors and ambient traffic run, and let the
// supervisor heal them. Nothing here calls restart(): a service that does not come back by itself fails the
// check. The planner is pure (seeded); runChaos() does the I/O.
import { STAGES, type ServiceName } from '../launcher/launch';
import { mulberry32 } from '../traffic/generator';
import { analyzeRecoveries, type HealthSample, type KillRecord, type Recovery } from './m6-analyze';
import { http, sleep } from './m6-http';
import type { Rehearsal } from './m6-ctx';

/** Victim classes. `stages` stands for the six stage processes (one random stage per kill). */
export const KILL_CLASSES: readonly { name: string; services: readonly ServiceName[] }[] = [
  { name: 'stages', services: STAGES },
  { name: 'ledger', services: ['ledger'] },
  { name: 'orchestrator', services: ['orchestrator'] },
  { name: 'ops', services: ['ops'] },
  { name: 'assistant', services: ['assistant'] },
  { name: 'booth', services: ['booth'] },
  { name: 'gateway', services: ['gateway'] },
  { name: 'payment-api', services: ['payment-api'] },
  { name: 'broker', services: ['broker'] },
];

/**
 * Kill order: `perClass` rounds over every class (shuffled per round); stages pick a random stage, and over
 * the rounds all different stages are hit before one repeats when possible. The broker is always included.
 */
export function planKills(seed: number, perClass: number): ServiceName[] {
  const rand = mulberry32(seed ^ 0xc4a05);
  const out: ServiceName[] = [];
  const stagePool: ServiceName[] = [];
  for (let round = 0; round < perClass; round++) {
    const classes = [...KILL_CLASSES];
    for (let i = classes.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [classes[i], classes[j]] = [classes[j]!, classes[i]!];
    }
    for (const c of classes) {
      if (c.name === 'stages') {
        if (stagePool.length === 0) {
          stagePool.push(...STAGES);
          for (let i = stagePool.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [stagePool[i], stagePool[j]] = [stagePool[j]!, stagePool[i]!];
          }
        }
        out.push(stagePool.pop()!);
      } else out.push(c.services[0]!);
    }
  }
  return out;
}

export interface ChaosResult {
  kills: KillRecord[];
  recoveries: Recovery[];
  samples: HealthSample[];
  /** Kills where the system gave up (everything stopped) or crash() failed. */
  errors: string[];
}

function probeUrl(rh: Rehearsal, name: string): string | null {
  const u = rh.system!.urls;
  const m: Record<string, string | undefined> = {
    broker: `${rh.urls.brokerHttp}/health`,
    'payment-api': `${u.paymentApi}/health`,
    ledger: `${u.ledger}/health`,
    orchestrator: `${u.orchestrator}/health`,
    gateway: `${u.gateway}/health`,
    ops: `${u.ops}/health`,
    assistant: u.assistant ? `${u.assistant}/health` : undefined,
    booth: u.booth ? `${u.booth}/health` : undefined,
  };
  return m[name] ?? null;
}

/** Samples the supervisor's view every 100 ms; services under watch are also probed over HTTP. */
export function startSampler(rh: Rehearsal): { samples: HealthSample[]; watch: Set<string>; stop(): Promise<void> } {
  const samples: HealthSample[] = [];
  const watch = new Set<string>();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const view = rh.system!.health();
      const probes = new Map<string, boolean>();
      await Promise.all(
        [...watch].map(async (name) => {
          const url = probeUrl(rh, name);
          if (!url) return;
          probes.set(name, (await http('GET', url, undefined, {}, 1500)).status === 200);
        }),
      );
      const services: HealthSample['services'] = {};
      for (const v of view) services[v.name] = { running: v.running, restarts: v.restarts, healthy: v.running && (probes.get(v.name) ?? true) };
      samples.push({ at: Date.now(), services });
      await sleep(100);
    }
  })();
  return {
    samples,
    watch,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

/** Kill the planned victims one by one; each must be back (by the supervisor alone) before the next goes. */
export async function runChaos(rh: Rehearsal, plan: readonly ServiceName[], onKill?: (service: string, recovery: Recovery | null) => void): Promise<ChaosResult> {
  const system = rh.system!;
  const sampler = startSampler(rh);
  const kills: KillRecord[] = [];
  const recoveries: Recovery[] = [];
  const errors: string[] = [];
  const rand = mulberry32(rh.args.seed ^ 0x51ab);
  await sleep(1500);
  for (const name of plan) {
    if (rh.crashed()) {
      errors.push(`stopped before killing ${name}: ${rh.crashed()!.message.split('\n')[0]}`);
      break;
    }
    const before = system.health().find((h) => h.name === name);
    if (!before || !before.running) {
      errors.push(`${name} was not running before its kill`);
      continue;
    }
    sampler.watch.add(name);
    try {
      await system.crash(name);
    } catch (err) {
      errors.push(`crash(${name}) failed: ${(err as Error).message}`);
      sampler.watch.delete(name);
      continue;
    }
    const rec: KillRecord = { service: name, killedAt: Date.now(), restartsBefore: before.restarts };
    kills.push(rec);
    rh.say(`chaos: kill -9 ${name} (restarts so far ${before.restarts})`);
    // Wait for the supervisor (bound + a margin so a late recovery is still measured and then fails the check).
    const giveUpAt = rec.killedAt + rh.args.recoverBoundMs + 10_000;
    let recovery: Recovery | null = null;
    while (Date.now() < giveUpAt && !rh.crashed()) {
      await sleep(150);
      recovery = analyzeRecoveries([rec], sampler.samples, rh.args.recoverBoundMs)[0]!;
      if (recovery.recovered) break;
    }
    sampler.watch.delete(name);
    recovery ??= analyzeRecoveries([rec], sampler.samples, rh.args.recoverBoundMs)[0]!;
    recoveries.push(recovery);
    rh.say(`chaos: ${name} ${recovery.recovered ? `back after ${recovery.recoverMs} ms` : 'DID NOT COME BACK'}`);
    onKill?.(name, recovery);
    await sleep(1200 + Math.round(rand() * 2000));
  }
  await sampler.stop();
  return { kills, recoveries, samples: sampler.samples, errors };
}
