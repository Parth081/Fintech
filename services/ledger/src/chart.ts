// Chart of accounts. Accounts are created on first use; their accounting type is derived from the
// id prefix and their currency is the last ":CCY" segment. One account = one currency, so every
// account that can hold several currencies carries the currency in its id. See README.md.
import type { AccountType } from '@ct/contracts';

export interface AccountRule {
  prefix: string;
  type: AccountType;
  pattern: string;
  description: string;
}

export const CHART_OF_ACCOUNTS: readonly AccountRule[] = [
  {
    prefix: 'customer:',
    type: 'asset',
    pattern: 'customer:<debtorAccountId>:<CCY>',
    description: 'Funds collected from (receivable from) the paying customer. Debited by amount + fee when a payment settles.',
  },
  {
    prefix: 'fx-position:',
    type: 'asset',
    pattern: 'fx-position:<CCY>',
    description: 'Treasury currency position. Credited in the source currency sold, debited in the target currency bought.',
  },
  {
    prefix: 'provider:',
    type: 'liability',
    pattern: 'provider:<providerId>:payable:<CCY>',
    description: 'Amount owed to the payout provider for what it delivered in the target currency.',
  },
  {
    prefix: 'fee-revenue:',
    type: 'revenue',
    pattern: 'fee-revenue:<CCY>',
    description: 'Transfer fees earned (charged in the source currency).',
  },
  {
    prefix: 'fx-revenue:',
    type: 'revenue',
    pattern: 'fx-revenue:<CCY>',
    description: 'Reserved: realised FX spread income (M3+).',
  },
  {
    prefix: 'suspense:',
    type: 'liability',
    pattern: 'suspense:<reason>:<CCY>',
    description: 'Reserved: unidentified / unmatched amounts parked for investigation (reconciliation breaks).',
  },
  {
    prefix: 'expense:',
    type: 'expense',
    pattern: 'expense:<name>:<CCY>',
    description: 'Reserved: costs (e.g. provider charges).',
  },
  {
    prefix: 'equity:',
    type: 'equity',
    pattern: 'equity:<name>:<CCY>',
    description: 'Reserved: capital / opening balances.',
  },
];

export interface AccountSpec {
  accountId: string;
  type: AccountType;
  currency: string;
}

const CCY = /^[A-Z]{3}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Validate an account id against the chart and derive its type and currency. Throws if unknown. */
export function classifyAccount(accountId: string): AccountSpec {
  const rule = CHART_OF_ACCOUNTS.find((r) => accountId.startsWith(r.prefix));
  if (!rule) throw new Error(`ledger: account "${accountId}" is not in the chart of accounts`);
  const parts = accountId.split(':');
  const currency = parts[parts.length - 1] ?? '';
  if (parts.length < 2 || !CCY.test(currency)) throw new Error(`ledger: account "${accountId}" must end with :<CCY>`);
  if (!parts.slice(1).every((p) => SEGMENT.test(p))) throw new Error(`ledger: account "${accountId}" has an invalid segment`);
  if (rule.prefix === 'provider:' && (parts.length !== 4 || parts[2] !== 'payable')) {
    throw new Error(`ledger: provider account "${accountId}" must look like provider:<id>:payable:<CCY>`);
  }
  if (rule.prefix === 'customer:' && parts.length < 3) {
    throw new Error(`ledger: account "${accountId}" must look like ${rule.pattern}`);
  }
  if (rule.prefix === 'fx-position:' ||rule.prefix === 'fee-revenue:' || rule.prefix === 'fx-revenue:') {
    if (parts.length !== 2) throw new Error(`ledger: account "${accountId}" must look like ${rule.pattern}`);
  }
  return { accountId, type: rule.type, currency };
}

export const accountIds = {
  customer: (debtorAccountId: string, currency: string) => `customer:${debtorAccountId}:${currency}`,
  fxPosition: (currency: string) => `fx-position:${currency}`,
  providerPayable: (providerId: string, currency: string) => `provider:${providerId}:payable:${currency}`,
  feeRevenue: (currency: string) => `fee-revenue:${currency}`,
};
