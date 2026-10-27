// AML typologies over payments BEFORE the trigger (history.ts) plus the payment being decided.
//
//   AML_FAN_IN       many senders -> one beneficiary: >= 3 distinct debtor accounts (incl. this one) paid
//                    the same creditor account within 15 min, each >= USD 2,000 equivalent.
//   AML_FAN_OUT      one sender -> many beneficiaries: >= 3 distinct creditor accounts (incl. this one)
//                    paid by the same debtor account within 10 min, each >= USD 2,000 equivalent.
//   AML_STRUCTURING  this amount is just below a threshold (the 10,000 local reporting line or
//                    'risk.manualReviewAboveUsd', within 10%) AND, within 24 h, at least one other just-below
//                    payment came from the same debtor or went to the same creditor.
//   AML_RAPID_IN_OUT this sender received >= USD 1,000 within the last 60 min (as a creditor) and now sends
//                    out at least half of it.
// The USD 2,000 floor keeps ordinary small remittances (e.g. a busy sender paying family members) out of
// fan-in/fan-out; the windows are short because mule activity is bursty.
import { JUST_BELOW_BAND, REPORTING_THRESHOLD_MAJOR, justBelowThreshold } from './fraud-model';
import type { PaymentRecord } from './history';

export const AML_RULES_VERSION = 'aml-typologies-v1';
export const AML_PARAMS = {
  fanIn: { windowMs: 15 * 60_000, minDebtors: 3, minUsd: 2_000 },
  fanOut: { windowMs: 10 * 60_000, minCreditors: 3, minUsd: 2_000 },
  structuring: { windowMs: 24 * 3_600_000, minOthers: 1, band: JUST_BELOW_BAND, reportingThresholdMajor: REPORTING_THRESHOLD_MAJOR },
  rapidInOut: { windowMs: 60 * 60_000, minReceivedUsd: 1_000, minShareOut: 0.5 },
} as const;

export type AmlRule = 'AML_FAN_IN' | 'AML_FAN_OUT' | 'AML_STRUCTURING' | 'AML_RAPID_IN_OUT';

export interface AmlHit {
  rule: AmlRule;
  score: number; // 0..1, typology strength
  severity: 'medium' | 'high';
  summary: string;
  reasons: { code: string; text: string; weight?: number }[];
  relatedPaymentIds: string[];
  evidence: Record<string, unknown>;
}

const usd = (x: number) => `USD ${Math.round(x).toLocaleString('en-US')}`;
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function detectAml(p: PaymentRecord, history: readonly PaymentRecord[], atMs: number, manualReviewAboveUsd: number): AmlHit[] {
  const hits: AmlHit[] = [];
  const P = AML_PARAMS;

  // fan-in
  if (p.usd >= P.fanIn.minUsd) {
    const rel = history.filter((h) => h.creditorAccount === p.creditorAccount && h.atMs > atMs - P.fanIn.windowMs && h.usd >= P.fanIn.minUsd && h.debtorAccount !== p.debtorAccount);
    const debtors = uniq([p.debtorAccount, ...rel.map((h) => h.debtorAccount)]);
    if (debtors.length >= P.fanIn.minDebtors) {
      const total = rel.reduce((s, h) => s + h.usd, p.usd);
      const n = debtors.length;
      hits.push({
        rule: 'AML_FAN_IN',
        score: Math.min(0.95, 0.75 + 0.04 * (n - P.fanIn.minDebtors)),
        severity: n >= 5 ? 'high' : 'medium',
        summary: `${n} different senders paid ${p.creditorName} ${usd(total)} within ${P.fanIn.windowMs / 60_000} minutes (fan-in)`,
        reasons: [
          { code: 'MANY_SENDERS_ONE_BENEFICIARY', text: `${n} distinct sender accounts paid the same beneficiary account ${p.creditorAccount}` },
          { code: 'SHORT_WINDOW', text: `All within ${P.fanIn.windowMs / 60_000} minutes, each at least ${usd(P.fanIn.minUsd)}` },
        ],
        relatedPaymentIds: rel.map((h) => h.paymentId),
        evidence: { beneficiaryAccount: p.creditorAccount, beneficiaryName: p.creditorName, distinctSenders: n, senderAccounts: debtors, totalUsd: Math.round(total * 100) / 100, windowMinutes: P.fanIn.windowMs / 60_000 },
      });
    }
  }

  // fan-out
  if (p.usd >= P.fanOut.minUsd) {
    const rel = history.filter((h) => h.debtorAccount === p.debtorAccount && h.atMs > atMs - P.fanOut.windowMs && h.usd >= P.fanOut.minUsd && h.creditorAccount !== p.creditorAccount);
    const creditors = uniq([p.creditorAccount, ...rel.map((h) => h.creditorAccount)]);
    if (creditors.length >= P.fanOut.minCreditors) {
      const total = rel.reduce((s, h) => s + h.usd, p.usd);
      const n = creditors.length;
      hits.push({
        rule: 'AML_FAN_OUT',
        score: Math.min(0.95, 0.75 + 0.04 * (n - P.fanOut.minCreditors)),
        severity: n >= 6 ? 'high' : 'medium',
        summary: `${p.debtorName} paid ${n} different beneficiaries ${usd(total)} within ${P.fanOut.windowMs / 60_000} minutes (fan-out)`,
        reasons: [
          { code: 'ONE_SENDER_MANY_BENEFICIARIES', text: `Sender account ${p.debtorAccount} paid ${n} distinct beneficiary accounts` },
          { code: 'SHORT_WINDOW', text: `All within ${P.fanOut.windowMs / 60_000} minutes, each at least ${usd(P.fanOut.minUsd)}` },
        ],
        relatedPaymentIds: rel.map((h) => h.paymentId),
        evidence: { senderAccount: p.debtorAccount, senderName: p.debtorName, distinctBeneficiaries: n, beneficiaryAccounts: creditors, totalUsd: Math.round(total * 100) / 100, windowMinutes: P.fanOut.windowMs / 60_000 },
      });
    }
  }

  // structuring
  const below = justBelowThreshold(p, manualReviewAboveUsd);
  if (below) {
    const rel = history.filter(
      (h) => h.atMs > atMs - P.structuring.windowMs && (h.debtorAccount === p.debtorAccount || h.creditorAccount === p.creditorAccount) && justBelowThreshold(h, manualReviewAboveUsd) !== null,
    );
    if (rel.length >= P.structuring.minOthers) {
      const n = rel.length + 1;
      const viaCreditor = rel.some((h) => h.creditorAccount === p.creditorAccount);
      hits.push({
        rule: 'AML_STRUCTURING',
        score: Math.min(0.95, 0.8 + 0.03 * (n - 2)),
        severity: n >= 4 ? 'high' : 'medium',
        summary: `${n} payments kept just below the ${below} ${viaCreditor ? `to ${p.creditorName}` : `from ${p.debtorName}`} within 24 hours (structuring)`,
        reasons: [
          { code: 'JUST_BELOW_THRESHOLD', text: `This payment (${p.amount.currency} ${p.major.toLocaleString('en-US')}) is within ${P.structuring.band * 100}% under the ${below}` },
          { code: 'REPEATED_PATTERN', text: `${rel.length} other just-below payment(s) ${viaCreditor ? 'to the same beneficiary' : 'from the same sender'} in 24 hours` },
        ],
        relatedPaymentIds: rel.map((h) => h.paymentId),
        evidence: { threshold: below, amounts: [...rel.map((h) => ({ paymentId: h.paymentId, amount: h.amount })), { paymentId: p.paymentId, amount: p.amount }], linkedBy: viaCreditor ? 'beneficiary' : 'sender' },
      });
    }
  }

  // rapid in-out
  const received = history.filter((h) => h.creditorAccount === p.debtorAccount && h.atMs > atMs - P.rapidInOut.windowMs);
  const receivedUsd = received.reduce((s, h) => s + h.usd, 0);
  if (receivedUsd >= P.rapidInOut.minReceivedUsd && p.usd >= P.rapidInOut.minShareOut * receivedUsd) {
    const share = p.usd / receivedUsd;
    hits.push({
      rule: 'AML_RAPID_IN_OUT',
      score: Math.min(0.95, 0.75 + 0.15 * Math.min(1, share)),
      severity: share >= 0.9 ? 'high' : 'medium',
      summary: `${p.debtorName} received ${usd(receivedUsd)} and is sending ${Math.round(share * 100)}% of it on within ${P.rapidInOut.windowMs / 60_000} minutes (rapid in-out)`,
      reasons: [
        { code: 'FUNDS_RECEIVED', text: `Account ${p.debtorAccount} received ${usd(receivedUsd)} in ${received.length} payment(s) in the last hour` },
        { code: 'PASS_THROUGH', text: `Now sends out ${usd(p.usd)} (${Math.round(share * 100)}% of what came in)` },
      ],
      relatedPaymentIds: received.map((h) => h.paymentId),
      evidence: { account: p.debtorAccount, receivedUsd: Math.round(receivedUsd * 100) / 100, sentUsd: p.usd, shareOut: Math.round(share * 1000) / 1000 },
    });
  }
  return hits;
}
