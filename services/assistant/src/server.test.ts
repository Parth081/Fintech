import { afterEach, describe, expect, it } from 'vitest';
import type { Answer, SuggestedQuestion } from '@ct/contracts';
import { InMemoryBus } from '@ct/event-bus';
import { startAssistant, type AssistantHandle } from './server';
import { syntheticScenarioLog } from './synthetic';

// Ports 37070-37099 are reserved for this worktree's services.
const PORT = 37091;

let handle: AssistantHandle | undefined;
let bus: InMemoryBus | undefined;
afterEach(async () => {
  await handle?.close();
  await bus?.close();
  handle = undefined;
  bus = undefined;
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('assistant service', () => {
  it('folds the log from the earliest offset and serves health, suggestions, ask and eval', async () => {
    bus = new InMemoryBus();
    const { events, kinds } = syntheticScenarioLog('provider-outage');
    for (const e of events) await bus.publish(e);
    handle = await startAssistant({ bus, host: '127.0.0.1', port: PORT, llmMode: 'off' });
    await waitFor(() => handle!.store.lastOffset === events.length - 1);
    const base = `http://127.0.0.1:${handle.port}`;
    expect(handle.port).toBe(PORT);

    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, llm: 'disabled' });

    const pid = [...kinds].find(([, k]) => k === 'retried')![0];
    const sug = (await (await fetch(`${base}/suggestions?context=payment:${pid}`)).json()) as SuggestedQuestion[];
    expect(sug.length).toBeGreaterThanOrEqual(4);
    expect(sug.map((s) => s.intent)).toContain('why_retried');
    expect((await fetch(`${base}/suggestions?context=bogus`)).status).toBe(400);

    const res = await fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify({ question: 'Why was it retried?', context: { kind: 'payment', paymentId: pid } }) });
    expect(res.status).toBe(200);
    const a = (await res.json()) as Answer;
    expect(a.intent).toBe('why_retried');
    expect(a.verified).toBe(true);
    expect(a.mode).toBe('grounded');
    expect(a.citations.length).toBeGreaterThan(0);
    expect(a.citations[0]).not.toHaveProperty('kind');

    // scenario ended on the log -> scripted questions were pre-answered
    const cached = (await (await fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify({ question: 'Was any payment lost?', context: { kind: 'scenario' } }) })).json()) as Answer;
    expect(cached.intent).toBe('outage_story');
    expect(cached.answer).toContain('Payments lost: 0');

    expect((await fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify({ question: 'x'.repeat(301), context: { kind: 'system' } }) })).status).toBe(400);
    expect((await fetch(`${base}/ask`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify({ question: 'hi', context: { kind: 'payment' } }) })).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);

    const report = (await (await fetch(`${base}/eval/report`)).json()) as { report: { total: number; passRate: number } };
    expect(report.report.total).toBeGreaterThanOrEqual(100);
    expect(report.report.passRate).toBe(1);
  });

  it('picks up events published after start', async () => {
    bus = new InMemoryBus();
    handle = await startAssistant({ bus, host: '127.0.0.1', port: PORT + 1, llmMode: 'off' });
    const base = `http://127.0.0.1:${handle.port}`;
    expect(((await (await fetch(`${base}/eval/report`)).json()) as { report: unknown }).report).toBeNull();
    const { events } = syntheticScenarioLog('provider-degraded', { payments: 12 });
    for (const e of events) await bus.publish(e);
    await waitFor(() => handle!.store.paymentCount === 12);
    const a = (await (await fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify({ question: 'How many payments ran during the scenario?', context: { kind: 'scenario' } }) })).json()) as Answer;
    expect(a.answer).toMatch(/^12 payments/);
  });
});
