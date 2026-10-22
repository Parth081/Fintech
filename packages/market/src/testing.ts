// Test helpers: build projected payment states with provider attempts (deterministic ids/times).
// Not used at runtime. Browser-safe.
import { applyEvent, SCHEMA_VERSION, corridorById, type AnyEvent, type EventType, type PayloadMap, type PaymentState, type StageName } from '@ct/contracts/browser';
import { providerProfile } from './catalog';

export interface AttemptSpec {
  providerId: string;
  ok: boolean;
  /** ms after the attempt is sent until its outcome. Default 1000. */
  latencyMs?: number;
}

export interface PaymentSpec {
  paymentId: string;
  corridorId?: string;
  amountMinor?: number;
  /** Time of payment.initiated (ms). */
  startMs: number;
  attempts?: AttemptSpec[];
  /** Stop after this many events of the sequence (to leave a payment mid-flight). */
  truncateAfter?: EventType;
}

export function buildEvents(spec: PaymentSpec): AnyEvent[] {
  const c = corridorById(spec.corridorId ?? 'US-IN')!;
  const amount = { amountMinor: spec.amountMinor ?? 125_000, currency: c.sourceCurrency };
  let t = spec.startMs;
  let n = 0;
  const events: AnyEvent[] = [];
  const add = <T extends EventType>(type: T, producer: StageName, payload: PayloadMap[T], dt = 100) => {
    t += dt;
    events.push({
      eventId: `${spec.paymentId}-${n++}-${type}`,
      type,
      schemaVersion: SCHEMA_VERSION,
      paymentId: spec.paymentId,
      occurredAt: new Date(t).toISOString(),
      correlationId: spec.paymentId,
      causationId: events.at(-1)?.eventId ?? null,
      producer,
      payload,
    } as AnyEvent);
  };
  add('payment.initiated', 'payment-api', {
    amount, targetCurrency: c.targetCurrency, corridor: c.id,
    debtor: { name: 'Fictional Sender', country: c.sourceCountry, accountId: 'ACC-S' },
    creditor: { name: 'Fictional Receiver', country: c.targetCountry, accountId: 'ACC-T' },
    idempotencyKey: spec.paymentId,
  }, 0);
  add('payment.screened', 'screening', { result: 'clear', listVersion: 'test' });
  add('payment.scored', 'risk', { fraudScore: 0.01, amlAlerts: [], decision: 'approve' });
  add('payment.quoted', 'fx', {
    quoteId: 'q', rate: c.midRate, spreadBps: 0, sourceAmount: amount, targetAmount: { amountMinor: 1, currency: c.targetCurrency }, expiresAt: new Date(t + 30_000).toISOString(),
  });
  const excluded: string[] = [];
  (spec.attempts ?? []).forEach((a, i) => {
    const p = providerProfile(a.providerId)!;
    add('payment.routed', 'routing', {
      providerId: a.providerId, rail: p.rail, estimatedFee: { amountMinor: 100, currency: amount.currency }, alternatives: [], attempt: i + 1, excludedProviders: [...excluded],
    });
    add('payment.sent', 'settlement', { providerId: a.providerId, messageType: 'pacs.008', messageId: `m-${i}`, attempt: i + 1 });
    const latency = a.latencyMs ?? 1000;
    if (a.ok) add('payment.settled', 'settlement', { providerId: a.providerId, settlementRef: `s-${i}`, statusMessage: 'pacs.002', attempt: i + 1 }, latency);
    else {
      add('payment.send_failed', 'settlement', { providerId: a.providerId, attempt: i + 1, reasonCode: 'AC04', reason: 'Closed account', statusMessage: 'pacs.002' }, latency);
      excluded.push(a.providerId);
    }
  });
  if (spec.truncateAfter) {
    const idx = events.findLastIndex((e) => e.type === spec.truncateAfter);
    if (idx >= 0) return events.slice(0, idx + 1);
  }
  return events;
}

export function buildState(spec: PaymentSpec): PaymentState {
  let s: PaymentState | undefined;
  for (const e of buildEvents(spec)) s = applyEvent(s, e);
  return s!;
}
