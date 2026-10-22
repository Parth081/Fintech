// Synthetic payments for the "Send test payment" button. Fictional names only.
import { CORRIDORS, exponentOf } from '@ct/contracts';
import type { PaymentRequest } from './validate';

const DEBTORS: Record<string, string[]> = {
  US: ['Northwind Marketplace', 'Bluefield Outfitters', 'Cedar Lane Software', 'Harborview Imports'],
  DE: ['Fictional GmbH', 'Rheinwerk Handel', 'Lindenhof Maschinen', 'Kesselbach Moebel'],
  GB: ['Thamesgate Traders', 'Ashcombe Studios', 'Wexley & Rowe Ltd', 'Kingsmere Logistics'],
};
const CREDITORS: Record<string, string[]> = {
  IN: ['Asha Textiles', 'Kaveri Spice Co', 'Indigo Loom Works', 'Ravi Kumar Freelance'],
  BR: ['Loja Ficticia', 'Cafe Serra Azul', 'Tecelagem Aurora', 'Marina Costa Design'],
  PH: ['Bayanihan Crafts', 'Maria Santos', 'Isla Verde Exports', 'Pacific Weave Co'],
};

let counter = 0;

const pick = <T>(list: readonly T[] | undefined, fallback: T): T =>
  list && list.length ? (list[Math.floor(Math.random() * list.length)] ?? fallback) : fallback;

const accountId = (country: string) => `ACC-${country}-${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;

/** A valid synthetic payment request, rotating through the corridors. */
export function samplePayment(scenario?: string): PaymentRequest {
  const corridor = CORRIDORS[counter++ % CORRIDORS.length] ?? CORRIDORS[0]!;
  // 25.00 .. 4,999.99 major units, mostly round-ish figures
  const major = 25 + Math.floor(Math.random() * 4975);
  const minorPart = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 100);
  const exp = exponentOf(corridor.sourceCurrency);
  const amountMinor = exp === 0 ? major : major * 10 ** exp + (exp >= 2 ? minorPart : 0);
  const req: PaymentRequest = {
    amount: { amountMinor, currency: corridor.sourceCurrency },
    targetCurrency: corridor.targetCurrency,
    corridor: corridor.id,
    debtor: { name: pick(DEBTORS[corridor.sourceCountry], 'Sample Sender Ltd'), country: corridor.sourceCountry, accountId: accountId(corridor.sourceCountry) },
    creditor: { name: pick(CREDITORS[corridor.targetCountry], 'Sample Receiver'), country: corridor.targetCountry, accountId: accountId(corridor.targetCountry) },
  };
  if (scenario) req.scenario = scenario;
  return req;
}
