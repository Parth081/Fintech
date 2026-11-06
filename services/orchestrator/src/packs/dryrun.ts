// Deterministic dry run of a compiled pack: walks the scenario clock without a broker, an orchestrator or any
// timers, and lists what the orchestrator would do and when (steps, control events, crafted payments with their
// idempotency keys). The same pack always gives the same list and the same digest, so a person can review it,
// a test can pin it, and `scenario:check` can prove the pack does what its "expected" section says.
import { craftedKey, craftedRequest, type ScenarioScript } from '../scenarios';
import { LISTED_PARTY_NAMES } from './compile';
import type { PackCheck, ScenarioPack } from './schema';

export interface DryRunEntry {
  atMs: number;
  kind: 'step' | 'control' | 'ambient' | 'payment';
  /** control.* event type for kind "control". */
  type?: string;
  detail: string;
  corridor?: string;
  listed?: boolean;
}

export interface ExpectationResult {
  id: string;
  text: string;
  /** pass/fail for machine-checkable expectations; "manual" = a person confirms it during a live rehearsal. */
  status: 'pass' | 'fail' | 'manual';
  detail: string;
}

export interface DryRunReport {
  scenarioId: string;
  runId: string;
  entries: DryRunEntry[];
  totals: { steps: number; payments: number; listedParties: number; paymentsByCorridor: Record<string, number>; lastPaymentAtMs: number | null };
  expectations: ExpectationResult[];
  digest: string;
}

function digestOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function dryRun(pack: ScenarioPack, script: ScenarioScript, runId = `run-1-${script.id}`): DryRunReport {
  const entries: DryRunEntry[] = [{ atMs: 0, kind: 'control', type: 'control.scenario.started', detail: script.title }];
  const openOutages: string[] = [];
  const openShocks: string[] = [];
  for (const step of script.steps) {
    entries.push({ atMs: step.atMs, kind: 'step', type: 'control.scenario.step', detail: `${step.id}: ${step.title}` });
    for (const a of step.actions ?? []) {
      switch (a.kind) {
        case 'outage.start':
          openOutages.push(a.providerId);
          entries.push({ atMs: step.atMs, kind: 'control', type: 'control.provider_outage.started', detail: `${a.providerId} ${a.mode}${a.failureRate !== undefined ? ` (${Math.round(a.failureRate * 100)}% refused)` : ''}` });
          break;
        case 'outage.end':
          openOutages.splice(openOutages.indexOf(a.providerId), 1);
          entries.push({ atMs: step.atMs, kind: 'control', type: 'control.provider_outage.ended', detail: a.providerId });
          break;
        case 'ambient.rate':
          entries.push({ atMs: step.atMs, kind: 'ambient', detail: `ambient rate ${a.rate}/s` });
          break;
        case 'fx_shock.start':
          openShocks.push(a.shockId);
          entries.push({ atMs: step.atMs, kind: 'control', type: 'control.fx_shock.started', detail: `${a.shockId} on ${a.corridorId} (${a.driftBps} bps, x${a.noiseMultiplier} volatility)` });
          break;
        case 'fx_shock.end':
          openShocks.splice(openShocks.indexOf(a.shockId), 1);
          entries.push({ atMs: step.atMs, kind: 'control', type: 'control.fx_shock.ended', detail: a.shockId });
          break;
        case 'payments.send':
          a.payments.forEach((p, k) => {
            const req = craftedRequest(p, runId);
            const listed = LISTED_PARTY_NAMES.has(req.debtor.name) || LISTED_PARTY_NAMES.has(req.creditor.name);
            entries.push({
              atMs: step.atMs + k * (a.spacingMs ?? 0),
              kind: 'payment',
              corridor: req.corridor,
              listed,
              detail: `${craftedKey(runId, step.id, a.label, k)} ${req.amount.currency} ${(req.amount.amountMinor / 100).toFixed(2)} ${req.debtor.accountId} -> ${req.creditor.accountId}`,
            });
          });
          break;
      }
    }
  }
  // Anything left open is restored when the run ends, exactly as the orchestrator does.
  for (const providerId of openOutages) entries.push({ atMs: script.durationMs, kind: 'control', type: 'control.provider_outage.ended', detail: `${providerId} (restored at the end)` });
  for (const shockId of openShocks) entries.push({ atMs: script.durationMs, kind: 'control', type: 'control.fx_shock.ended', detail: `${shockId} (restored at the end)` });
  entries.push({ atMs: script.durationMs, kind: 'control', type: 'control.scenario.ended', detail: 'completed' });
  entries.sort((a, b) => a.atMs - b.atMs); // stable: ties keep script order

  const payments = entries.filter((e) => e.kind === 'payment');
  const paymentsByCorridor: Record<string, number> = {};
  for (const p of payments) paymentsByCorridor[p.corridor!] = (paymentsByCorridor[p.corridor!] ?? 0) + 1;
  const totals = {
    steps: script.steps.length,
    payments: payments.length,
    listedParties: payments.filter((p) => p.listed).length,
    paymentsByCorridor,
    lastPaymentAtMs: payments.length ? Math.max(...payments.map((p) => p.atMs)) : null,
  };

  const evaluate = (check: PackCheck): { ok: boolean; detail: string } => {
    switch (check.kind) {
      case 'payments': {
        const n = check.corridor ? (paymentsByCorridor[check.corridor] ?? 0) : totals.payments;
        return { ok: n >= check.min, detail: `${n} payment(s)${check.corridor ? ` on ${check.corridor}` : ''}, need at least ${check.min}` };
      }
      case 'listed-parties':
        return { ok: totals.listedParties >= check.min, detail: `${totals.listedParties} listed-party payment(s), need at least ${check.min}` };
      case 'event': {
        const n = entries.filter((e) => e.type === `control.${check.type}`).length;
        return { ok: n > 0, detail: `${n} control.${check.type} event(s)` };
      }
    }
  };
  const expectations: ExpectationResult[] = pack.expected.map((x) => {
    if (!x.check) return { id: x.id, text: x.text, status: 'manual', detail: 'confirm by eye in a live rehearsal' };
    const r = evaluate(x.check);
    return { id: x.id, text: x.text, status: r.ok ? 'pass' : 'fail', detail: r.detail };
  });

  return { scenarioId: script.id, runId, entries, totals, expectations, digest: digestOf(JSON.stringify(entries)) };
}

export function formatDryRun(r: DryRunReport): string {
  const lines = [`Dry run of ${r.scenarioId} (${r.runId}), digest ${r.digest}`];
  for (const e of r.entries) {
    const t = `${(e.atMs / 1000).toFixed(1).padStart(6)}s`;
    lines.push(`  ${t}  ${e.kind.padEnd(8)} ${e.type ? `${e.type} ` : ''}${e.detail}${e.listed ? '  [listed party]' : ''}`);
  }
  lines.push(`  totals: ${r.totals.steps} steps, ${r.totals.payments} crafted payments (${r.totals.listedParties} naming a listed party)`);
  for (const x of r.expectations) lines.push(`  expected ${x.status.toUpperCase().padEnd(6)} ${x.id}: ${x.detail}`);
  return lines.join('\n');
}
