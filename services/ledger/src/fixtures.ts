// Test fixtures: settled payment states for the three demo corridors (synthetic data).
import { applyEvent, newId, type AnyEvent, type Money, type PaymentState } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';

export interface SettledFixture {
  state: PaymentState;
  /** eventId of the payment.settled event (the ledger's causation id). */
  settledEventId: string;
  events: AnyEvent[];
}

export function settledPayment(opts: {
  paymentId?: string;
  corridor: 'US-IN' | 'DE-BR' | 'GB-PH';
  debtorAccountId?: string;
  source: Money;
  target: Money;
  fee: Money;
  providerId: string;
}): SettledFixture {
  const paymentId = opts.paymentId ?? newId();
  const debtorCountry = opts.corridor.slice(0, 2);
  const init = sampleInitiatedPayload({
    amount: opts.source,
    targetCurrency: opts.target.currency,
    corridor: opts.corridor,
    debtor: { name: 'Fictional Debtor Ltd', country: debtorCountry, accountId: opts.debtorAccountId ?? `ACC-${debtorCountry}-0001` },
  });
  const events = [
    makeEvent('payment.initiated', paymentId, init),
    makeEvent('payment.screened', paymentId, { result: 'clear', listVersion: 'fict-2026.1' }, { producer: 'screening' }),
    makeEvent('payment.scored', paymentId, { fraudScore: 0.02, amlAlerts: [], decision: 'approve' }, { producer: 'risk' }),
    makeEvent('payment.quoted', paymentId, {
      quoteId: `q-${paymentId}`, rate: '1', spreadBps: 35, sourceAmount: opts.source, targetAmount: opts.target, expiresAt: '2030-01-01T00:00:00.000Z',
    }, { producer: 'fx' }),
    makeEvent('payment.routed', paymentId, { providerId: opts.providerId, rail: 'Rail-A (instant)', estimatedFee: opts.fee, alternatives: [] }, { producer: 'routing' }),
    makeEvent('payment.sent', paymentId, { providerId: opts.providerId, messageType: 'pacs.008', messageId: `m-${paymentId}` }, { producer: 'settlement' }),
    makeEvent('payment.settled', paymentId, { providerId: opts.providerId, settlementRef: `s-${paymentId}`, statusMessage: 'pacs.002' }, { producer: 'settlement' }),
  ] as AnyEvent[];
  let state: PaymentState | undefined;
  for (const e of events) state = applyEvent(state, e);
  return { state: state!, settledEventId: events[events.length - 1]!.eventId, events };
}

export const CORRIDOR_CASES = [
  {
    corridor: 'US-IN' as const,
    source: { amountMinor: 125_000, currency: 'USD' },
    target: { amountMinor: 10_375_000, currency: 'INR' },
    fee: { amountMinor: 188, currency: 'USD' },
    providerId: 'orion',
  },
  {
    corridor: 'DE-BR' as const,
    source: { amountMinor: 50_000, currency: 'EUR' },
    target: { amountMinor: 294_000, currency: 'BRL' },
    fee: { amountMinor: 100, currency: 'EUR' },
    providerId: 'vega',
  },
  {
    corridor: 'GB-PH' as const,
    source: { amountMinor: 20_000, currency: 'GBP' },
    target: { amountMinor: 1_442_000, currency: 'PHP' },
    fee: { amountMinor: 100, currency: 'GBP' },
    providerId: 'lyra',
  },
];
