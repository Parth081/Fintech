// In-memory projection of the event log, rebuilt from offset 0 on every start (the log is the source of
// truth for anything that happened): payment states, risk alerts, reconciliation results, control config.
import {
  ControlTimeline,
  applyEvent,
  isControlEvent,
  type AnyEvent,
  type BusEvent,
  type EventEnvelope,
  type Money,
  type PaymentState,
} from '@ct/contracts';

export interface AlertFact {
  eventId: string;
  offset: number;
  paymentId: string;
  raisedAt: string;
  payload: EventEnvelope<'risk.alert_raised'>['payload'];
}

export interface ReconFact {
  eventId: string;
  paymentId: string;
  providerId: string;
  detectedAt: string;
  matched: boolean;
  breaks: string[];
  expected: Money;
  reported: Money | null;
}

export class OpsProjection {
  readonly payments = new Map<string, PaymentState>();
  readonly alerts = new Map<string, AlertFact>();
  readonly alertsByPayment = new Map<string, string[]>();
  readonly recon = new Map<string, ReconFact>();
  readonly control = new ControlTimeline();
  /** Last offset applied to the in-memory state (-1 = none). */
  offset = -1;
  /** Last offset fully processed, including the service's database side effects (-1 = none). */
  processed = -1;
  rejected = 0;
  private waiters: { offset: number; resolve: () => void }[] = [];

  apply(event: BusEvent, offset: number): void {
    if (offset <= this.offset) return;
    if (isControlEvent(event)) {
      this.control.apply(event, offset);
    } else {
      const e = event as AnyEvent;
      try {
        this.payments.set(e.paymentId, applyEvent(this.payments.get(e.paymentId), e));
      } catch {
        this.rejected += 1;
      }
      if (e.type === 'risk.alert_raised' && !this.alerts.has(e.payload.alertId)) {
        this.alerts.set(e.payload.alertId, { eventId: e.eventId, offset, paymentId: e.paymentId, raisedAt: e.occurredAt, payload: e.payload });
        const list = this.alertsByPayment.get(e.paymentId) ?? [];
        list.push(e.payload.alertId);
        this.alertsByPayment.set(e.paymentId, list);
      }
      if (e.type === 'payment.reconciled' && !this.recon.has(e.paymentId)) {
        const state = this.payments.get(e.paymentId);
        const settled = state?.facts['payment.settled'];
        const quoted = state?.facts['payment.quoted'];
        const expected = quoted?.targetAmount ?? state?.initiated.amount ?? { amountMinor: 0, currency: 'USD' };
        this.recon.set(e.paymentId, {
          eventId: e.eventId,
          paymentId: e.paymentId,
          providerId: settled?.providerId ?? 'unknown',
          detectedAt: e.occurredAt,
          matched: e.payload.matched,
          breaks: e.payload.breaks ?? [],
          expected,
          reported: settled?.statementEntry?.amount ?? settled?.settledAmount ?? null,
        });
      }
    }
    this.offset = offset;
  }

  /** Mark an offset fully processed (state + side effects) and wake read-your-writes waiters. */
  done(offset: number): void {
    if (offset <= this.processed) return;
    this.processed = offset;
    if (this.waiters.length) {
      const ready = this.waiters.filter((w) => w.offset <= offset);
      this.waiters = this.waiters.filter((w) => w.offset > offset);
      for (const w of ready) w.resolve();
    }
  }

  /** Resolves once the event at `offset` has been applied (read-your-writes after a publish). */
  waitFor(offset: number, timeoutMs = 10_000): Promise<void> {
    if (offset <= this.processed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { offset, resolve: () => (clearTimeout(timer), resolve()) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`projection did not reach offset ${offset} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push(w);
    });
  }
}

/** Approximate USD value of an amount (synthetic static rates; display aggregates only, never decisions). */
const USD_PER_UNIT: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, INR: 1 / 83.25, BRL: 1 / 5.47, PHP: 1 / 57, JPY: 1 / 150 };
export function approxUsd(m: Money): number {
  const exp = m.currency === 'JPY' ? 0 : 2;
  return (m.amountMinor / 10 ** exp) * (USD_PER_UNIT[m.currency] ?? 1);
}
