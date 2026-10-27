import { describe, expect, it } from 'vitest';
import { Assistant } from './engine';
import { evaluate, generateQuestionBank, latestRunId } from './eval';
import { FactStore } from './store';
import { syntheticScenarioLog, type SyntheticScenarioId } from './synthetic';

describe.each(['provider-outage', 'provider-degraded'] as SyntheticScenarioId[])('evaluation on %s', (scenarioId) => {
  const { events } = syntheticScenarioLog(scenarioId);

  it('generates at least 100 questions with key facts', () => {
    const bank = generateQuestionBank(scenarioId, events);
    expect(bank.length).toBeGreaterThanOrEqual(100);
    expect(new Set(bank.map((q) => q.id)).size).toBe(bank.length);
    expect(bank.filter((q) => q.expected.length > 0).length).toBeGreaterThan(bank.length * 0.9);
    const intents = new Set(bank.map((q) => q.intent));
    for (const i of ['outage_story', 'provider_health', 'ledger_proof', 'totals', 'why_this_route', 'why_retried', 'fx_rate_and_cost', 'how_long', 'why_held', 'why_rejected', 'payment_summary']) {
      expect(intents.has(i), i).toBe(true);
    }
  });

  it('grounded engine passes 100% (verified, key facts present, every number cited)', async () => {
    const store = FactStore.fromLog(events);
    const assistant = new Assistant({ store, llmMode: 'off' });
    const bank = generateQuestionBank(scenarioId, events);
    const report = await evaluate((q, c) => assistant.ask(q, c), bank, { scenarioId, runId: latestRunId(scenarioId, events) });
    const failures = report.results.filter((r) => !r.pass).map((r) => `${r.id} [${r.answerIntent}] missing=${r.missing.join('|')}: ${r.answer}`);
    expect(failures).toEqual([]);
    expect(report.passRate).toBe(1);
    expect(report.total).toBeGreaterThanOrEqual(100);
  });

  it('answers stay short (<= ~120 words)', async () => {
    const store = FactStore.fromLog(events);
    const assistant = new Assistant({ store, llmMode: 'off' });
    const bank = generateQuestionBank(scenarioId, events);
    for (const q of bank) {
      const a = await assistant.ask(q.question, q.context);
      expect(a.answer.split(/\s+/).length, a.answer).toBeLessThanOrEqual(135);
      expect(a.followUps.length).toBeGreaterThanOrEqual(2);
      expect(a.followUps.length).toBeLessThanOrEqual(4);
    }
  });
});
