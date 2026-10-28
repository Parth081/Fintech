// verify:m5: independent re-derivation of the assistant's aggregate citations (eventId null). An aggregate
// carries a human-readable `source` saying how it was computed (services/assistant/src/knowledge.ts); each
// recogniser below recomputes it from the broker log with its own code. An aggregate no recogniser knows is
// reported as a failure ("cannot re-derive"), never accepted on trust.
import { isBalanced, TRANSITIONS, type AskContext, type BusEvent, type LedgerEntry, type Money, type PaymentStatus } from '@ct/contracts';
import type { EventLog } from './m5-analyze';

export interface AggregateContext {
  context: AskContext;
}

export type Derived = { known: false } | { known: true; value: unknown; how: string };

const FINAL: ReadonlySet<string> = new Set(['reconciled', 'held', 'rejected', 'failed', 'refunded']);

function ms(e: BusEvent | undefined): number | undefined {
  return e ? Date.parse(e.occurredAt) : undefined;
}

/** Latest status of a payment from its events (TRANSITIONS[type].to; null = no status change). */
export function latestStatus(events: readonly BusEvent[]): PaymentStatus | null {
  let s: PaymentStatus | null = null;
  for (const e of events) {
    const t = (TRANSITIONS as Record<string, { to: PaymentStatus | null } | undefined>)[e.type];
    if (t?.to) s = t.to;
  }
  return s;
}

/** Payment ids in a scope: a scenario run (any runId on the log named in the text) or every payment. */
export function scopePayments(log: EventLog, scopeText: string): { ids: string[]; label: string } {
  const runIds = new Set(
    log.events.filter((e) => e.type === 'control.scenario.started').map((e) => (e.payload as { runId: string }).runId),
  );
  const runId = [...runIds].find((r) => scopeText.includes(r));
  if (runId) {
    const w = log.runWindow(runId);
    const from = w.started ? log.events.indexOf(w.started) : 0;
    const to = w.ended ? log.events.indexOf(w.ended) : log.events.length - 1;
    const first = new Map<string, number>();
    log.events.forEach((e, i) => {
      if (!e.type.startsWith('control.') && !first.has(e.paymentId)) first.set(e.paymentId, i);
    });
    const ids = [...first].filter(([, i]) => i >= from && i <= to).map(([id]) => id);
    return { ids, label: `run ${runId}` };
  }
  return { ids: [...log.byPayment.keys()].filter((id) => log.paymentEvents(id).some((e) => e.type === 'payment.initiated')), label: 'all payments' };
}

function sumEntries(entries: LedgerEntry[], dir: 'debit' | 'credit', currency: string): number {
  return entries.filter((e) => e.direction === dir && e.amount.currency === currency).reduce((a, e) => a + e.amount.amountMinor, 0);
}

function journalEvents(events: readonly BusEvent[]): BusEvent[] {
  return events.filter((e) => e.type === 'ledger.posted' || e.type === 'payment.refunded');
}

function routingDecisions(events: readonly BusEvent[]): BusEvent[] {
  return events.filter((e) => e.type === 'payment.routed');
}

function codesOf(e: BusEvent): string[] {
  return (e as { trace?: { reasonCodes?: string[] } }).trace?.reasonCodes ?? [];
}

function rerouted(events: readonly BusEvent[]): boolean {
  const routes = routingDecisions(events);
  return routes.length > 1 || routes.some((r) => codesOf(r).some((c) => /_REROUTED$/.test(c)));
}

type Recogniser = (m: RegExpExecArray, c: { value: unknown; source: string }, log: EventLog, ctx: AggregateContext) => Derived;

const R: { re: RegExp; fn: Recogniser }[] = [
  // Durations between two recorded events.
  {
    re: /^(\S+)\.occurredAt \(([\w-]+)\) - (\S+)\.occurredAt \(([\w-]+)\)$/,
    fn: (m, _c, log) => {
      const a = ms(log.byId.get(m[2]!));
      const b = ms(log.byId.get(m[4]!));
      return a === undefined || b === undefined ? { known: true, value: undefined, how: 'event missing' } : { known: true, value: a - b, how: 'occurredAt difference' };
    },
  },
  {
    re: /^control\.provider_outage\.ended \(([\w-]+)\) - started \(([\w-]+)\) occurredAt$/,
    fn: (m, _c, log) => {
      const a = ms(log.byId.get(m[1]!));
      const b = ms(log.byId.get(m[2]!));
      return a === undefined || b === undefined ? { known: true, value: undefined, how: 'event missing' } : { known: true, value: a - b, how: 'outage duration' };
    },
  },
  { re: /^no positive duration$/, fn: () => ({ known: true, value: 0, how: 'zero by definition' }) },
  // Per payment.
  {
    re: /^count of ([\w.]+) events for this payment$/,
    fn: (m, _c, log, ctx) =>
      ctx.context.kind !== 'payment' ? { known: false } : { known: true, value: log.paymentEvents(ctx.context.paymentId).filter((e) => e.type === m[1]).length, how: 'count by type' },
  },
  {
    re: /^count of events for this payment$/,
    fn: (_m, _c, log, ctx) => (ctx.context.kind !== 'payment' ? { known: false } : { known: true, value: log.paymentEvents(ctx.context.paymentId).length, how: 'count' }),
  },
  // Journal totals: "sum of debit entries in <...event ids...>"
  {
    re: /^sum of (debit|credit) entries in (.+)$/,
    fn: (m, c, log, ctx) => {
      const every = /^every journal \((.+)\)$/.exec(m[2]!);
      const ids = [...m[2]!.matchAll(/[\w-]{8,}/g)].map((x) => x[0]).filter((id) => log.byId.has(id));
      let evs: BusEvent[] = every
        ? journalEvents(scopePayments(log, every[1]!).ids.flatMap((id) => log.paymentEvents(id)))
        : ids.map((id) => log.byId.get(id)!).filter((e) => e.type === 'ledger.posted' || e.type === 'payment.refunded');
      if (!every && evs.length === 0 && ctx.context.kind === 'payment') evs = journalEvents(log.paymentEvents(ctx.context.paymentId));
      const currency = (c.value as Money | undefined)?.currency;
      if (!currency || evs.length === 0) return { known: true, value: undefined, how: 'no journal found' };
      const total = evs.reduce((a, e) => a + sumEntries((e.payload as { entries: LedgerEntry[] }).entries, m[1] as 'debit' | 'credit', currency), 0);
      return { known: true, value: { amountMinor: total, currency }, how: `sum of ${m[1]} entries of ${evs.length} journal(s)` };
    },
  },
  // FX cost: spread cost = sourceAmount x spreadBps / 10,000 (rounded to the minor unit); total = fee + spread cost.
  {
    re: /^payment\.quoted \(([\w-]+)\) payload\.sourceAmount x payload\.spreadBps \/ 10000$/,
    fn: (m, _c, log) => {
      const q = log.byId.get(m[1]!);
      if (!q || q.type !== 'payment.quoted') return { known: true, value: undefined, how: 'quote missing' };
      const p = q.payload as { sourceAmount: Money; spreadBps: number };
      return { known: true, value: { amountMinor: Math.round((p.sourceAmount.amountMinor * p.spreadBps) / 10_000), currency: p.sourceAmount.currency }, how: 'spread cost' };
    },
  },
  {
    re: /^payment\.routed \(([\w-]+)\) payload\.estimatedFee \+ spread cost$/,
    fn: (m, _c, log) => {
      const r = log.byId.get(m[1]!);
      if (!r || r.type !== 'payment.routed') return { known: true, value: undefined, how: 'route missing' };
      const fee = (r.payload as { estimatedFee: Money }).estimatedFee;
      const q = log.paymentEvents(r.paymentId).filter((e) => e.type === 'payment.quoted').at(-1);
      if (!q) return { known: true, value: undefined, how: 'quote missing' };
      const p = q.payload as { sourceAmount: Money; spreadBps: number };
      if (p.sourceAmount.currency !== fee.currency) return { known: true, value: undefined, how: 'currency differs' };
      return { known: true, value: { amountMinor: fee.amountMinor + Math.round((p.sourceAmount.amountMinor * p.spreadBps) / 10_000), currency: fee.currency }, how: 'fee + spread cost' };
    },
  },
  // Provider health.
  {
    re: /^count of ([\w.]+) with providerId ([\w-]+) (?:for payments in (.+)|\((.+)\))$/,
    fn: (m, _c, log) => {
      const { ids } = scopePayments(log, m[3] ?? m[4] ?? '');
      const n = ids.flatMap((id) => log.paymentEvents(id)).filter((e) => e.type === m[1] && (e.payload as { providerId?: string }).providerId === m[2]).length;
      return { known: true, value: n, how: 'count by type and provider' };
    },
  },
  {
    re: /^settled \/ \(settled \+ refused\) for ([\w-]+) \((.+)\)$/,
    fn: (m, _c, log) => {
      const evs = scopePayments(log, m[2]!).ids.flatMap((id) => log.paymentEvents(id));
      const by = (t: string) => evs.filter((e) => e.type === t && (e.payload as { providerId?: string }).providerId === m[1]).length;
      const s = by('payment.settled');
      const r = by('payment.send_failed');
      return { known: true, value: s + r === 0 ? undefined : s / (s + r), how: 'success rate' };
    },
  },
  // Totals.
  {
    re: /^count of payment\.initiated \((.+)\)$/,
    fn: (m, _c, log) => ({ known: true, value: scopePayments(log, m[1]!).ids.length, how: 'payments in scope' }),
  },
  {
    re: /^count of ([\w.]+) \((.+)\)$/,
    fn: (m, _c, log) => {
      const evs = scopePayments(log, m[2]!).ids.flatMap((id) => log.paymentEvents(id));
      return { known: true, value: evs.filter((e) => e.type === m[1]).length, how: 'count by type in scope' };
    },
  },
  {
    re: /^count of ledger\.posted and payment\.refunded events \((.+)\)$/,
    fn: (m, _c, log) => ({ known: true, value: journalEvents(scopePayments(log, m[1]!).ids.flatMap((id) => log.paymentEvents(id))).length, how: 'journals in scope' }),
  },
  {
    re: /^journals whose debits differ from credits in any currency \((.+)\)$/,
    fn: (m, _c, log) => {
      const js = journalEvents(scopePayments(log, m[1]!).ids.flatMap((id) => log.paymentEvents(id)));
      return { known: true, value: js.filter((e) => !isBalanced((e.payload as { entries: LedgerEntry[] }).entries)).length, how: 'unbalanced journals' };
    },
  },
  {
    re: /^(?:payments whose latest status is (\w+) \((.+)\)|payments in (.+) with status (\w+))$/,
    fn: (m, _c, log) => {
      const status = m[1] ?? m[4]!;
      const scope = m[2] ?? m[3]!;
      return { known: true, value: scopePayments(log, scope).ids.filter((id) => latestStatus(log.paymentEvents(id)) === status).length, how: 'latest status' };
    },
  },
  {
    re: /^payments in (.+) not yet in a final status$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[1]!).ids.filter((id) => !FINAL.has(latestStatus(log.paymentEvents(id)) ?? '')).length,
      how: 'not final',
    }),
  },
  {
    re: /^sum of payment\.initiated amount for reconciled payments \((.+)\)$/,
    fn: (m, c, log) => {
      const currency = (c.value as Money | undefined)?.currency;
      if (!currency) return { known: true, value: undefined, how: 'no currency' };
      let total = 0;
      for (const id of scopePayments(log, m[1]!).ids) {
        const evs = log.paymentEvents(id);
        if (latestStatus(evs) !== 'reconciled') continue;
        const init = evs.find((e) => e.type === 'payment.initiated');
        const amt = (init?.payload as { amount?: Money } | undefined)?.amount;
        if (amt && amt.currency === currency) total += amt.amountMinor;
      }
      return { known: true, value: { amountMinor: total, currency }, how: 'sum of reconciled amounts' };
    },
  },
  {
    re: /^mean of reconciled\.occurredAt - initiated\.occurredAt \((.+)\)$/,
    fn: (m, _c, log) => {
      let sum = 0;
      let n = 0;
      for (const id of scopePayments(log, m[1]!).ids) {
        const evs = log.paymentEvents(id);
        const a = ms(evs.find((e) => e.type === 'payment.initiated'));
        const b = ms(evs.find((e) => e.type === 'payment.reconciled'));
        if (a !== undefined && b !== undefined) {
          sum += b - a;
          n++;
        }
      }
      return { known: true, value: n ? Math.round(sum / n) : undefined, how: 'mean end-to-end' };
    },
  },
  // M4: risk story of a run (held payments, alerts by kind / rule, linked payments) and the FX shock.
  {
    re: /^payments in (.+) that were held at least once$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[1]!).ids.filter((id) => log.paymentEvents(id).some((e) => e.type === 'payment.held')).length,
      how: 'payments with a payment.held event',
    }),
  },
  {
    re: /^count of risk\.alert_raised with (kind|rule) ([\w]+) for payments in (.+)$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[3]!).ids.flatMap((id) => log.paymentEvents(id)).filter((e) => e.type === 'risk.alert_raised' && (e.payload as Record<string, unknown>)[m[1]!] === m[2]).length,
      how: 'alerts by kind/rule',
    }),
  },
  {
    re: /^count of payload\.evidence\.relatedPaymentIds on risk\.alert_raised \(([\w-]+)\)$/,
    fn: (m, _c, log) => {
      const a = log.byId.get(m[1]!);
      const rel = a && a.type === 'risk.alert_raised' ? (a.payload as { evidence?: { relatedPaymentIds?: unknown } }).evidence?.relatedPaymentIds : undefined;
      return { known: true, value: Array.isArray(rel) ? rel.length : undefined, how: 'linked payments on the alert' };
    },
  },
  {
    re: /^payment\.quoted events coded FX_SHOCK_ACTIVE on corridor ([\w-]+) for payments in (.+)$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[2]!).ids.filter((id) => (log.paymentEvents(id).find((e) => e.type === 'payment.initiated')?.payload as { corridor?: string } | undefined)?.corridor === m[1]).flatMap((id) => log.paymentEvents(id)).filter((e) => e.type === 'payment.quoted' && codesOf(e).includes('FX_SHOCK_ACTIVE')).length,
      how: 'quotes priced under the shock',
    }),
  },
  {
    re: /^payments first seen between control\.scenario\.started and \.ended \((.+)\)$/,
    fn: (m, _c, log) => ({ known: true, value: scopePayments(log, m[1]!).ids.length, how: 'payments in run' }),
  },
  {
    re: /^payments in (.+) with more than one routing decision or a \*_REROUTED reason code$/,
    fn: (m, _c, log) => ({ known: true, value: scopePayments(log, m[1]!).ids.filter((id) => rerouted(log.paymentEvents(id))).length, how: 'rerouted' }),
  },
  {
    re: /^payments in (.+) that failed after a ledger posting or reconciled without one$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[1]!).ids.filter((id) => {
        const evs = log.paymentEvents(id);
        const st = latestStatus(evs);
        const posted = evs.some((e) => e.type === 'ledger.posted');
        return (st === 'failed' && posted) || (st === 'reconciled' && !posted);
      }).length,
      how: 'lost',
    }),
  },
  {
    re: /^payments in (.+) with a send_failed from ([\w-]+) followed by a routing decision for another provider$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[1]!).ids.filter((id) => {
        const evs = log.paymentEvents(id);
        const i = evs.findIndex((e) => e.type === 'payment.send_failed' && (e.payload as { providerId: string }).providerId === m[2]);
        return i >= 0 && evs.slice(i + 1).some((e) => e.type === 'payment.routed' && (e.payload as { providerId: string }).providerId !== m[2]);
      }).length,
      how: 'retried elsewhere',
    }),
  },
  {
    re: /^payments in (.+) with a routing decision coded (CIRCUIT_OPEN_REROUTED)\/(CIRCUIT_HALF_OPEN_REROUTED) while ([\w-]+) was blocked$/,
    fn: (m, _c, log) => ({
      known: true,
      value: scopePayments(log, m[1]!).ids.filter((id) =>
        log.paymentEvents(id).some((e) => e.type === 'payment.routed' && codesOf(e).some((c) => c === m[2] || c === m[3])),
      ).length,
      how: 'steered away (reason codes)',
    }),
  },
];

export function deriveAggregate(c: { field: string; value: unknown; source?: string }, log: EventLog, ctx: AggregateContext): Derived {
  const src = (c.source ?? '').trim();
  for (const r of R) {
    const m = r.re.exec(src);
    if (m) {
      const d = r.fn(m, { value: c.value, source: src }, log, ctx);
      if (d.known) return d;
    }
  }
  // Explicit machine form: field "count(<type>)" with optional "runId=..|paymentId=..|providerId=.." in source.
  const f = /^(?:count\((.+)\)|count:(.+))$/.exec(c.field.trim());
  if (f) {
    const type = (f[1] ?? f[2])!.trim();
    const runId = /runId=([\w-]+)/.exec(src)?.[1];
    let evs = runId ? scopePayments(log, runId).ids.flatMap((id) => log.paymentEvents(id)) : log.events;
    const pid = /paymentId=([\w-]+)/.exec(src)?.[1];
    const prov = /providerId=([\w-]+)/.exec(src)?.[1];
    if (pid) evs = evs.filter((e) => e.paymentId === pid);
    if (prov) evs = evs.filter((e) => (e.payload as { providerId?: string }).providerId === prov);
    return { known: true, value: evs.filter((e) => e.type === type).length, how: 'count(type)' };
  }
  return { known: false };
}
