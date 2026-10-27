// What a kiosk visitor can send: the three demo corridors, a few amount chips each, and fictional parties.
import { CORRIDORS, corridorById, exponentOf, type Party } from '@ct/contracts/browser';
import type { KioskMode } from './flow';

export interface CorridorCard {
  id: string;
  from: string;
  to: string;
  fromCode: string;
  toCode: string;
  sourceCurrency: string;
  targetCurrency: string;
  story: string;
  debtor: Omit<Party, 'accountId'>;
  creditor: Omit<Party, 'accountId'>;
}

const CARD_INFO: Record<string, Pick<CorridorCard, 'from' | 'to' | 'story' | 'debtor' | 'creditor'>> = {
  'US-IN': {
    from: 'United States',
    to: 'India',
    story: 'An online shop in Seattle pays its textile supplier in Jaipur',
    debtor: { name: 'Northwind Marketplace', country: 'US' },
    creditor: { name: 'Asha Textiles', country: 'IN' },
  },
  'DE-BR': {
    from: 'Germany',
    to: 'Brazil',
    story: 'A Hamburg café chain pays its coffee farm in Minas Gerais',
    debtor: { name: 'Lindenhof Kaffeehaus GmbH', country: 'DE' },
    creditor: { name: 'Cafe Serra Azul', country: 'BR' },
  },
  'GB-PH': {
    from: 'United Kingdom',
    to: 'Philippines',
    story: 'A London studio pays a freelance designer in Cebu',
    debtor: { name: 'Ashcombe Studios', country: 'GB' },
    creditor: { name: 'Isla Verde Design', country: 'PH' },
  },
};

const CHIPS: Record<string, number[]> = {
  USD: [50, 250, 1000],
  EUR: [100, 500, 2000],
  GBP: [75, 300, 1500],
};

export const CORRIDOR_CARDS: CorridorCard[] = CORRIDORS.flatMap((c) => {
  const info = CARD_INFO[c.id];
  if (!info) return [];
  return [{ ...info, id: c.id, fromCode: c.sourceCountry, toCode: c.targetCountry, sourceCurrency: c.sourceCurrency, targetCurrency: c.targetCurrency }];
});

export function amountChips(corridorId: string): number[] {
  const c = corridorById(corridorId);
  return c ? (CHIPS[c.sourceCurrency] ?? [100, 500, 1000]) : [];
}

/** Scenario slug the pipeline understands: the first provider refuses the instruction, routing retries elsewhere. */
export const PROVIDER_FAIL_SCENARIO = 'provider-reject';

export interface KioskPaymentRequest {
  amount: { amountMinor: number; currency: string };
  targetCurrency: string;
  corridor: string;
  debtor: Party;
  creditor: Party;
  scenario?: string;
}

const accountId = (country: string, random: () => number) => `KIOSK-${country}-${String(Math.floor(random() * 10_000)).padStart(4, '0')}`;

/** A valid POST /api/payments body (see services/payment-api validate.ts). Throws for an unknown corridor or amount. */
export function buildPaymentRequest(corridorId: string, amountMajor: number, mode: KioskMode, random: () => number = Math.random): KioskPaymentRequest {
  const corridor = corridorById(corridorId);
  const card = CORRIDOR_CARDS.find((c) => c.id === corridorId);
  if (!corridor || !card) throw new Error(`unknown corridor ${corridorId}`);
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) throw new Error('amount must be positive');
  const amountMinor = Math.round(amountMajor * 10 ** exponentOf(corridor.sourceCurrency));
  const req: KioskPaymentRequest = {
    amount: { amountMinor, currency: corridor.sourceCurrency },
    targetCurrency: corridor.targetCurrency,
    corridor: corridor.id,
    debtor: { ...card.debtor, accountId: accountId(card.debtor.country, random) },
    creditor: { ...card.creditor, accountId: accountId(card.creditor.country, random) },
  };
  if (mode === 'fail') req.scenario = PROVIDER_FAIL_SCENARIO;
  return req;
}

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', BRL: 'R$', PHP: '₱' };

/** "$250", "€2,000" (whole major units, for chips). */
export function chipLabel(amountMajor: number, currency: string): string {
  const n = amountMajor.toLocaleString('en-US');
  const sym = SYMBOL[currency];
  return sym ? `${sym}${n}` : `${currency} ${n}`;
}

/** Rough target amount for the picker preview, from the corridor's mid rate (the real quote comes later). */
export function previewTarget(corridorId: string, amountMajor: number): string {
  const c = corridorById(corridorId);
  if (!c) return '';
  const v = Math.round(amountMajor * Number(c.midRate));
  return `≈ ${chipLabel(v, c.targetCurrency)}`;
}
