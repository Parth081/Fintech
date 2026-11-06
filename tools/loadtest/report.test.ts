import { describe, expect, it } from 'vitest';
import { parseLoadArgs, plannedRates } from './args';
import { findSaturation, latencyStats, percentile, rampRates, renderMarkdown, summarizeStep, type LoadReport, type PaymentRecord } from './report';

describe('percentile (nearest rank)', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  it('matches hand-computed values', () => {
    expect(percentile(s, 0.5)).toBe(50);
    expect(percentile(s, 0.95)).toBe(95);
    expect(percentile(s, 0.99)).toBe(99);
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
  it('latencyStats sorts its input and does not mutate it', () => {
    const v = [30, 10, 20, 40];
    expect(latencyStats(v)).toEqual({ count: 4, p50: 20, p95: 40, p99: 40, max: 40 });
    expect(v).toEqual([30, 10, 20, 40]);
  });
});

describe('rampRates', () => {
  it('doubles from the start and rises strictly', () => {
    expect(rampRates(25, 2, 4)).toEqual([25, 50, 100, 200]);
    expect(rampRates(1, 1.1, 4)).toEqual([1, 2, 3, 4]);
  });
});

// 10 s window [0, 10000). Offered 10/s.
const win = { index: 0, offeredRate: 10, startMs: 0, endMs: 10_000, sent: 100, accepted: 100, errors: 0 };
const rec = (initiatedAt: number, latency: number | null, status = 'reconciled'): PaymentRecord => ({
  initiatedAt,
  terminalAt: latency === null ? undefined : initiatedAt + latency,
  status: latency === null ? 'initiated' : status,
});

describe('summarizeStep', () => {
  it('keeps up: rates, backlog and latency', () => {
    const records = Array.from({ length: 100 }, (_, i) => rec(i * 100, 50 + (i % 10)));
    const s = summarizeStep(win, records);
    expect(s.intakeRate).toBe(10);
    expect(s.completedRate).toBe(10);
    expect(s.reconciledRate).toBe(10);
    expect(s.backlogEnd).toBe(0);
    expect(s.backlogGrowth).toBe(0);
    expect(s.latencyMs.p50).toBe(54);
    expect(s.latencyMs.max).toBe(59);
    expect(s.saturated).toBe(false);
  });
  it('falls behind: backlog grows and the step is saturated', () => {
    // Everything initiated in the window, but only 40 finish inside it.
    const records = Array.from({ length: 100 }, (_, i) => rec(i * 100, i < 40 ? 100 : 20_000));
    const s = summarizeStep(win, records);
    expect(s.completedRate).toBe(4);
    expect(s.backlogStart).toBe(0);
    expect(s.backlogEnd).toBe(60);
    expect(s.backlogGrowth).toBe(60);
    expect(s.saturated).toBe(true);
    expect(s.saturationReason).toMatch(/completed 4\.0\/s of 10\.0\/s/);
  });
  it('counts non-reconciled terminals as completions but not in latency', () => {
    const records = [rec(0, 10), rec(100, 10, 'held'), rec(200, 10, 'rejected')];
    const s = summarizeStep({ ...win, sent: 3, accepted: 3, offeredRate: 0.3 }, records);
    expect(s.completedRate).toBeCloseTo(0.3);
    expect(s.reconciledRate).toBeCloseTo(0.1);
    expect(s.latencyMs.count).toBe(1);
  });
  it('flags request errors and a front door that cannot accept the offered rate', () => {
    expect(summarizeStep({ ...win, errors: 5, accepted: 95 }, []).saturationReason).toMatch(/5 of 100 requests failed/);
    expect(summarizeStep({ ...win, accepted: 50 }, []).saturationReason).toMatch(/accepted only 5\.0\/s of 10\/s/);
  });
});

describe('findSaturation', () => {
  const mk = (index: number, offeredRate: number, completedRate: number, saturated: boolean) =>
    ({ index, offeredRate, completedRate, saturated, saturationReason: saturated ? 'x' : undefined }) as never;
  it('reports the last good step before the first saturated one', () => {
    const r = findSaturation([mk(0, 25, 25, false), mk(1, 50, 49, false), mk(2, 100, 70, true), mk(3, 200, 72, true)]);
    expect(r).toMatchObject({ maxSustainedOfferedRate: 50, maxSustainedCompletedRate: 49, saturationOfferedRate: 100, peakCompletedRate: 72, reached: true });
  });
  it('says not reached when no step saturates, and none sustained when the first does', () => {
    expect(findSaturation([mk(0, 25, 25, false)])).toMatchObject({ reached: false, saturationOfferedRate: null, maxSustainedOfferedRate: 25 });
    expect(findSaturation([mk(0, 25, 5, true)])).toMatchObject({ reached: true, maxSustainedOfferedRate: null });
  });
});

describe('args and markdown', () => {
  it('parses rate, ramp and none mix', () => {
    expect(plannedRates(parseLoadArgs(['--rate', 'ramp', '--ramp-start', '10', '--ramp-steps', '3']))).toEqual([10, 20, 40]);
    const a = parseLoadArgs(['--rate=75', '--duration', '30', '--mix', 'none', '--report', 'x.json']);
    expect(plannedRates(a)).toEqual([75]);
    expect(a.duration).toBe(30);
    expect(a.mix).toEqual({});
    expect(() => parseLoadArgs(['--bogus'])).toThrow(/Unknown option/);
  });
  it('renders a table row per step', () => {
    const step = summarizeStep(win, Array.from({ length: 100 }, (_, i) => rec(i * 100, 50)));
    const report = {
      generatedAt: 'now', machine: { cpuModel: 'cpu', logicalCpus: 8, totalMemGiB: 16, platform: 'p', osRelease: 'r', node: 'v1' },
      config: { stageDelayMs: 0 }, mode: 'launched', steps: [step],
      overall: { sent: 100, accepted: 100, requestErrors: 0, terminal: 100, reconciled: 100, notTerminalAtEnd: 0, byStatus: { reconciled: 100 }, latencyMs: latencyStats([50]), totalS: 12, drainS: 1 },
      saturation: findSaturation([step]), checks: [{ id: 'a', title: 't', ok: true, detail: 'd' }], ok: true,
    } as LoadReport;
    const md = renderMarkdown(report);
    expect(md).toContain('| 1 | 10 | 10.0 | 10.0 | 10.0 | 0 | 0 | 50 | 50 | 50 | 0 | no |');
    expect(md).toContain('stageDelayMs: 0');
  });
});
