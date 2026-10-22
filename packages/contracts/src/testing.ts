// Builders for tests. Import from '@ct/contracts/testing'.
import type { AnyEvent, EventEnvelope, EventType, PayloadMap, StageName } from './events';
import { SCHEMA_VERSION } from './events';
import { newId } from './ids';

let clock = Date.parse('2026-01-01T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();

export function sampleInitiatedPayload(overrides: Partial<PayloadMap['payment.initiated']> = {}): PayloadMap['payment.initiated'] {
  return {
    amount: { amountMinor: 125_000, currency: 'USD' },
    targetCurrency: 'INR',
    corridor: 'US-IN',
    debtor: { name: 'Northwind Marketplace', country: 'US', accountId: 'ACC-US-0001' },
    creditor: { name: 'Asha Textiles', country: 'IN', accountId: 'ACC-IN-0001' },
    idempotencyKey: newId(),
    ...overrides,
  };
}

export function makeEvent<T extends EventType>(
  type: T,
  paymentId: string,
  payload: PayloadMap[T],
  extra: Partial<Omit<EventEnvelope<T>, 'type' | 'paymentId' | 'payload'>> = {},
): EventEnvelope<T> {
  const producer: StageName = extra.producer ?? 'payment-api';
  return {
    eventId: newId(),
    type,
    schemaVersion: SCHEMA_VERSION,
    paymentId,
    occurredAt: tick(),
    correlationId: paymentId,
    causationId: null,
    producer,
    payload,
    ...extra,
  };
}

/** A complete happy-path event sequence for one payment, initiated -> reconciled. */
export function happyPath(paymentId = newId()): AnyEvent[] {
  const init = sampleInitiatedPayload();
  const usd = init.amount;
  const inr = { amountMinor: 10_406_250, currency: 'INR' };
  return [
    makeEvent('payment.initiated', paymentId, init),
    makeEvent('payment.screened', paymentId, { result: 'clear', listVersion: 'fict-2026.1' }, { producer: 'screening' }),
    makeEvent('payment.scored', paymentId, { fraudScore: 0.04, amlAlerts: [], decision: 'approve' }, { producer: 'risk' }),
    makeEvent('payment.quoted', paymentId, {
      quoteId: 'q-1', rate: '83.2500', spreadBps: 0, sourceAmount: usd, targetAmount: inr, expiresAt: tick(),
    }, { producer: 'fx' }),
    makeEvent('payment.routed', paymentId, {
      providerId: 'orion', rail: 'Rail-A (instant)', estimatedFee: { amountMinor: 150, currency: 'USD' }, alternatives: [],
    }, { producer: 'routing' }),
    makeEvent('payment.sent', paymentId, { providerId: 'orion', messageType: 'pacs.008', messageId: 'm-1' }, { producer: 'settlement' }),
    makeEvent('payment.settled', paymentId, { providerId: 'orion', settlementRef: 's-1', statusMessage: 'pacs.002' }, { producer: 'settlement' }),
    makeEvent('ledger.posted', paymentId, {
      journalId: 'j-1',
      entries: [
        { account: 'customer:ACC-US-0001', direction: 'debit', amount: usd },
        { account: 'fx-position:USD', direction: 'credit', amount: usd },
        { account: 'fx-position:INR', direction: 'debit', amount: inr },
        { account: 'provider:orion:payable', direction: 'credit', amount: inr },
      ],
    }, { producer: 'ledger' }),
    makeEvent('payment.reconciled', paymentId, { statementRef: 'camt.053-1', matched: true }, { producer: 'reconciliation' }),
  ] as AnyEvent[];
}
