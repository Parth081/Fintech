// Payment API: validates payment requests and publishes payment.initiated. Nothing else.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { newId, SCHEMA_VERSION, type AnyEvent, type EventEnvelope } from '@ct/contracts';
import type { EventBus, Subscription } from '@ct/event-bus';
import { samplePayment } from './sample';
import { validateIdempotencyKey, validatePaymentRequest, type PaymentRequest } from './validate';

export const MAX_BODY_BYTES = 64 * 1024;

export interface PaymentApiOptions {
  bus: EventBus;
  host?: string;
  port?: number;
  /** Quiet period used to decide the idempotency index has replayed the log before serving. */
  catchUpQuietMs?: number;
  log?: (line: string) => void;
}

export interface PaymentApiHandle {
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) {
    super(code);
  }
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'payload_too_large', { maxBytes: MAX_BODY_BYTES }));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large', { maxBytes: MAX_BODY_BYTES }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid_json', ['request body is not valid JSON']));
      }
    });
    req.on('error', reject);
  });
}

export async function startPaymentApi(options: PaymentApiOptions): Promise<PaymentApiHandle> {
  const { bus } = options;
  const log = options.log ?? (() => {});

  // --- idempotency index: key -> paymentId, rebuilt from the log on startup ---
  const keys = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  let lastActivity = Date.now();
  const indexSub: Subscription = await bus.subscribe(
    { group: `payment-api-idempotency-${process.pid}-${Math.random().toString(36).slice(2, 10)}`, from: 'earliest', ephemeral: true },
    (event) => {
      lastActivity = Date.now();
      if (event.type === 'payment.initiated' && !keys.has(event.payload.idempotencyKey)) {
        keys.set(event.payload.idempotencyKey, event.paymentId);
      }
    },
  );
  const quietMs = options.catchUpQuietMs ?? 100;
  const deadline = Date.now() + 10_000;
  while (Date.now() - lastActivity < quietMs && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  async function submit(request: PaymentRequest, idempotencyKey: string, startedAt: number): Promise<{ paymentId: string; created: boolean }> {
    const existing = keys.get(idempotencyKey);
    if (existing) return { paymentId: existing, created: false };
    const inFlight = pending.get(idempotencyKey);
    if (inFlight) return { paymentId: await inFlight, created: false };

    const paymentId = newId();
    const promise = (async () => {
      const event: EventEnvelope<'payment.initiated'> = {
        eventId: newId(),
        type: 'payment.initiated',
        schemaVersion: SCHEMA_VERSION,
        paymentId,
        occurredAt: new Date().toISOString(),
        correlationId: paymentId,
        causationId: null,
        producer: 'payment-api',
        payload: { ...request, idempotencyKey },
        trace: {
          stage: 'payment-api',
          decision: 'accepted',
          reasonCodes: ['VALIDATED'],
          inputs: { corridor: request.corridor, amount: request.amount, targetCurrency: request.targetCurrency, scenario: request.scenario ?? null },
          ruleVersion: 'stub-v1',
          latencyMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        },
      };
      await bus.publish(event as AnyEvent);
      keys.set(idempotencyKey, paymentId);
      return paymentId;
    })();
    pending.set(idempotencyKey, promise);
    try {
      await promise;
    } finally {
      pending.delete(idempotencyKey);
    }
    log(`[payment-api] initiated ${paymentId} ${request.corridor} ${request.amount.amountMinor} ${request.amount.currency}`);
    return { paymentId, created: true };
  }

  async function handlePayment(req: IncomingMessage, res: ServerResponse, sample: boolean): Promise<void> {
    const startedAt = performance.now();
    const body = await readBody(req);
    const obj = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    if (body !== undefined && !obj) throw new HttpError(400, 'validation_failed', ['body must be a JSON object']);
    if (!sample && !obj) throw new HttpError(400, 'validation_failed', ['body is required']);

    const key = validateIdempotencyKey(req.headers['idempotency-key'] ?? obj?.idempotencyKey);
    if (key === null) throw new HttpError(400, 'validation_failed', ['Idempotency-Key must be 1-128 printable ASCII characters']);

    const candidate = sample ? samplePayment(typeof obj?.scenario === 'string' ? obj.scenario : undefined) : obj;
    if (sample && obj?.scenario !== undefined && typeof obj.scenario !== 'string') {
      throw new HttpError(400, 'validation_failed', ['scenario must be a string']);
    }
    const result = validatePaymentRequest(candidate);
    if (!result.ok) throw new HttpError(400, 'validation_failed', result.details);

    const { paymentId, created } = await submit(result.value, key ?? newId(), startedAt);
    send(res, created ? 202 : 200, { paymentId, status: 'initiated', ...(created ? {} : { duplicate: true }) });
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, idempotency-key');
      res.setHeader('access-control-max-age', '600');
    }
    const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    const route = async () => {
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === '/health') {
        if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
        return send(res, 200, { ok: true });
      }
      if (path === '/payments' || path === '/payments/sample') {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        return handlePayment(req, res, path === '/payments/sample');
      }
      throw new HttpError(404, 'not_found');
    };

    route().catch((err: unknown) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('connection', 'close');
        return send(res, err.status, { error: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
      }
      log(`[payment-api] internal error: ${(err as Error)?.stack ?? String(err)}`);
      send(res, 500, { error: 'internal_error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  return {
    port,
    close: () =>
      (closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
        await indexSub.unsubscribe();
      })()),
  };
}
