// Builders for the three ISO 20022 messages the simulator uses. Element order follows the XSDs.
import { exponentOf, type Money, type Party, type StatementEntry } from '@ct/contracts/browser';
import { statusReason } from './reasons';
import { document, el, formatAmount, formatMoney, isoDate, isoDateTime, ref, uetrFor } from './util';

export const NS = {
  pacs008: 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08',
  pacs002: 'urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10',
  camt053: 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08',
} as const;

export type MessageType = 'pacs.008' | 'pacs.002' | 'camt.053';

/** Fictional BIC of the sending institution (us), per debtor country, e.g. XCTWUS22XXX. */
export function originatorBic(country: string): string {
  return `XCTW${country.toUpperCase().slice(0, 2).padEnd(2, 'X')}22XXX`;
}

const amt = (name: string, m: Money) => el(name, formatMoney(m), { Ccy: m.currency });

const party = (tag: string, p: Party) => el(tag, [el('Nm', p.name), el('PstlAdr', [el('Ctry', p.country)])]);
const account = (tag: string, accountId: string) => el(tag, [el('Id', [el('Othr', [el('Id', accountId)])])]);
const agent = (tag: string, bic: string) => el(tag, [el('FinInstnId', [el('BICFI', bic)])]);

// ---------------------------------------------------------------- pacs.008

export interface Pacs008Input {
  messageId: string;
  createdAt: string; // ISO date-time
  paymentId: string; // EndToEndId
  instructionId?: string; // defaults to messageId
  settlementDate: string; // YYYY-MM-DD (IntrBkSttlmDt)
  /** Interbank settlement amount (what the creditor agent delivers, target currency). */
  settlementAmount: Money;
  /** Instructed amount (what the debtor sent, source currency). */
  instructedAmount: Money;
  /** Target units per 1 source unit, decimal string. */
  exchangeRate: string;
  debtor: Party;
  creditor: Party;
  debtorAgentBic?: string; // defaults to originatorBic(debtor.country)
  creditorAgentBic: string; // the provider
  remittanceInfo?: string;
  settlementMethod?: 'INDA' | 'INGA' | 'CLRG';
  chargeBearer?: 'SHAR' | 'DEBT' | 'CRED';
}

export function buildPacs008(input: Pacs008Input): string {
  const body = el('FIToFICstmrCdtTrf', [
    el('GrpHdr', [
      el('MsgId', input.messageId),
      el('CreDtTm', isoDateTime(input.createdAt)),
      el('NbOfTxs', '1'),
      el('SttlmInf', [el('SttlmMtd', input.settlementMethod ?? 'INDA')]),
    ]),
    el('CdtTrfTxInf', [
      el('PmtId', [
        el('InstrId', input.instructionId ?? input.messageId),
        el('EndToEndId', input.paymentId),
        el('UETR', uetrFor(input.paymentId)),
      ]),
      amt('IntrBkSttlmAmt', input.settlementAmount),
      el('IntrBkSttlmDt', input.settlementDate),
      amt('InstdAmt', input.instructedAmount),
      el('XchgRate', input.exchangeRate),
      el('ChrgBr', input.chargeBearer ?? 'SHAR'),
      party('Dbtr', input.debtor),
      account('DbtrAcct', input.debtor.accountId),
      agent('DbtrAgt', input.debtorAgentBic ?? originatorBic(input.debtor.country)),
      agent('CdtrAgt', input.creditorAgentBic),
      party('Cdtr', input.creditor),
      account('CdtrAcct', input.creditor.accountId),
      el('RmtInf', [el('Ustrd', (input.remittanceInfo ?? `Payment ${input.paymentId}`).slice(0, 140))]),
    ]),
  ]);
  return document(NS.pacs008, body);
}

// ---------------------------------------------------------------- pacs.002

export interface Pacs002Input {
  messageId: string;
  createdAt: string;
  originalMessageId: string; // MsgId of the pacs.008
  originalInstructionId?: string;
  paymentId: string; // OrgnlEndToEndId
  status: 'ACSC' | 'RJCT';
  reasonCode?: string; // required for RJCT
  reasonText?: string; // defaults to the catalogue text
  /** Agent reporting the status (the provider) and the agent it reports to (us). */
  instructingAgentBic?: string;
  instructedAgentBic?: string;
  acceptanceDateTime?: string; // ACSC: when the provider settled
}

export function buildPacs002(input: Pacs002Input): string {
  if (input.status === 'RJCT' && !input.reasonCode) throw new Error('pacs.002 RJCT needs a reasonCode');
  const reason = input.reasonCode ? statusReason(input.reasonCode) : undefined;
  const body = el('FIToFIPmtStsRpt', [
    el('GrpHdr', [
      el('MsgId', input.messageId),
      el('CreDtTm', isoDateTime(input.createdAt)),
      input.instructingAgentBic ? agent('InstgAgt', input.instructingAgentBic) : '',
      input.instructedAgentBic ? agent('InstdAgt', input.instructedAgentBic) : '',
    ]),
    el('OrgnlGrpInfAndSts', [
      el('OrgnlMsgId', input.originalMessageId),
      el('OrgnlMsgNmId', 'pacs.008.001.08'),
      el('OrgnlNbOfTxs', '1'),
      el('GrpSts', input.status),
    ]),
    el('TxInfAndSts', [
      el('StsId', ref('STS', input.messageId)),
      el('OrgnlInstrId', input.originalInstructionId ?? input.originalMessageId),
      el('OrgnlEndToEndId', input.paymentId),
      el('OrgnlUETR', uetrFor(input.paymentId)),
      el('TxSts', input.status),
      reason
        ? el('StsRsnInf', [el('Rsn', [el('Cd', reason.code)]), el('AddtlInf', (input.reasonText ?? reason.text).slice(0, 105))])
        : '',
      input.status === 'ACSC' && input.acceptanceDateTime ? el('AccptncDtTm', isoDateTime(input.acceptanceDateTime)) : '',
    ]),
  ]);
  return document(NS.pacs002, body);
}

// ---------------------------------------------------------------- camt.053

export interface Camt053Input {
  providerId: string;
  statementId: string;
  /** Our account at the provider (the prefunded nostro the payouts are drawn from). */
  accountId: string;
  date: string; // YYYY-MM-DD, the statement (booking) date
  currency: string;
  entries: StatementEntry[];
  /**
   * Opening booked balance (minor units, positive = credit balance). Default: the day's payouts
   * rounded up to the next 1,000,000 major units, i.e. the account was prefunded to cover them.
   */
  openingBalanceMinor?: number;
  /** BIC of the account servicer (the provider). Optional; omitted from Svcr when not given. */
  providerBic?: string;
  createdAt?: string; // defaults to end of the statement day
}

/** Statement id convention used by the settlement simulator: STMT-<PROVIDER>-<YYYYMMDD>. */
export function statementIdFor(providerId: string, date: string): string {
  return `STMT-${providerId.toUpperCase()}-${date.replace(/-/g, '')}`;
}

export interface Camt053Totals {
  openingMinor: number;
  debitsMinor: number;
  closingMinor: number;
  count: number;
}

/** Ordering and balance arithmetic shared by the builder and by callers that want the numbers. */
export function camt053Totals(input: Pick<Camt053Input, 'entries' | 'openingBalanceMinor' | 'currency'>): Camt053Totals {
  const debitsMinor = input.entries.reduce((s, e) => s + e.amount.amountMinor, 0);
  const unit = 10 ** exponentOf(input.currency) * 1_000_000;
  const openingMinor = input.openingBalanceMinor ?? Math.max(unit, Math.ceil(debitsMinor / unit) * unit);
  return { openingMinor, debitsMinor, closingMinor: openingMinor - debitsMinor, count: input.entries.length };
}

const balance = (code: 'OPBD' | 'CLBD', minor: number, currency: string, date: string) =>
  el('Bal', [
    el('Tp', [el('CdOrPrtry', [el('Cd', code)])]),
    el('Amt', formatAmount(Math.abs(minor), currency), { Ccy: currency }),
    el('CdtDbtInd', minor < 0 ? 'DBIT' : 'CRDT'),
    el('Dt', [el('Dt', date)]),
  ]);

export function buildCamt053(input: Camt053Input): string {
  for (const e of input.entries) {
    if (e.amount.currency !== input.currency) {
      throw new Error(`statement ${input.statementId} is in ${input.currency} but entry ${e.entryRef} is in ${e.amount.currency}`);
    }
  }
  const entries = [...input.entries].sort((a, b) =>
    a.bookingDate === b.bookingDate ? (a.entryRef < b.entryRef ? -1 : a.entryRef > b.entryRef ? 1 : 0) : a.bookingDate < b.bookingDate ? -1 : 1,
  );
  const t = camt053Totals({ ...input, entries });
  const createdAt = isoDateTime(input.createdAt ?? `${input.date}T23:59:59Z`);
  const body = el('BkToCstmrStmt', [
    el('GrpHdr', [el('MsgId', ref('CAMT', input.statementId)), el('CreDtTm', createdAt)]),
    el('Stmt', [
      el('Id', input.statementId),
      el('CreDtTm', createdAt),
      el('FrToDt', [el('FrDtTm', `${input.date}T00:00:00Z`), el('ToDtTm', `${input.date}T23:59:59Z`)]),
      el('Acct', [
        el('Id', [el('Othr', [el('Id', input.accountId)])]),
        el('Ccy', input.currency),
        el('Ownr', [el('Nm', 'Control Tower Payments (fictional)')]),
        input.providerBic ? agent('Svcr', input.providerBic) : '',
      ]),
      balance('OPBD', t.openingMinor, input.currency, input.date),
      balance('CLBD', t.closingMinor, input.currency, input.date),
      el('TxsSummry', [
        el('TtlNtries', [el('NbOfNtries', String(t.count)), el('Sum', formatAmount(t.debitsMinor, input.currency))]),
        el('TtlDbtNtries', [el('NbOfNtries', String(t.count)), el('Sum', formatAmount(t.debitsMinor, input.currency))]),
      ]),
      entries.map((e) =>
        el('Ntry', [
          el('NtryRef', e.entryRef),
          amt('Amt', e.amount),
          el('CdtDbtInd', 'DBIT'), // a payout drawn from our prefunded account
          el('Sts', [el('Cd', 'BOOK')]),
          el('BookgDt', [el('Dt', isoDate(e.bookingDate))]),
          el('ValDt', [el('Dt', isoDate(e.bookingDate))]),
          el('AcctSvcrRef', e.entryRef),
          el('BkTxCd', [el('Domn', [el('Cd', 'PMNT'), el('Fmly', [el('Cd', 'ICDT'), el('SubFmlyCd', 'XBCT')])])]),
          el('NtryDtls', [
            el('TxDtls', [
              el('Refs', [el('AcctSvcrRef', e.entryRef), el('EndToEndId', e.endToEndId), el('UETR', uetrFor(e.endToEndId))]),
              amt('Amt', e.amount),
              el('CdtDbtInd', 'DBIT'),
            ]),
          ]),
        ]),
      ),
    ]),
  ]);
  return document(NS.camt053, body);
}
