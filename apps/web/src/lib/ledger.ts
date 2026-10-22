// Pure helpers for ledger views (trial balance, accounts, journals).
import { formatMoney, isBalanced, type AccountBalance, type AccountType, type JournalView } from '@ct/contracts/browser';

/** Best-effort account type from the naming convention, used when the ledger API cannot be asked. */
export function inferAccountType(accountId: string): AccountType | null {
  if (accountId.startsWith('customer:')) return 'liability';
  if (accountId.startsWith('fx-position:') || accountId.includes(':nostro')) return 'asset';
  if (accountId.startsWith('provider:') && accountId.endsWith(':payable')) return 'liability';
  if (/^(revenue|fee|fx-revenue)/.test(accountId)) return 'revenue';
  if (/^(expense|provider-fee)/.test(accountId)) return 'expense';
  if (accountId.startsWith('equity')) return 'equity';
  return null;
}

export interface JournalRow {
  accountId: string;
  type: string;
  debit: string;
  credit: string;
}

export function journalRows(j: JournalView, types: ReadonlyMap<string, AccountType>): JournalRow[] {
  return j.entries.map((e) => ({
    accountId: e.accountId,
    type: types.get(e.accountId) ?? inferAccountType(e.accountId) ?? '—',
    debit: e.direction === 'debit' ? formatMoney(e.amount) : '',
    credit: e.direction === 'credit' ? formatMoney(e.amount) : '',
  }));
}

export function journalBalanced(j: JournalView): boolean {
  return isBalanced(j.entries.map((e) => ({ account: e.accountId, direction: e.direction, amount: e.amount })));
}

/**
 * Accounts matching a free-text query (id, type or currency; every word must match), sorted by
 * type, then currency, then id; capped at `limit` rows (the total match count is returned too).
 */
export function filterAccounts(accounts: AccountBalance[], query: string, limit = 200): { rows: AccountBalance[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = words.length
    ? accounts.filter((a) => {
        const hay = `${a.accountId} ${a.type} ${a.currency}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
    : accounts;
  const sorted = [...matched].sort(
    (a, b) => a.type.localeCompare(b.type) || a.currency.localeCompare(b.currency) || a.accountId.localeCompare(b.accountId),
  );
  return { rows: sorted.slice(0, limit), total: matched.length };
}
