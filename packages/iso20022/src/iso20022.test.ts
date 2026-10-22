import { describe, expect, it } from 'vitest';
import type { Money, Party, StatementEntry } from '@ct/contracts/browser';
import {
  buildCamt053,
  buildPacs002,
  buildPacs008,
  camt053Totals,
  formatAmount,
  parseAmount,
  parseAndValidate,
  statementIdFor,
  uetrFor,
} from './index';

const PID = '3f6c2a9e-8d41-4b7a-9c55-1e2f3a4b5c6d';

const party = (name: string, country: string, accountId: string): Party => ({ name, country, accountId });

const CASES: { corridor: string; src: Money; tgt: Money; rate: string; srcText: string; tgtText: string }[] = [
  { corridor: 'US-IN', src: { amountMinor: 125_000, currency: 'USD' }, tgt: { amountMinor: 10_369_828, currency: 'INR' }, rate: '82.958625', srcText: '1250.00', tgtText: '103698.28' },
  { corridor: 'DE-BR', src: { amountMinor: 50_000, currency: 'EUR' }, tgt: { amountMinor: 294_465, currency: 'BRL' }, rate: '5.889315', srcText: '500.00', tgtText: '2944.65' },
  { corridor: 'GB-PH', src: { amountMinor: 100_000, currency: 'GBP' }, tgt: { amountMinor: 7_214_660, currency: 'PHP' }, rate: '72.1466', srcText: '1000.00', tgtText: '72146.60' },
  { corridor: 'US-JP', src: { amountMinor: 100_000, currency: 'USD' }, tgt: { amountMinor: 149_250, currency: 'JPY' }, rate: '149.25', srcText: '1000.00', tgtText: '149250' },
];

function pacs008For(c: (typeof CASES)[number], debtorName = 'Fictional Sender') {
  return buildPacs008({
    messageId: 'MSG-0001',
    createdAt: '2026-10-22T10:15:30.123Z',
    paymentId: PID,
    settlementDate: '2026-10-22',
    settlementAmount: c.tgt,
    instructedAmount: c.src,
    exchangeRate: c.rate,
    debtor: party(debtorName, c.corridor.slice(0, 2), 'ACC-SRC-1'),
    creditor: party('Fictional Receiver', c.corridor.slice(3), 'ACC-TGT-1'),
    creditorAgentBic: 'XORIUS33XXX',
  });
}

describe('amount formatting', () => {
  it('uses the currency exponent and round-trips exactly', () => {
    expect(formatAmount(10_369_828, 'INR')).toBe('103698.28');
    expect(formatAmount(5, 'USD')).toBe('0.05');
    expect(formatAmount(149_250, 'JPY')).toBe('149250');
    expect(parseAmount('103698.28', 'INR')).toBe(10_369_828);
    expect(parseAmount('0.5', 'USD')).toBe(50);
    expect(parseAmount('149250', 'JPY')).toBe(149_250);
    expect(parseAmount('1.5', 'JPY')).toBeNull();
    expect(parseAmount('1,000.00', 'USD')).toBeNull();
  });
  it('derives a stable UUID v4-shaped UETR from the payment id', () => {
    expect(uetrFor(PID)).toBe(uetrFor(PID));
    expect(uetrFor(PID)).not.toBe(uetrFor(`${PID}x`));
    expect(uetrFor(PID)).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
});

describe('pacs.008', () => {
  it.each(CASES)('is valid and carries the amounts for $corridor', (c) => {
    const xml = pacs008For(c);
    const v = parseAndValidate(xml);
    expect(v.errors).toEqual([]);
    expect(v).toMatchObject({ ok: true, messageType: 'pacs.008' });
    expect(xml).toContain('xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"');
    expect(xml).toContain(`<IntrBkSttlmAmt Ccy="${c.tgt.currency}">${c.tgtText}</IntrBkSttlmAmt>`);
    expect(xml).toContain(`<InstdAmt Ccy="${c.src.currency}">${c.srcText}</InstdAmt>`);
    expect(xml).toContain(`<XchgRate>${c.rate}</XchgRate>`);
    expect(xml).toContain(`<EndToEndId>${PID}</EndToEndId>`);
    expect(xml).toContain(`<UETR>${uetrFor(PID)}</UETR>`);
    expect(xml).toContain('<NbOfTxs>1</NbOfTxs>');
    expect(xml).toContain('<ChrgBr>SHAR</ChrgBr>');
    expect(xml).toContain('<CreDtTm>2026-10-22T10:15:30Z</CreDtTm>');
    expect(xml).toContain('<BICFI>XORIUS33XXX</BICFI>');
  });

  it('is deterministic', () => {
    expect(pacs008For(CASES[0]!)).toBe(pacs008For(CASES[0]!));
  });

  it('escapes hostile names and the parser gets them back intact', () => {
    const hostile = `Tom & Jerry's <script>"Ltd"</script>`;
    const xml = pacs008For(CASES[0]!, hostile);
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('Tom &amp; Jerry&apos;s &lt;script&gt;&quot;Ltd&quot;&lt;/script&gt;');
    const v = parseAndValidate(xml);
    expect(v.errors).toEqual([]);
    const doc = v.document as any;
    expect(doc.Document.FIToFICstmrCdtTrf.CdtTrfTxInf[0].Dbtr.Nm).toBe(hostile);
  });
});

describe('pacs.002', () => {
  const base = { messageId: 'MSG-0002', createdAt: '2026-10-22T10:15:31Z', originalMessageId: 'MSG-0001', paymentId: PID, instructingAgentBic: 'XORIUS33XXX', instructedAgentBic: 'XCTWUS22XXX' };

  it('ACSC is valid', () => {
    const xml = buildPacs002({ ...base, status: 'ACSC', acceptanceDateTime: '2026-10-22T10:15:31Z' });
    expect(parseAndValidate(xml)).toMatchObject({ ok: true, messageType: 'pacs.002', errors: [] });
    expect(xml).toContain('<TxSts>ACSC</TxSts>');
    expect(xml).toContain(`<OrgnlEndToEndId>${PID}</OrgnlEndToEndId>`);
    expect(xml).toContain(`<OrgnlUETR>${uetrFor(PID)}</OrgnlUETR>`);
    expect(xml).not.toContain('<StsRsnInf>');
  });

  it('RJCT carries the reason code and plain-English text', () => {
    const xml = buildPacs002({ ...base, status: 'RJCT', reasonCode: 'AC04' });
    expect(parseAndValidate(xml)).toMatchObject({ ok: true, errors: [] });
    expect(xml).toContain('<TxSts>RJCT</TxSts>');
    expect(xml).toMatch(/<Rsn>\s*<Cd>AC04<\/Cd>\s*<\/Rsn>/);
    expect(xml).toContain('closed');
    expect(() => buildPacs002({ ...base, status: 'RJCT' })).toThrow();
  });
});

describe('camt.053', () => {
  const entry = (n: number, amountMinor: number, currency = 'INR'): StatementEntry => ({
    statementId: statementIdFor('orion', '2026-10-22'),
    entryRef: `NTRY-${String(n).padStart(4, '0')}`,
    providerId: 'orion',
    amount: { amountMinor, currency },
    bookingDate: '2026-10-22',
    endToEndId: `${PID.slice(0, -1)}${n}`,
  });

  it('balances add up and every entry is present', () => {
    const entries = [entry(3, 10_369_828), entry(1, 9_596_818), entry(2, 50)];
    const input = { providerId: 'orion', statementId: 'STMT-ORION-20261022', accountId: 'NOSTRO-ORION-INR', date: '2026-10-22', currency: 'INR', entries, openingBalanceMinor: 50_000_000 };
    const xml = buildCamt053(input);
    const v = parseAndValidate(xml);
    expect(v.errors).toEqual([]);
    expect(v.messageType).toBe('camt.053');
    const t = camt053Totals(input);
    expect(t).toEqual({ openingMinor: 50_000_000, debitsMinor: 19_966_696, closingMinor: 30_033_304, count: 3 });
    expect(xml).toMatch(/<Cd>OPBD<\/Cd>[\s\S]*?<Amt Ccy="INR">500000.00<\/Amt>/);
    expect(xml).toMatch(/<Cd>CLBD<\/Cd>[\s\S]*?<Amt Ccy="INR">300333.04<\/Amt>/);
    expect(xml.match(/<Ntry>/g)).toHaveLength(3);
    // sorted by entryRef for a stable statement
    expect(xml.indexOf('NTRY-0001')).toBeLessThan(xml.indexOf('NTRY-0003'));
    expect(xml).toContain(`<EndToEndId>${entries[0]!.endToEndId}</EndToEndId>`);
    expect(xml).toContain('<Sts>\n');
  });

  it('defaults the opening balance to a prefund that covers the day, and supports JPY', () => {
    const input = { providerId: 'vega', statementId: 'STMT-VEGA-20261022', accountId: 'NOSTRO-VEGA-JPY', date: '2026-10-22', currency: 'JPY', entries: [entry(1, 149_250, 'JPY')] };
    const t = camt053Totals(input);
    expect(t.openingMinor).toBe(1_000_000);
    expect(t.closingMinor).toBe(850_750);
    const xml = buildCamt053(input);
    expect(parseAndValidate(xml)).toMatchObject({ ok: true, errors: [] });
    expect(xml).toContain('<Amt Ccy="JPY">149250</Amt>');
  });

  it('an empty statement is valid (opening = closing)', () => {
    const xml = buildCamt053({ providerId: 'lyra', statementId: 'STMT-LYRA-20261022', accountId: 'A', date: '2026-10-22', currency: 'PHP', entries: [] });
    expect(parseAndValidate(xml)).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects an entry in another currency', () => {
    expect(() => buildCamt053({ providerId: 'orion', statementId: 'S', accountId: 'A', date: '2026-10-22', currency: 'INR', entries: [entry(1, 1, 'USD')] })).toThrow(/currency|INR/);
  });

  it('the validator catches balances that do not add up', () => {
    const xml = buildCamt053({ providerId: 'orion', statementId: 'S', accountId: 'A', date: '2026-10-22', currency: 'INR', entries: [entry(1, 100)], openingBalanceMinor: 1000 });
    const tampered = xml.replace('<Amt Ccy="INR">9.00</Amt>', '<Amt Ccy="INR">9.01</Amt>');
    expect(tampered).not.toBe(xml);
    const v = parseAndValidate(tampered);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/balances do not add up/);
  });
});

describe('parseAndValidate failures', () => {
  it('reports malformed XML', () => {
    expect(parseAndValidate('<Document><a></Document>')).toMatchObject({ ok: false, messageType: null });
  });
  it('reports an unknown namespace', () => {
    const v = parseAndValidate('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><X/></Document>');
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/namespace/);
  });
  it('reports a missing required element, bad amount and bad currency', () => {
    const xml = pacs008For(CASES[0]!)
      .replace(/<IntrBkSttlmDt>[^<]*<\/IntrBkSttlmDt>/, '')
      .replace('<InstdAmt Ccy="USD">1250.00</InstdAmt>', '<InstdAmt Ccy="USD">1250.001</InstdAmt>')
      .replace('Ccy="INR"', 'Ccy="inr"');
    const v = parseAndValidate(xml);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/missing .*IntrBkSttlmDt/),
        expect.stringMatching(/InstdAmt amount/),
        expect.stringMatching(/IntrBkSttlmAmt\/@Ccy/),
      ]),
    );
  });
  it('reports JPY with decimals', () => {
    const xml = pacs008For(CASES[3]!).replace('<IntrBkSttlmAmt Ccy="JPY">149250</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="JPY">149250.00</IntrBkSttlmAmt>');
    expect(parseAndValidate(xml).ok).toBe(false);
  });
});
