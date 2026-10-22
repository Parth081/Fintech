// HTTP API of the ledger service (services/ledger, default port 7073). Shared by the ledger and the gateway.
import type { Money } from './events';

export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense' | 'equity';

export interface AccountBalance {
  accountId: string; // e.g. "customer:ACC-US-0001", "fx-position:USD", "provider:orion:payable"
  type: AccountType;
  currency: string;
  debits: number; // minor units, sum of debit entries
  credits: number; // minor units, sum of credit entries
  balance: number; // debits - credits (minor units)
  entryCount: number;
}

export interface TrialBalance {
  asOf: string; // ISO
  journals: number;
  entries: number;
  /** One row per currency: total debits must equal total credits. */
  byCurrency: { currency: string; debits: number; credits: number; balanced: boolean }[];
  balanced: boolean;
}

export interface JournalView {
  journalId: string;
  paymentId: string;
  kind: string; // e.g. "settlement"
  postedAt: string;
  causationEventId: string;
  entries: { accountId: string; direction: 'debit' | 'credit'; amount: Money }[];
}

/**
 * GET /health                       -> { ok: true, journals: number }
 * GET /ledger/trial-balance         -> TrialBalance
 * GET /ledger/accounts              -> AccountBalance[]
 * GET /ledger/accounts/:accountId   -> AccountBalance & { recent: JournalView[] }   (accountId URL-encoded)
 * GET /ledger/journals?paymentId=x  -> JournalView[]
 * GET /ledger/invariants            -> { ok: boolean; violations: string[] }  (full re-check from raw entries)
 */
export const LEDGER_API_DOC = true;
