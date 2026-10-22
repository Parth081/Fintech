// Posting rules: pure functions from payment facts to balanced journal entries.
import { deterministicId, isBalanced, type LedgerEntry, type Money, type PaymentState } from '@ct/contracts';
import { accountIds, classifyAccount } from './chart';

export const LEDGER_RULE_VERSION = 'ledger-v1';

/** Deterministic journal id for a causing event: a retried posting always names the same journal. */
export function journalIdFor(causationEventId: string): string {
  return `JRN-${deterministicId('ledger-journal', causationEventId).replace(/-/g, '').slice(0, 20).toUpperCase()}`;
}

function positiveMinor(m: Money | undefined, what: string): Money {
  if (!m) throw new Error(`ledger: ${what} is missing`);
  if (!Number.isSafeInteger(m.amountMinor) || m.amountMinor < 0) {
    throw new Error(`ledger: ${what} must be a non-negative safe integer of minor units, got ${String(m.amountMinor)}`);
  }
  if (!/^[A-Z]{3}$/.test(m.currency)) throw new Error(`ledger: ${what} has invalid currency ${m.currency}`);
  return m;
}

/**
 * Settlement journal for a settled payment:
 *
 *   Dr customer:<debtor>:<SRC>          amount + fee   (customer is charged)
 *     Cr fx-position:<SRC>              amount         (source currency sold)
 *     Cr fee-revenue:<SRC>              fee            (fee earned; omitted when 0)
 *   Dr fx-position:<TGT>                target         (target currency bought)
 *     Cr provider:<id>:payable:<TGT>    target         (owed to the payout provider)
 *
 * Source/target amounts come from payment.quoted, the provider from payment.settled and the fee
 * from payment.routed.estimatedFee (source currency).
 */
export function settlementEntries(state: PaymentState): LedgerEntry[] {
  const quoted = state.facts['payment.quoted'];
  const routed = state.facts['payment.routed'];
  const settled = state.facts['payment.settled'];
  if (!quoted) throw new Error(`ledger: payment ${state.paymentId} has no payment.quoted fact`);
  if (!settled) throw new Error(`ledger: payment ${state.paymentId} has no payment.settled fact`);
  const src = positiveMinor(quoted.sourceAmount, 'quoted.sourceAmount');
  const tgt = positiveMinor(quoted.targetAmount, 'quoted.targetAmount');
  if (src.amountMinor === 0 || tgt.amountMinor === 0) throw new Error(`ledger: payment ${state.paymentId} has a zero amount`);
  const fee = routed ? positiveMinor(routed.estimatedFee, 'routed.estimatedFee') : { amountMinor: 0, currency: src.currency };
  if (fee.currency !== src.currency) {
    throw new Error(`ledger: fee currency ${fee.currency} differs from source currency ${src.currency} (payment ${state.paymentId})`);
  }
  const charged = src.amountMinor + fee.amountMinor;
  if (!Number.isSafeInteger(charged)) throw new Error(`ledger: amount + fee overflows safe integers (payment ${state.paymentId})`);
  const debtor = state.initiated.debtor.accountId;

  const entries: LedgerEntry[] = [
    { account: accountIds.customer(debtor, src.currency), direction: 'debit', amount: { amountMinor: charged, currency: src.currency } },
    { account: accountIds.fxPosition(src.currency), direction: 'credit', amount: { amountMinor: src.amountMinor, currency: src.currency } },
  ];
  if (fee.amountMinor > 0) {
    entries.push({ account: accountIds.feeRevenue(src.currency), direction: 'credit', amount: { amountMinor: fee.amountMinor, currency: src.currency } });
  }
  entries.push(
    { account: accountIds.fxPosition(tgt.currency), direction: 'debit', amount: { amountMinor: tgt.amountMinor, currency: tgt.currency } },
    { account: accountIds.providerPayable(settled.providerId, tgt.currency), direction: 'credit', amount: { amountMinor: tgt.amountMinor, currency: tgt.currency } },
  );
  assertPostable(entries);
  return entries;
}

/** Code-level journal checks (the database re-checks the same rules at commit). */
export function assertPostable(entries: LedgerEntry[]): void {
  if (!isBalanced(entries)) throw new Error('ledger: journal is not balanced (debits must equal credits per currency, amounts > 0)');
  for (const e of entries) {
    const spec = classifyAccount(e.account);
    if (spec.currency !== e.amount.currency) {
      throw new Error(`ledger: entry currency ${e.amount.currency} does not match account ${e.account}`);
    }
  }
}
