// Scenario packs: schema, copy policy, deterministic compile and dry run, folder loading, and a real orchestrator run.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isControlEvent, type ControlEvent } from '@ct/contracts';
import { InMemoryBus } from '@ct/event-bus';
import type { GeneratedPayment } from '../../../../tools/traffic/generator';
import type { SendResult } from '../../../../tools/traffic/send';
import { FakeClock } from '../clock';
import { startOrchestrator } from '../orchestrator';
import { validateScript } from '../scenarios';
import { compilePack, dryRun, EXAMPLE_PACKS_DIR, loadPacks, packFiles, parsePack, validatePack, type ScenarioPack } from './index';

const example = (name: string): ScenarioPack => {
  const json = JSON.parse(readFileSync(path.join(EXAMPLE_PACKS_DIR, `${name}.pack.json`), 'utf8'));
  const r = validatePack(json);
  expect(r.errors).toEqual([]);
  return r.pack!;
};
const raw = (name: string): any => JSON.parse(readFileSync(path.join(EXAMPLE_PACKS_DIR, `${name}.pack.json`), 'utf8'));

const tmp: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

describe('example packs', () => {
  it('ships the two example packs and both validate, compile and satisfy their checkable expectations', () => {
    const files = packFiles(EXAMPLE_PACKS_DIR).map((f) => path.basename(f));
    expect(files).toEqual(['bank-sanctions-backlog.pack.json', 'psp-acceptance-recovery.pack.json']);
    for (const name of ['psp-acceptance-recovery', 'bank-sanctions-backlog']) {
      const pack = example(name);
      const script = compilePack(pack);
      expect(() => validateScript(script)).not.toThrow();
      const report = dryRun(pack, script);
      expect(report.expectations.filter((x) => x.status === 'fail')).toEqual([]);
      expect(report.expectations.some((x) => x.status === 'pass')).toBe(true);
    }
  });

  it('bank pack names listed parties; psp pack uses an outage that is restored', () => {
    const bank = dryRun(example('bank-sanctions-backlog'), compilePack(example('bank-sanctions-backlog')));
    expect(bank.totals.listedParties).toBe(10);
    const psp = dryRun(example('psp-acceptance-recovery'), compilePack(example('psp-acceptance-recovery')));
    const types = psp.entries.map((e) => e.type);
    expect(types).toContain('control.provider_outage.started');
    expect(types).toContain('control.provider_outage.ended');
    expect(psp.totals.paymentsByCorridor['US-IN']).toBe(22);
  });
});

describe('determinism', () => {
  it('compiling and dry-running twice gives identical scripts, entries and digest; a different seed changes the traffic', () => {
    const pack = example('psp-acceptance-recovery');
    const a = dryRun(pack, compilePack(pack));
    const b = dryRun(structuredClone(pack), compilePack(structuredClone(pack)));
    expect(b).toEqual(a);
    expect(compilePack(pack)).toEqual(compilePack(pack));
    const other = { ...pack, seed: 'another-prospect' };
    expect(dryRun(other, compilePack(other)).digest).not.toBe(a.digest);
  });

  it('uses {run} account ids, so each run gets brand-new accounts but a stable idempotency key per payment', () => {
    const pack = example('bank-sanctions-backlog');
    const a = dryRun(pack, compilePack(pack), 'run-1-bank-sanctions-backlog');
    const b = dryRun(pack, compilePack(pack), 'run-2-bank-sanctions-backlog');
    expect(a.entries.find((e) => e.kind === 'payment')!.detail).not.toBe(b.entries.find((e) => e.kind === 'payment')!.detail);
    expect(new Set(a.entries.filter((e) => e.kind === 'payment').map((e) => e.detail.split(' ')[0])).size).toBe(a.totals.payments);
  });
});

describe('validation', () => {
  it('reports every problem with its path and never throws on junk', () => {
    expect(parsePack(null).errors).toEqual(['pack: must be a JSON object']);
    expect(parsePack('x').errors.length).toBe(1);
    const bad = raw('psp-acceptance-recovery');
    bad.name = 'Bad Name';
    bad.audience = 'retailer';
    bad.steps[1].events[0].providerId = 'acme';
    bad.steps[1].events[1].corridor = 'FR-JP';
    bad.steps[0].extra = true;
    const { errors } = parsePack(bad);
    expect(errors.join('\n')).toMatch(/pack\.name/);
    expect(errors.join('\n')).toMatch(/pack\.audience/);
    expect(errors.join('\n')).toMatch(/pack\.steps\[1\]\.events\[0\]\.providerId/);
    expect(errors.join('\n')).toMatch(/pack\.steps\[1\]\.events\[1\]\.corridor/);
    expect(errors.join('\n')).toMatch(/pack\.steps\[0\]\.extra: is not a known field/);
  });

  it('applies the orchestrator script rules: outage left open, steps out of order, payments after the end', () => {
    const open = raw('psp-acceptance-recovery');
    open.steps[3].events = open.steps[3].events.filter((e: any) => e.type !== 'provider_recovery');
    // An open outage is restored by the orchestrator at the end of a run, but validateScript rejects it on purpose.
    expect(validatePack(open).errors.join('\n')).toMatch(/outage left open/);
    const order = raw('psp-acceptance-recovery');
    order.steps[2].atMs = 5000;
    expect(validatePack(order).errors.join('\n')).toMatch(/out of order/);
    const late = raw('bank-sanctions-backlog');
    late.steps[1].events[0].spacingMs = 20_000;
    expect(validatePack(late).errors.join('\n')).toMatch(/still sending at the end/);
  });

  it('enforces the copy policy (ADR 0018): forbidden claims and real brands fail, denials pass', () => {
    const p = raw('psp-acceptance-recovery');
    p.steps[0].narration = 'Our platform is compliant and tamper-proof, and Stripe style payouts are guaranteed.';
    const text = validatePack(p).errors.join('\n');
    expect(text).toMatch(/"compliant"/);
    expect(text).toMatch(/tamper/i);
    expect(text).toMatch(/real brand "Stripe"/);
    const ok = raw('psp-acceptance-recovery');
    ok.steps[0].narration = 'The platform is not certified for any regulation and does not claim to be compliant.';
    expect(validatePack(ok).errors).toEqual([]);
  });

  it('treats TODO text as a draft that is not fit to load', () => {
    const p = raw('psp-acceptance-recovery');
    p.steps[0].title = 'TODO: write this';
    expect(validatePack(p).errors.join('\n')).toMatch(/TODO marker/);
  });
});

describe('loading from a folder', () => {
  const dirWith = (files: Record<string, unknown | string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packs-'));
    tmp.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    return dir;
  };

  it('loads good packs, skips bad ones with a reason, and refuses ids already in use or a name that differs from the file name', () => {
    const good = raw('psp-acceptance-recovery');
    const dir = dirWith({
      'psp-acceptance-recovery.pack.json': good,
      'broken.pack.json': '{ nope',
      'wrong-file.pack.json': good,
      'fraud-ring.pack.json': { ...good, name: 'fraud-ring' },
      'notes.txt': 'ignored',
    });
    const r = loadPacks(dir, ['fraud-ring']);
    expect(r.packs.map((p) => p.script.id)).toEqual(['psp-acceptance-recovery']);
    const reasons = Object.fromEntries(r.problems.map((p) => [path.basename(p.file), p.errors.join(' ')]));
    expect(reasons['broken.pack.json']).toMatch(/not valid JSON/);
    expect(reasons['wrong-file.pack.json']).toMatch(/must match the file name/);
    expect(reasons['fraud-ring.pack.json']).toMatch(/already used/);
  });

  it('a missing folder is simply empty', () => {
    expect(loadPacks(path.join(tmpdir(), 'does-not-exist-packs'))).toEqual({ packs: [], problems: [] });
  });
});

describe('running a pack in the real orchestrator', () => {
  it('a pack placed in PACKS_DIR appears as a scenario and runs end to end with no stage changes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packs-run-'));
    tmp.push(dir);
    writeFileSync(path.join(dir, 'psp-acceptance-recovery.pack.json'), JSON.stringify(raw('psp-acceptance-recovery')));
    process.env.PACKS_DIR = dir;
    const bus = new InMemoryBus();
    const clock = new FakeClock();
    const sent: { key: string; corridor: string }[] = [];
    const send = async (_u: string, p: GeneratedPayment): Promise<SendResult> => {
      if (p.idempotencyKey.startsWith('scenario-')) sent.push({ key: p.idempotencyKey, corridor: p.body.corridor });
      return { outcome: 'accepted', status: 202, paymentId: p.idempotencyKey };
    };
    let orch;
    try {
      orch = await startOrchestrator({ bus, clock, host: '127.0.0.1', port: 0, seed: 'pack-seed', ambientRate: 0, paymentApiUrl: 'http://127.0.0.1:1', send });
    } finally {
      delete process.env.PACKS_DIR;
    }
    cleanups.push(() => orch.close());
    const base = `http://127.0.0.1:${orch.port}`;
    const state = (await (await fetch(`${base}/state`)).json()) as { scenarios: { id: string; steps: unknown[] }[] };
    expect(state.scenarios.map((s) => s.id)).toEqual(['provider-outage', 'provider-degraded', 'fraud-ring', 'fx-spike', 'sanctions-hit', 'psp-acceptance-recovery']);

    const start = await fetch(`${base}/scenarios/psp-acceptance-recovery/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(start.status).toBe(200);
    for (let done = 0; done < 70_000; done += 500) {
      await clock.advance(500);
      await orch.idle();
      await new Promise((r) => setImmediate(r));
    }
    const controls = bus.events.filter(isControlEvent) as ControlEvent[];
    const types = controls.map((e) => e.type);
    expect(types[0]).toBe('control.scenario.started');
    expect(types.at(-1)).toBe('control.scenario.ended');
    expect(types.filter((t) => t === 'control.scenario.step')).toHaveLength(5);
    expect(types.indexOf('control.provider_outage.started')).toBeLessThan(types.indexOf('control.provider_outage.ended'));
    // The real run sends exactly what the dry run predicted.
    const predicted = dryRun(example('psp-acceptance-recovery'), compilePack(example('psp-acceptance-recovery')), `run-1-psp-acceptance-recovery`);
    expect(sent.length).toBe(predicted.totals.payments);
    expect(sent.filter((s) => s.corridor === 'US-IN').length).toBe(predicted.totals.paymentsByCorridor['US-IN']);
  });
});
