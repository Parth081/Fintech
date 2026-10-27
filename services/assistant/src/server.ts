// HTTP service (node:http) for the assistant API in @ct/contracts assistant-api.ts.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EventBus, Subscription } from '@ct/event-bus';
import { Assistant, MAX_QUESTION_CHARS, parseContext } from './engine';
import { evaluate, generateQuestionBank, type EvalReport } from './eval';
import type { LlmClient } from './llm';
import { FactStore } from './store';

export interface AssistantServiceOptions {
  bus: EventBus;
  host?: string;
  port?: number;
  /** LLM client; null = none (grounded/cached only). Undefined = none as well (main() resolves it from env). */
  llm?: LlmClient | null;
  llmMode?: 'auto' | 'off';
  /** Milliseconds clock. */
  clock?: () => number;
  llmDeadlineMs?: number;
  log?: (line: string) => void;
}

export interface AssistantHandle {
  port: number;
  assistant: Assistant;
  store: FactStore;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startAssistant(opts: AssistantServiceOptions): Promise<AssistantHandle> {
  const store = new FactStore();
  const log = opts.log ?? (() => {});
  const assistantOpts: ConstructorParameters<typeof Assistant>[0] = { store, llmMode: opts.llmMode ?? (opts.llm ? 'auto' : 'off'), llm: opts.llm ?? null, log };
  if (opts.clock) assistantOpts.now = opts.clock;
  if (opts.llmDeadlineMs !== undefined) assistantOpts.llmDeadlineMs = opts.llmDeadlineMs;
  const assistant = new Assistant(assistantOpts);
  let lastReport: EvalReport | null = null;

  const sub: Subscription = await opts.bus.subscribe({ group: 'assistant', from: 'earliest', ephemeral: true }, (event, meta) => {
    store.apply(event, meta.offset);
    if (event.type === 'control.scenario.ended') assistant.warmCache();
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`[assistant] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://assistant.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, llm: assistant.health() });
    if (method === 'GET' && path === '/suggestions') {
      const ctx = parseContext(url.searchParams.get('context') ?? 'system');
      if (!ctx) return send(res, 400, { error: 'context must be payment:<id>, scenario or system' });
      return send(res, 200, assistant.suggestions(ctx));
    }
    if (method === 'POST' && path === '/ask') {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'body must be JSON { question, context }' });
      }
      const b = body as { question?: unknown; context?: unknown };
      if (typeof b.question !== 'string' || b.question.trim() === '') return send(res, 400, { error: 'question is required' });
      if (b.question.length > MAX_QUESTION_CHARS) return send(res, 400, { error: `question must be at most ${MAX_QUESTION_CHARS} characters` });
      const ctx = parseContext(b.context ?? { kind: 'system' });
      if (!ctx) return send(res, 400, { error: 'context must be { kind: "payment", paymentId } | { kind: "scenario" } | { kind: "system" }' });
      return send(res, 200, await assistant.ask(b.question, ctx));
    }
    if (method === 'GET' && path === '/eval/report') {
      if (!lastReport || url.searchParams.get('refresh') === '1') {
        const run = store.latestRun();
        if (!run) return send(res, 200, { report: null, reason: 'no scenario run recorded yet' });
        const logEvents = store.toLog();
        const bank = generateQuestionBank(run.scenarioId, logEvents);
        // grounded engine only: the report must not spend API calls
        const grounded = new Assistant({ store, llmMode: 'off' });
        lastReport = await evaluate((q, c) => grounded.ask(q, c), bank, { scenarioId: run.scenarioId, runId: run.runId });
      }
      return send(res, 200, { report: lastReport });
    }
    return send(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    assistant,
    store,
    async close() {
      await sub.unsubscribe();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
