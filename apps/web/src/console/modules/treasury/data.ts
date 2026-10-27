// Treasury & Reconciliation data access: ledger balances, today's payments, statements (gateway read side)
// and the reconciliation break queue (Ops API).
import type { AccountBalance, ReconBreak } from '@ct/contracts/browser';
import { apiGet, apiText, gatewayApi, opsApi, opsGet, opsPost, type Query } from '../../api';
import type { StatementRef } from '../../../lib/types';
import type { ResolutionCode } from './lib/treasury';

const enc = encodeURIComponent;

/** Local midnight as ISO (the gateway filters payments by createdAt >= from). */
export function startOfToday(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

export const treasuryApi = {
  accounts: (signal?: AbortSignal) => apiGet<AccountBalance[]>('/api/ledger/accounts', { signal }),
  paymentsToday: (nowMs: number, signal?: AbortSignal) => gatewayApi.payments({ from: startOfToday(nowMs), limit: 1000 }, signal),
  stats: (signal?: AbortSignal) => gatewayApi.stats(signal),
  providers: (signal?: AbortSignal) => gatewayApi.providers(signal),
  statements: (signal?: AbortSignal) => apiGet<StatementRef[]>('/api/statements', { signal }),
  statementXml: (providerId: string, date: string, currency: string, signal?: AbortSignal) =>
    apiText(`/api/statements/${enc(providerId)}/${enc(date)}`, { query: { currency }, signal, accept: 'application/xml, text/xml, */*' }),
  breaks: (query: Query, signal?: AbortSignal) => opsApi.breaks(query, signal),
  breakById: (id: string, signal?: AbortSignal) => opsGet<ReconBreak & { eventId?: string }>(`/recon/breaks/${enc(id)}`, { signal }),
  assign: (id: string, userId: string | null) => opsPost<ReconBreak>(`/recon/breaks/${enc(id)}/assign`, { userId }, { permission: 'recon.resolve' }),
  resolve: (id: string, code: ResolutionCode, note: string) => opsPost<ReconBreak>(`/recon/breaks/${enc(id)}/resolve`, { code, note }, { permission: 'recon.resolve' }),
};
