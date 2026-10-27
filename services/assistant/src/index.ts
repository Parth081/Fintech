// @ct/assistant: the M5 AI explainer. Library export + CLI (tsx services/assistant/src/index.ts).
// It NARRATES facts the system already recorded; it never makes or changes a payment decision.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithSupervisor, serviceConfig } from '@ct/contracts';
import { createBus } from '@ct/event-bus';
import { sdkClientFromEnv } from './llm';
import { startAssistant } from './server';

export { startAssistant, type AssistantServiceOptions, type AssistantHandle } from './server';
export { Assistant, parseContext, contextKey, MAX_QUESTION_CHARS, type AssistantOptions, type LlmHealth } from './engine';
export { FactStore } from './store';
export { classify, type Intent } from './intents';
export { verifyAnswer, extractNumbers, tokenMatches, type VerifyResult, type NumberToken } from './verify';
export { fmt, type Fact, type FactKind } from './facts';
export { groundedDraft } from './grounded';
export { suggestionsFor, SCENARIO_QUESTIONS, SYSTEM_QUESTIONS } from './suggestions';
export { LLM_MODEL, LLM_TIMEOUT_MS, SYSTEM_PROMPT, TOOLS, phraseWithLlm, runTool, sdkClientFromEnv, LlmFailure, type LlmClient } from './llm';
export { generateQuestionBank, evaluate, keyFactPresent, type BankQuestion, type EvalReport, type KeyFact, type QuestionResult, type AnswerFn } from './eval';
export { syntheticScenarioLog, type SyntheticLog, type SyntheticScenarioId, type PaymentKind } from './synthetic';

async function main(): Promise<void> {
  const config = serviceConfig();
  const bus = await createBus(config, 'assistant');
  const llm = config.assistantLlm === 'auto' ? sdkClientFromEnv() : null;
  const handle = await startAssistant({
    bus,
    host: config.host,
    port: config.assistantPort,
    llm,
    llmMode: config.assistantLlm,
    log: (line) => console.log(line),
  });
  console.log(`[assistant] ready on http://${config.host}:${handle.port} (bus=${config.bus}, llm=${handle.assistant.health()})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[assistant] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await handle.close();
      await bus.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  exitWithSupervisor(shutdown);
}

const entry = process.argv[1];
if (entry && resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((err) => {
    console.error('[assistant] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
