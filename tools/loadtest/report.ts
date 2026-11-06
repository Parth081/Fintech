// Pure maths and formatting for `npm run loadtest`. No I/O here so it is unit-tested (report.test.ts).

/** Nearest-rank percentile of an ascending-sorted array; null when empty. q in (0, 1]. */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export interface Latency {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function latencyStats(values: readonly number[]): Latency {
  const s = [...values].sort((a, b) => a - b);
  return { count: s.length, p50: percentile(s, 0.5), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s.at(-1) ?? null };
}

/** Offered rates of a stepped ramp: start, start*factor, ... (rounded to whole payments/s, strictly rising). */
export function rampRates(start: number, factor: number, steps: number): number[] {
  const out: number[] = [];
  let r = start;
  for (let i = 0; i < steps; i++) {
    const v = Math.max(out.length ? out[out.length - 1]! + 1 : 1, Math.round(r));
    out.push(v);
    r *= factor;
  }
  return out;
}

/** What the log says about one payment this run created. */
export interface PaymentRecord {
  /** Epoch ms of the first event (payment.initiated). */
  initiatedAt: number;
  /** Epoch ms of the first terminal status; undefined = not terminal. */
  terminalAt?: number;
  status: string;
}

export interface StepWindow {
  index: number;
  offeredRate: number;
  /** Epoch ms the sender started / finished this step's sending window. */
  startMs: number;
  endMs: number;
  /** Requests the sender made / that were accepted (new or duplicate) / that failed. */
  sent: number;
  accepted: number;
  errors: number;
}

export interface StepResult extends StepWindow {
  windowS: number;
  /** Accepted per second over the sending window. */
  intakeRate: number;
  /** Payments reaching a terminal status per second inside the window (any payment). */
  completedRate: number;
  /** Payments reaching `reconciled` per second inside the window. */
  reconciledRate: number;
  /** Payments initiated but not yet terminal (this run) at the window start / end. */
  backlogStart: number;
  backlogEnd: number;
  backlogGrowth: number;
  /** Initiation-to-reconciled latency (ms) of reconciled payments initiated in this window. */
  latencyMs: Latency;
  saturated: boolean;
  saturationReason?: string;
}

export interface SaturationRules {
  /** Saturated when completedRate < this fraction of intakeRate. */
  minDrainFraction: number;
  /** Saturated when intakeRate < this fraction of the offered rate (the front door cannot keep up). */
  minIntakeFraction: number;
}
export const DEFAULT_RULES: SaturationRules = { minDrainFraction: 0.9, minIntakeFraction: 0.9 };

const count = (xs: readonly PaymentRecord[], f: (r: PaymentRecord) => boolean) => xs.reduce((n, r) => n + (f(r) ? 1 : 0), 0);

/** Computes the metrics of one step from the log-derived records (all payments created by the run). */
export function summarizeStep(win: StepWindow, records: readonly PaymentRecord[], rules: SaturationRules = DEFAULT_RULES): StepResult {
  const windowS = Math.max(0.001, (win.endMs - win.startMs) / 1000);
  const inWin = (t: number | undefined) => t !== undefined && t >= win.startMs && t < win.endMs;
  const intakeRate = win.accepted / windowS;
  const completedRate = count(records, (r) => inWin(r.terminalAt)) / windowS;
  const reconciledRate = count(records, (r) => r.status === 'reconciled' && inWin(r.terminalAt)) / windowS;
  const backlogAt = (t: number) => count(records, (r) => r.initiatedAt < t && !(r.terminalAt !== undefined && r.terminalAt < t));
  const backlogStart = backlogAt(win.startMs);
  const backlogEnd = backlogAt(win.endMs);
  const lat = records
    .filter((r) => r.status === 'reconciled' && r.terminalAt !== undefined && r.initiatedAt >= win.startMs && r.initiatedAt < win.endMs)
    .map((r) => r.terminalAt! - r.initiatedAt);
  let saturationReason: string | undefined;
  if (win.errors > 0 && win.errors >= win.sent * 0.01) saturationReason = `${win.errors} of ${win.sent} requests failed`;
  else if (intakeRate < rules.minIntakeFraction * win.offeredRate) saturationReason = `accepted only ${intakeRate.toFixed(1)}/s of ${win.offeredRate}/s offered`;
  else if (completedRate < rules.minDrainFraction * intakeRate) saturationReason = `completed ${completedRate.toFixed(1)}/s of ${intakeRate.toFixed(1)}/s accepted`;
  return {
    ...win,
    windowS,
    intakeRate,
    completedRate,
    reconciledRate,
    backlogStart,
    backlogEnd,
    backlogGrowth: backlogEnd - backlogStart,
    latencyMs: latencyStats(lat),
    saturated: saturationReason !== undefined,
    saturationReason,
  };
}

export interface Saturation {
  /** Highest offered rate of a step that was not saturated (null when even the first was). */
  maxSustainedOfferedRate: number | null;
  /** Completed payments/s measured in that step. */
  maxSustainedCompletedRate: number | null;
  /** Offered rate of the first saturated step, null when none saturated (limit not reached). */
  saturationOfferedRate: number | null;
  saturationReason?: string;
  /** Highest completedRate seen in any step. */
  peakCompletedRate: number | null;
  reached: boolean;
}

export function findSaturation(steps: readonly StepResult[]): Saturation {
  const firstSat = steps.find((s) => s.saturated);
  const good = steps.filter((s) => !s.saturated && (!firstSat || s.index < firstSat.index));
  const best = good.at(-1);
  return {
    maxSustainedOfferedRate: best?.offeredRate ?? null,
    maxSustainedCompletedRate: best ? best.completedRate : null,
    saturationOfferedRate: firstSat?.offeredRate ?? null,
    saturationReason: firstSat?.saturationReason,
    peakCompletedRate: steps.length ? Math.max(...steps.map((s) => s.completedRate)) : null,
    reached: firstSat !== undefined,
  };
}

export interface MachineInfo {
  cpuModel: string;
  logicalCpus: number;
  totalMemGiB: number;
  platform: string;
  osRelease: string;
  node: string;
}

export interface LoadReport {
  generatedAt: string;
  machine: MachineInfo;
  config: Record<string, unknown>;
  mode: string;
  steps: StepResult[];
  overall: {
    sent: number;
    accepted: number;
    requestErrors: number;
    terminal: number;
    reconciled: number;
    notTerminalAtEnd: number;
    byStatus: Record<string, number>;
    latencyMs: Latency;
    totalS: number;
    drainS: number;
  };
  saturation: Saturation;
  checks: { id: string; title: string; ok: boolean; detail: string }[];
  ok: boolean;
}

const n = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));
const ms = (v: number | null) => (v === null ? 'n/a' : String(Math.round(v)));

export function renderMarkdown(r: LoadReport): string {
  const L: string[] = [];
  L.push('# Load test report', '', `Generated ${r.generatedAt}. Mode: ${r.mode}. Result: **${r.ok ? 'all checks passed' : 'CHECKS FAILED'}**.`, '');
  L.push('## Machine and configuration', '');
  L.push(`- CPU: ${r.machine.cpuModel} (${r.machine.logicalCpus} logical CPUs)`);
  L.push(`- RAM: ${r.machine.totalMemGiB} GiB; OS: ${r.machine.platform} ${r.machine.osRelease}; Node ${r.machine.node}`);
  for (const [k, v] of Object.entries(r.config)) L.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  L.push('', '## Steps', '');
  L.push('| step | offered/s | accepted/s | completed/s | reconciled/s | backlog end | backlog growth | p50 ms | p95 ms | p99 ms | errors | saturated |');
  L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const s of r.steps) {
    L.push(
      `| ${s.index + 1} | ${s.offeredRate} | ${n(s.intakeRate)} | ${n(s.completedRate)} | ${n(s.reconciledRate)} | ${s.backlogEnd} | ${s.backlogGrowth} | ` +
        `${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p95)} | ${ms(s.latencyMs.p99)} | ${s.errors} | ${s.saturated ? `yes (${s.saturationReason})` : 'no'} |`,
    );
  }
  const sat = r.saturation;
  L.push('', '## Saturation', '');
  L.push(
    sat.reached
      ? `- Saturation point: first reached at an offered rate of ${sat.saturationOfferedRate}/s (${sat.saturationReason}).`
      : '- Saturation point: not reached; the highest tested rate was still sustained (the limit is above what was tested).',
  );
  L.push(`- Highest offered rate sustained: ${sat.maxSustainedOfferedRate ?? 'none'}/s (measured ${n(sat.maxSustainedCompletedRate)} payments/s completed in that step).`);
  L.push(`- Peak completed rate in any step: ${n(sat.peakCompletedRate)} payments/s.`);
  const o = r.overall;
  L.push('', '## Whole run', '');
  L.push(`- ${o.sent} requests, ${o.accepted} accepted, ${o.requestErrors} request error(s); ${o.terminal} terminal, ${o.reconciled} reconciled, ${o.notTerminalAtEnd} not terminal at the end.`);
  L.push(`- Status: ${JSON.stringify(o.byStatus)}`);
  L.push(`- Initiation-to-reconciled latency (all reconciled, ms): p50 ${ms(o.latencyMs.p50)}, p95 ${ms(o.latencyMs.p95)}, p99 ${ms(o.latencyMs.p99)}, max ${ms(o.latencyMs.max)}`);
  L.push(`- Total ${n(o.totalS)} s including ${n(o.drainS)} s of drain after the last step.`);
  L.push('', '## Integrity checks', '');
  for (const c of r.checks) L.push(`- ${c.ok ? 'PASS' : 'FAIL'} ${c.title}: ${c.detail}`);
  L.push('');
  return L.join('\n');
}
