// reconciliation stage: three-way match of provider statement (camt.053 line), ledger and quote.
//   ledger.posted -> payment.reconciled { matched, breaks[] }
import { formatMoney, type LedgerEntry, type Money, type PayloadMap, type PaymentState } from '@ct/contracts';
import { shortRef, type Outcome, type Step } from './common';

export const RECON_RULE_VERSION = 'recon-v1';

/** Sum of credits to provider:<id>:payable in the given currency (what we owe the provider). */
export function providerPayable(entries: LedgerEntry[], providerId: string, currency: string): Money | null {
  // M2 ledger chart: provider:<id>:payable:<CCY>; M1 stub: provider:<id>:payable.
  const accounts = new Set([`provider:${providerId}:payable`, `provider:${providerId}:payable:${currency}`]);
  const lines = entries.filter((e) => accounts.has(e.account) && e.direction === 'credit' && e.amount.currency === currency);
  if (lines.length === 0) return null;
  return { amountMinor: lines.reduce((s, e) => s + e.amount.amountMinor, 0), currency };
}

const fmt = (m: Money) => `${m.amountMinor} ${m.currency}`;

export interface ReconResult {
  matched: boolean;
  breaks: string[];
  statementRef: string;
  statement: Money | null;
  ledger: Money | null;
  quote: Money;
}

/** Pure matching rules, exported for tests and for the UI. */
export function reconcile(state: PaymentState, posted: PayloadMap['ledger.posted']): ReconResult | null {
  const settled = state.facts['payment.settled'];
  const quoted = state.facts['payment.quoted'];
  if (!settled || !quoted) return null;
  const quote = quoted.targetAmount;
  const entry = settled.statementEntry;
  const ledger = providerPayable(posted.entries, settled.providerId, quote.currency);
  const breaks: string[] = [];

  if (!ledger) breaks.push(`LEDGER_PAYABLE_MISSING: no credit to provider:${settled.providerId}:payable in ${quote.currency}`);

  if (entry) {
    const s = entry.amount;
    if (s.currency !== quote.currency) breaks.push(`CURRENCY_MISMATCH: statement ${s.currency} vs quote ${quote.currency}`);
    else if (ledger && s.amountMinor !== ledger.amountMinor) {
      breaks.push(`AMOUNT_MISMATCH: statement ${s.amountMinor} vs ledger ${ledger.amountMinor} ${s.currency}`);
    } else if (!ledger && s.amountMinor !== quote.amountMinor) {
      breaks.push(`AMOUNT_MISMATCH: statement ${s.amountMinor} vs quote ${quote.amountMinor} ${s.currency}`);
    }
    if (entry.endToEndId !== state.paymentId) breaks.push(`END_TO_END_MISMATCH: statement ${entry.endToEndId} vs payment ${state.paymentId}`);
    if (entry.providerId !== settled.providerId) breaks.push(`PROVIDER_MISMATCH: statement ${entry.providerId} vs settled ${settled.providerId}`);
  }
  if (ledger && ledger.amountMinor !== quote.amountMinor) {
    breaks.push(`LEDGER_QUOTE_MISMATCH: ledger ${ledger.amountMinor} vs quote ${quote.amountMinor} ${quote.currency}`);
  }

  // M1-shaped settled events carry no statement entry: fall back to the old camt.053 reference.
  const statementRef = entry?.statementId ?? `camt.053-${state.updatedAt.slice(0, 10).replace(/-/g, '')}-${shortRef(state.paymentId, 'statement')}`;
  return { matched: breaks.length === 0, breaks, statementRef, statement: entry?.amount ?? null, ledger, quote };
}

export const reconciliationSteps: Step[] = [
  {
    trigger: 'ledger.posted',
    delay: 'stage',
    produce: (trigger, state): Outcome | null => {
      if (trigger.type !== 'ledger.posted') return null;
      const posted = trigger.payload;
      const r = reconcile(state, posted);
      if (!r) return null;
      const entry = state.facts['payment.settled']?.statementEntry;
      const codes = r.breaks.map((b) => b.slice(0, b.indexOf(':')));
      return {
        type: 'payment.reconciled',
        payload: { statementRef: r.statementRef, matched: r.matched, journalId: posted.journalId, breaks: r.breaks },
        decision: r.matched ? 'matched' : 'break',
        reasonCodes: r.matched
          ? ['STATEMENT_MATCHED', ...(entry ? [] : ['NO_STATEMENT_ENTRY_M1'])]
          : ['RECON_BREAK', ...new Set(codes)],
        inputs: {
          statementId: entry?.statementId ?? null,
          entryRef: entry?.entryRef ?? null,
          statementAmount: r.statement ? formatMoney(r.statement) : null,
          ledgerPayable: r.ledger ? formatMoney(r.ledger) : null,
          quotedAmount: formatMoney(r.quote),
          statementMinor: r.statement ? fmt(r.statement) : null,
          ledgerMinor: r.ledger ? fmt(r.ledger) : null,
          quotedMinor: fmt(r.quote),
          journalId: posted.journalId,
          endToEndId: entry?.endToEndId ?? null,
        },
        ruleVersion: RECON_RULE_VERSION,
      };
    },
  },
];
