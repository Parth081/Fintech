// M4 scenario scripts: risk & compliance (fraud ring, sanctions hit) and treasury (FX spike).
// Narration is what the presenter can say at that moment, in plain English for a non-technical audience.
// Every name and account below is fictional. Crafted payments go through the real Payment API and the real
// risk engine: nothing here tells the pipeline what to decide, the payments are simply shaped like the
// behaviour the screening, fraud model and AML typologies look for.
import type { Party } from '@ct/contracts';
import { SANCTIONS_NEAR_MATCHES } from '../../../tools/traffic/risk';
import type { CraftedPayment, ScenarioScript } from './scenarios';

const usd = (major: number) => ({ amountMinor: Math.round(major * 100), currency: 'USD' });
const gbp = (major: number) => ({ amountMinor: Math.round(major * 100), currency: 'GBP' });
const usIn = (debtor: Party, creditor: Party, major: number): CraftedPayment => ({ amount: usd(major), targetCurrency: 'INR', corridor: 'US-IN', debtor, creditor });
const gbPh = (debtor: Party, creditor: Party, major: number): CraftedPayment => ({ amount: gbp(major), targetCurrency: 'PHP', corridor: 'GB-PH', debtor, creditor });

// ------------------------------------------------------------------------------------------- fraud ring

/** The one beneficiary the mule accounts all pay (fan-in). New account each run. */
export const FRAUD_RING_BENEFICIARY: Party = { name: 'Marigold Bullion Traders', country: 'IN', accountId: 'MULE-IN-{run}-HUB' };

const MULE_NAMES = ['Dorian Vale', 'Petra Lund', 'Silas Fenwick', 'Ines Calloway', 'Tobin Rourke', 'Maren Holt', 'Casper Wilde', 'Lena Morrow'];
/** Just under the 10,000 USD reporting line, all different: the classic structuring pattern. */
const MULE_AMOUNTS = [9_850, 9_920, 9_780, 9_960, 9_890, 9_940, 9_810, 9_975];

/** Fan-in leg: eight accounts opened minutes ago, each sending once to the same beneficiary. */
export const FRAUD_RING_FAN_IN: CraftedPayment[] = MULE_NAMES.map((name, i) =>
  usIn({ name, country: 'US', accountId: `MULE-US-{run}-${String(i + 1).padStart(2, '0')}` }, FRAUD_RING_BENEFICIARY, MULE_AMOUNTS[i]!),
);

/** The ring's US collector account that splits money out to many recipients (fan-out). */
export const FRAUD_RING_COLLECTOR: Party = { name: 'Halden Crest Logistics LLC', country: 'US', accountId: 'MULE-US-{run}-COL' };
const FAN_OUT_RECIPIENTS = ['Arjun Mehra', 'Kavya Iyer', 'Rohan Desai', 'Nisha Rao', 'Vikram Sethi', 'Tara Bhatt'];
const FAN_OUT_AMOUNTS = [4_900, 4_850, 4_975, 4_920, 4_880, 4_990];

/** Fan-out leg: the collector pays six brand-new recipients within seconds. */
export const FRAUD_RING_FAN_OUT: CraftedPayment[] = FAN_OUT_RECIPIENTS.map((name, i) =>
  usIn(FRAUD_RING_COLLECTOR, { name, country: 'IN', accountId: `MULE-IN-{run}-R${i + 1}` }, FAN_OUT_AMOUNTS[i]!),
);

export const FRAUD_RING: ScenarioScript = {
  id: 'fraud-ring',
  title: 'Fraud ring: money mules move stolen funds',
  description:
    'Eight brand-new accounts each send just under 10,000 dollars to the same company within seconds, and a collector account splits money out to six new recipients. Risk and compliance catch the pattern, raise explainable alerts and open cases for investigators.',
  durationMs: 60_000,
  steps: [
    {
      id: 'baseline',
      atMs: 0,
      title: 'Normal day',
      narration:
        'Ordinary customers are sending money home as usual. Every payment is screened and scored by the risk engine before any money moves, and almost all of them sail straight through.',
      actions: [{ kind: 'ambient.rate', rate: 4 }],
    },
    {
      id: 'mules-pay-in',
      atMs: 6_000,
      title: 'Mule accounts pay in',
      narration:
        'Here comes the fraud ring. Eight accounts that were opened minutes ago each send just under ten thousand dollars, all to the same company in India. One payment like this looks harmless. Eight in a row do not.',
      actions: [{ kind: 'payments.send', label: 'fan-in', payments: FRAUD_RING_FAN_IN, spacingMs: 1_500 }],
    },
    {
      id: 'collector-pays-out',
      atMs: 20_000,
      title: 'Collector splits the money',
      narration:
        'Now the other half of the trick: one collector account splits money out to six new recipients within seconds. Criminals do this so that no single payment looks large.',
      actions: [{ kind: 'payments.send', label: 'fan-out', payments: FRAUD_RING_FAN_OUT, spacingMs: 1_000 }],
    },
    {
      id: 'alerts',
      atMs: 30_000,
      title: 'Alerts and cases appear',
      narration:
        'The risk engine has spotted the patterns: many senders paying one beneficiary, one account paying many, amounts kept just below the reporting line, and accounts with no history. The suspicious payments are held, and the alerts roll up into cases in the operations console.',
    },
    {
      id: 'investigator',
      atMs: 42_000,
      title: 'What the investigator sees',
      narration:
        'An investigator opens a case and sees exactly why it was flagged: each reason with its weight, the linked payments and the accounts involved. No black box. To release a high-risk payment, the analyst can only propose it; a manager must approve. Four eyes on every risky decision.',
    },
    {
      id: 'summary',
      atMs: 52_000,
      title: 'Customers protected, money untouched',
      narration:
        'Held payments have not moved a cent: nothing is posted to the ledger until a human decides. Meanwhile normal customers kept flowing without delay. Every action the team takes is written to a tamper-proof audit trail.',
    },
  ],
};

// ------------------------------------------------------------------------------------------- sanctions hit

/**
 * Parties whose names are close (but not identical) to entries on the fictional sanctions list the
 * screening stage uses (services/stages, list "fictional-sanctions-2026.x"): a transliteration, a
 * dropped word, a typo. Fuzzy matching should catch them all.
 */
export const SANCTIONS_PARTIES = {
  creditorEntity: { name: SANCTIONS_NEAR_MATCHES[0]!.name, country: 'IN', accountId: 'SIM-IN-{run}-S1' } as Party,
  debtorPerson: { name: SANCTIONS_NEAR_MATCHES[1]!.name, country: 'GB', accountId: 'SIM-GB-{run}-S2' } as Party,
};

export const SANCTIONS_HIT_PAYMENTS: CraftedPayment[] = [
  usIn({ name: 'Brightwater Textiles Ltd', country: 'US', accountId: 'SIM-US-{run}-C1' }, SANCTIONS_PARTIES.creditorEntity, 18_400),
  gbPh(SANCTIONS_PARTIES.debtorPerson, { name: 'Lucia Ramos', country: 'PH', accountId: 'SIM-PH-{run}-C2' }, 2_750),
];

export const SANCTIONS_HIT: ScenarioScript = {
  id: 'sanctions-hit',
  title: 'Sanctions hit: a listed party tries to pay',
  description:
    'Two payments involve parties whose names closely resemble entries on the (fictional) sanctions list: one spelled differently, one with a name reordered. Screening catches both, holds them and opens high-priority cases.',
  durationMs: 42_000,
  steps: [
    {
      id: 'baseline',
      atMs: 0,
      title: 'Normal day',
      narration:
        'Every payment is checked against the sanctions list before anything else happens. Thousands of names a day, and almost all of them are perfectly ordinary customers.',
      actions: [{ kind: 'ambient.rate', rate: 3 }],
    },
    {
      id: 'listed-company',
      atMs: 5_000,
      title: 'A listed company, spelled differently',
      narration:
        'This payment is going to a shipping company whose name is spelled slightly differently from one on the sanctions list. Criminals rely on small spelling changes; fuzzy matching does not fall for it.',
      actions: [{ kind: 'payments.send', label: 'entity', payments: [SANCTIONS_HIT_PAYMENTS[0]!] }],
    },
    {
      id: 'listed-person',
      atMs: 12_000,
      title: 'A listed person sends money',
      narration:
        'Now a sender in the UK whose name closely matches a listed individual. Same result: the payment stops before any money moves.',
      actions: [{ kind: 'payments.send', label: 'person', payments: [SANCTIONS_HIT_PAYMENTS[1]!] }],
    },
    {
      id: 'held',
      atMs: 20_000,
      title: 'Held for compliance',
      narration:
        'Both payments are held with a sanctions alert that shows the list entry, how close the match is and why. They roll into high-priority cases with a tight deadline in the operations console.',
    },
    {
      id: 'four-eyes',
      atMs: 30_000,
      title: 'Four eyes on every decision',
      narration:
        'A compliance analyst can recommend releasing or rejecting, but for a sanctions case a manager has to approve. If it is rejected, no money ever moves and the ledger stays untouched. Every step is in the audit trail.',
    },
  ],
};

// ------------------------------------------------------------------------------------------- FX spike

const PH_RECIPIENTS = ['Maria Santos', 'Jose Reyes', 'Ana Cruz', 'Paolo Bautista', 'Liza Mendoza', 'Ramon Villanueva', 'Grace Aquino', 'Carlo Navarro', 'Joy Dela Cruz', 'Mark Garcia'];
const GB_SENDERS = ['Amelia Hawthorne', 'Oliver Ashdown', 'Isla Penhallow', 'Harry Northcote', 'Freya Larkspur', 'Jack Stillwater', 'Poppy Whitlock', 'George Oakhurst', 'Ivy Thornbury', 'Leo Underhill'];
const remit = (i: number, major: number): CraftedPayment =>
  gbPh({ name: GB_SENDERS[i]!, country: 'GB', accountId: `SIM-GB-FX-${String(i + 1).padStart(4, '0')}` }, { name: PH_RECIPIENTS[i]!, country: 'PH', accountId: `SIM-PH-FX-${String(i + 1).padStart(4, '0')}` }, major);

/** Ordinary UK -> Philippines remittances, so there are quotes to compare before, during and after. */
export const FX_SPIKE_BEFORE: CraftedPayment[] = [0, 1, 2, 3].map((i) => remit(i, 180 + i * 45));
export const FX_SPIKE_DURING: CraftedPayment[] = [4, 5, 6, 7, 8, 9].map((i) => remit(i, 160 + i * 30));
export const FX_SPIKE_AFTER: CraftedPayment[] = [0, 2, 4, 6].map((i) => remit(i, 210 + i * 20));

export const FX_SPIKE_SHOCK = { shockId: 'gbp-php-spike', corridorId: 'GB-PH', driftBps: 250, noiseMultiplier: 4, rampMs: 5_000 } as const;

export const FX_SPIKE: ScenarioScript = {
  id: 'fx-spike',
  title: 'Currency spike: the pound swings against the peso',
  description:
    'The British pound suddenly moves 2.5% against the Philippine peso and the market gets four times as jumpy. FX quoting widens its spread to protect customers and our margin, then tightens again when the market calms down.',
  durationMs: 60_000,
  steps: [
    {
      id: 'baseline',
      atMs: 0,
      title: 'Calm market',
      narration:
        'Families in the UK are sending money to the Philippines. Each payment gets a live exchange-rate quote with a small, steady margin, and the quote is honoured for a short time.',
      actions: [
        { kind: 'ambient.rate', rate: 4 },
        { kind: 'payments.send', label: 'before', payments: FX_SPIKE_BEFORE, spacingMs: 1_000 },
      ],
    },
    {
      id: 'spike',
      atMs: 8_000,
      title: 'The pound spikes',
      narration:
        'Breaking news moves the market: the pound jumps against the peso and prices start swinging four times more than usual. Watch the UK to Philippines quotes.',
      actions: [
        {
          kind: 'fx_shock.start',
          ...FX_SPIKE_SHOCK,
          reason: 'Scenario: GBP/PHP spike (+250 bps drift, 4x volatility)',
        },
      ],
    },
    {
      id: 'spreads-widen',
      atMs: 16_000,
      title: 'Spreads widen automatically',
      narration:
        'Quoting sees the volatility and widens its spread. That margin is a safety buffer: if the rate moves before we settle, we do not lose money, and the customer still gets a firm price up front instead of a surprise.',
      actions: [{ kind: 'payments.send', label: 'during', payments: FX_SPIKE_DURING, spacingMs: 1_500 }],
    },
    {
      id: 'calm',
      atMs: 36_000,
      title: 'The market calms down',
      narration: 'The shock is over. Volatility drops back to normal and quotes tighten again within moments, so customers are not charged for risk that is gone.',
      actions: [{ kind: 'fx_shock.end', shockId: FX_SPIKE_SHOCK.shockId }],
    },
    {
      id: 'after',
      atMs: 44_000,
      title: 'Back to normal pricing',
      narration: 'New quotes are back to the usual margin. Every payment still settled and the ledger balances in every currency: we protected the customers and the business at the same time.',
      actions: [{ kind: 'payments.send', label: 'after', payments: FX_SPIKE_AFTER, spacingMs: 1_000 }],
    },
  ],
};
