// Starting points for `npm run scenario:new`. Each is a complete, runnable pack whose words still say TODO,
// so it passes the structure and dry-run checks but is not loaded into the orchestrator until a person has
// rewritten the story for the prospect (see docs/prospect-scenarios.md).
import type { PackAudience, ScenarioPack } from '../../services/orchestrator/src/packs/schema';

const TODO = 'TODO';

export function scaffold(name: string, audience: PackAudience): ScenarioPack {
  const base = {
    schemaVersion: 1 as const,
    name,
    title: `${TODO}: title for the ${audience} prospect`,
    audience,
    description: `${TODO}: two sentences a non-technical visitor can follow. Say what happens and what the audience should notice.`,
    durationMs: 60_000,
  };
  switch (audience) {
    case 'psp':
      return {
        ...base,
        steps: [
          { id: 'baseline', atMs: 0, title: `${TODO}: normal day`, narration: `${TODO}: describe the prospect's normal traffic in their own words.`, events: [{ type: 'ambient', rate: 5 }, { type: 'traffic', label: 'steady', corridor: 'US-IN', count: 6, amountMajor: { min: 400, max: 2400 }, spacingMs: 1000 }] },
          { id: 'incident', atMs: 10_000, title: `${TODO}: the incident`, narration: `${TODO}: what goes wrong, and what the audience should watch on screen.`, events: [{ type: 'provider_outage', providerId: 'orion', mode: 'degraded', failureRate: 0.6, reason: `${TODO}: why the partner fails` }, { type: 'traffic', label: 'during', corridor: 'US-IN', count: 8, amountMajor: { min: 500, max: 3000 }, spacingMs: 1200 }] },
          { id: 'recovery', atMs: 34_000, title: `${TODO}: recovery`, narration: `${TODO}: how the platform reacts and how the partner earns traffic back.`, events: [{ type: 'provider_recovery', providerId: 'orion' }] },
          { id: 'summary', atMs: 50_000, title: `${TODO}: what to remember`, narration: `${TODO}: one sentence on the outcome, and one on what is synthetic.` },
        ],
        expected: [
          { id: 'outage-opens', text: 'The partner outage starts on the control timeline.', check: { kind: 'event', type: 'provider_outage.started' } },
          { id: 'outage-closes', text: 'The partner is restored before the run ends.', check: { kind: 'event', type: 'provider_outage.ended' } },
          { id: 'volume', text: 'Enough crafted payments flow to show the effect.', check: { kind: 'payments', min: 10 } },
        ],
      };
    case 'bank':
      return {
        ...base,
        steps: [
          { id: 'baseline', atMs: 0, title: `${TODO}: normal day`, narration: `${TODO}: describe the bank's ordinary payment flow.`, events: [{ type: 'ambient', rate: 3 }, { type: 'traffic', label: 'usual', corridor: 'GB-PH', count: 5, amountMajor: { min: 120, max: 800 }, spacingMs: 1000 }] },
          { id: 'burst', atMs: 8000, title: `${TODO}: the burst`, narration: `${TODO}: what arrives and why screening reacts.`, events: [{ type: 'traffic', label: 'burst', corridor: 'US-IN', count: 8, amountMajor: { min: 3000, max: 21_000 }, spacingMs: 1000, listedParty: { side: 'creditor', count: 6 } }] },
          { id: 'queue', atMs: 24_000, title: `${TODO}: the queue`, narration: `${TODO}: what the operations console shows now.` },
          { id: 'decision', atMs: 40_000, title: `${TODO}: the decision`, narration: `${TODO}: who decides, and what stays untouched until then.` },
        ],
        expected: [
          { id: 'listed-volume', text: 'Several payments name a party resembling a listed entry.', check: { kind: 'listed-parties', min: 4 } },
          { id: 'cases-appear', text: 'Cases for those payments appear in the operations console.' },
        ],
      };
    case 'marketplace':
      return {
        ...base,
        steps: [
          { id: 'baseline', atMs: 0, title: `${TODO}: normal payouts`, narration: `${TODO}: describe the marketplace's seller payouts.`, events: [{ type: 'ambient', rate: 4 }, { type: 'traffic', label: 'payouts', corridor: 'GB-PH', count: 6, amountMajor: { min: 150, max: 900 }, spacingMs: 1000 }] },
          { id: 'shock', atMs: 10_000, title: `${TODO}: the market moves`, narration: `${TODO}: what moves and what the sellers feel.`, events: [{ type: 'fx_shock', shockId: 'swing', corridor: 'GB-PH', driftBps: 250, noiseMultiplier: 4, rampMs: 5000, reason: `${TODO}: why the rate moves` }, { type: 'traffic', label: 'during', corridor: 'GB-PH', count: 8, amountMajor: { min: 160, max: 700 }, spacingMs: 1500 }] },
          { id: 'calm', atMs: 34_000, title: `${TODO}: calm returns`, narration: `${TODO}: how pricing settles back.`, events: [{ type: 'fx_shock_end', shockId: 'swing' }] },
          { id: 'summary', atMs: 48_000, title: `${TODO}: what to remember`, narration: `${TODO}: one sentence on the outcome, and one on what is synthetic.` },
        ],
        expected: [
          { id: 'shock-opens', text: 'The FX shock starts on the control timeline.', check: { kind: 'event', type: 'fx_shock.started' } },
          { id: 'shock-closes', text: 'The FX shock ends before the run ends.', check: { kind: 'event', type: 'fx_shock.ended' } },
          { id: 'volume', text: 'Enough payouts flow to show the effect.', check: { kind: 'payments', min: 10, corridor: 'GB-PH' } },
        ],
      };
  }
}
