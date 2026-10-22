import type { LedgerEntry, Money } from './events';

/** Minor-unit exponent per currency (ISO 4217). Defaults to 2. */
export const CURRENCY_EXPONENT: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, INR: 2, BRL: 2, PHP: 2, JPY: 0,
};

export function exponentOf(currency: string): number {
  return CURRENCY_EXPONENT[currency] ?? 2;
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) throw new Error(`amountMinor must be a safe integer, got ${amountMinor}`);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currency must be an ISO 4217 code, got ${currency}`);
  return { amountMinor, currency };
}

export function formatMoney(m: Money): string {
  const exp = exponentOf(m.currency);
  const value = (m.amountMinor / 10 ** exp).toFixed(exp);
  return `${m.currency} ${value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Debits equal credits for every currency in the journal, and every amount is a positive integer. */
export function isBalanced(entries: LedgerEntry[]): boolean {
  if (entries.length < 2) return false;
  const net = new Map<string, number>();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount.amountMinor) || e.amount.amountMinor <= 0) return false;
    const sign = e.direction === 'debit' ? 1 : -1;
    net.set(e.amount.currency, (net.get(e.amount.currency) ?? 0) + sign * e.amount.amountMinor);
  }
  return [...net.values()].every((v) => v === 0);
}
