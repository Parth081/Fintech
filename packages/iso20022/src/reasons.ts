// A realistic subset of the ISO 20022 ExternalStatusReason1Code list, with plain-English text.

export interface StatusReason {
  code: string;
  name: string; // ISO 20022 name
  text: string; // plain English for the UI and the decision trace
}

export const STATUS_REASONS: readonly StatusReason[] = [
  { code: 'AC04', name: 'ClosedAccountNumber', text: 'The beneficiary account number is closed at the receiving bank.' },
  { code: 'AC06', name: 'BlockedAccount', text: 'The beneficiary account is blocked; the receiving bank cannot credit it.' },
  { code: 'AG01', name: 'TransactionForbidden', text: 'The provider is not allowed to process this transaction type on this account.' },
  { code: 'AM04', name: 'InsufficientFunds', text: 'The prefunded account at the provider does not cover the amount.' },
  { code: 'AM05', name: 'Duplication', text: 'The provider believes this instruction is a duplicate of one it already received.' },
  { code: 'FF01', name: 'InvalidFileFormat', text: 'The provider could not process the message format.' },
  { code: 'MS03', name: 'NotSpecifiedReasonAgentGenerated', text: 'The provider rejected the instruction without giving a specific reason.' },
  { code: 'NARR', name: 'Narrative', text: 'Reason given in free text.' },
];

/**
 * Codes the settlement simulator draws from for random provider rejects. Duplication (AM05) and
 * InsufficientFunds (AM04) are left out so the demo never suggests our own idempotency or funding failed.
 */
export const SIMULATED_REJECT_CODES: readonly string[] = ['AC04', 'AC06', 'AG01', 'FF01', 'MS03'];

export function statusReason(code: string): StatusReason {
  return STATUS_REASONS.find((r) => r.code === code) ?? { code, name: 'Unknown', text: `Provider status reason ${code}.` };
}
