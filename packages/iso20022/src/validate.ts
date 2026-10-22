// Structural validation of the messages we build (not a full XSD validation): well-formed XML,
// expected root and namespace, required paths present, amount / currency / date / id formats.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { NS, type MessageType } from './messages';
import { parseAmount } from './util';

export interface ValidationResult {
  ok: boolean;
  messageType: MessageType | null;
  errors: string[];
  /** Parsed tree (attributes prefixed with "@_", text in "#text"); present when the XML is well-formed. */
  document?: Record<string, unknown>;
}

const ARRAY_TAGS = new Set(['Ntry', 'Bal', 'CdtTrfTxInf', 'TxInfAndSts', 'StsRsnInf', 'Stmt', 'TxDtls', 'Ustrd']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Walk a dotted path; array segments take the first element. */
function at(node: unknown, path: string): unknown {
  let cur: unknown = node;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) cur = cur[0];
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return Array.isArray(cur) ? cur[0] : cur;
}

const textOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : isObj(v) && typeof v['#text'] === 'string' ? (v['#text'] as string) : undefined;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

const RE = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  dateTime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  bic: /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
  uetr: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  ccy: /^[A-Z]{3}$/,
  rate: /^\d{1,11}(\.\d{1,10})?$/,
  country: /^[A-Z]{2}$/,
};

class Checker {
  errors: string[] = [];
  constructor(private readonly root: Obj) {}

  text(path: string, opts: { re?: RegExp; max?: number; oneOf?: string[] } = {}): string | undefined {
    const v = textOf(at(this.root, path));
    if (v === undefined || v === '') {
      this.errors.push(`missing ${path}`);
      return undefined;
    }
    if (opts.re && !opts.re.test(v)) this.errors.push(`invalid ${path}: "${v}"`);
    // EndToEndId carries our paymentId (a 36-char UUID), one over Max35Text: tolerated by design.
    if (opts.max !== undefined && v.length > opts.max) this.errors.push(`${path} longer than ${opts.max} chars`);
    if (opts.oneOf && !opts.oneOf.includes(v)) this.errors.push(`invalid ${path}: "${v}" (expected ${opts.oneOf.join('|')})`);
    return v;
  }

  amount(path: string, node: unknown = at(this.root, path)): { minor: number; currency: string } | undefined {
    if (node === undefined) {
      this.errors.push(`missing ${path}`);
      return undefined;
    }
    const value = textOf(node);
    const ccy = isObj(node) ? node['@_Ccy'] : undefined;
    if (typeof ccy !== 'string' || !RE.ccy.test(ccy)) {
      this.errors.push(`invalid ${path}/@Ccy: "${String(ccy)}"`);
      return undefined;
    }
    const minor = value === undefined ? null : parseAmount(value, ccy);
    if (minor === null) {
      this.errors.push(`invalid ${path} amount "${value ?? ''}" for ${ccy}`);
      return undefined;
    }
    return { minor, currency: ccy };
  }
}

function validatePacs008(doc: Obj, c: Checker) {
  const m = 'FIToFICstmrCdtTrf';
  c.text(`${m}.GrpHdr.MsgId`, { max: 35 });
  c.text(`${m}.GrpHdr.CreDtTm`, { re: RE.dateTime });
  c.text(`${m}.GrpHdr.NbOfTxs`, { re: /^\d{1,15}$/ });
  c.text(`${m}.GrpHdr.SttlmInf.SttlmMtd`, { oneOf: ['INDA', 'INGA', 'COVE', 'CLRG'] });
  const nb = textOf(at(doc, `${m}.GrpHdr.NbOfTxs`));
  const txs = asArray(at(doc, m) && (at(doc, m) as Obj)['CdtTrfTxInf']);
  if (txs.length === 0) c.errors.push(`missing ${m}.CdtTrfTxInf`);
  else if (nb !== undefined && Number(nb) !== txs.length) c.errors.push(`NbOfTxs ${nb} does not match ${txs.length} CdtTrfTxInf`);
  const t = `${m}.CdtTrfTxInf`;
  c.text(`${t}.PmtId.InstrId`, { max: 35 });
  c.text(`${t}.PmtId.EndToEndId`, { max: 36 });
  c.text(`${t}.PmtId.UETR`, { re: RE.uetr });
  c.amount(`${t}.IntrBkSttlmAmt`);
  c.text(`${t}.IntrBkSttlmDt`, { re: RE.date });
  c.amount(`${t}.InstdAmt`);
  c.text(`${t}.XchgRate`, { re: RE.rate });
  c.text(`${t}.ChrgBr`, { oneOf: ['SHAR', 'DEBT', 'CRED', 'SLEV'] });
  c.text(`${t}.Dbtr.Nm`, { max: 140 });
  c.text(`${t}.Dbtr.PstlAdr.Ctry`, { re: RE.country });
  c.text(`${t}.DbtrAcct.Id.Othr.Id`, { max: 34 });
  c.text(`${t}.DbtrAgt.FinInstnId.BICFI`, { re: RE.bic });
  c.text(`${t}.CdtrAgt.FinInstnId.BICFI`, { re: RE.bic });
  c.text(`${t}.Cdtr.Nm`, { max: 140 });
  c.text(`${t}.Cdtr.PstlAdr.Ctry`, { re: RE.country });
  c.text(`${t}.CdtrAcct.Id.Othr.Id`, { max: 34 });
  c.text(`${t}.RmtInf.Ustrd`, { max: 140 });
}

function validatePacs002(doc: Obj, c: Checker) {
  const m = 'FIToFIPmtStsRpt';
  c.text(`${m}.GrpHdr.MsgId`, { max: 35 });
  c.text(`${m}.GrpHdr.CreDtTm`, { re: RE.dateTime });
  c.text(`${m}.OrgnlGrpInfAndSts.OrgnlMsgId`, { max: 35 });
  c.text(`${m}.OrgnlGrpInfAndSts.OrgnlMsgNmId`, { re: /^pacs\.008\.\d{3}\.\d{2}$/ });
  const t = `${m}.TxInfAndSts`;
  c.text(`${t}.OrgnlEndToEndId`, { max: 36 });
  c.text(`${t}.OrgnlUETR`, { re: RE.uetr });
  const sts = c.text(`${t}.TxSts`, { oneOf: ['ACSC', 'ACSP', 'ACCC', 'PDNG', 'RJCT'] });
  if (sts === 'RJCT') c.text(`${t}.StsRsnInf.Rsn.Cd`, { re: /^[A-Z0-9]{4}$/ });
  for (const bicPath of [`${m}.GrpHdr.InstgAgt.FinInstnId.BICFI`, `${m}.GrpHdr.InstdAgt.FinInstnId.BICFI`]) {
    if (at(doc, bicPath) !== undefined) c.text(bicPath, { re: RE.bic });
  }
}

function validateCamt053(doc: Obj, c: Checker) {
  const m = 'BkToCstmrStmt';
  c.text(`${m}.GrpHdr.MsgId`, { max: 35 });
  c.text(`${m}.GrpHdr.CreDtTm`, { re: RE.dateTime });
  const s = `${m}.Stmt`;
  c.text(`${s}.Id`, { max: 35 });
  c.text(`${s}.Acct.Id.Othr.Id`, { max: 34 });
  const acctCcy = c.text(`${s}.Acct.Ccy`, { re: RE.ccy });
  const stmt = at(doc, s);
  if (!isObj(stmt)) return;

  const bals = new Map<string, number>();
  for (const [i, b] of asArray(stmt['Bal']).entries()) {
    const code = textOf(at(b, 'Tp.CdOrPrtry.Cd'));
    const a = c.amount(`${s}.Bal[${i}].Amt`, at(b, 'Amt'));
    const ind = textOf(at(b, 'CdtDbtInd'));
    if (ind !== 'CRDT' && ind !== 'DBIT') c.errors.push(`invalid ${s}.Bal[${i}].CdtDbtInd: "${ind ?? ''}"`);
    if (!RE.date.test(textOf(at(b, 'Dt.Dt')) ?? '')) c.errors.push(`invalid ${s}.Bal[${i}].Dt.Dt`);
    if (a && acctCcy && a.currency !== acctCcy) c.errors.push(`${s}.Bal[${i}] currency ${a.currency} differs from account ${acctCcy}`);
    if (code && a) bals.set(code, ind === 'DBIT' ? -a.minor : a.minor);
  }
  for (const need of ['OPBD', 'CLBD']) if (!bals.has(need)) c.errors.push(`missing ${s}.Bal with Tp ${need}`);

  let net = 0;
  for (const [i, n] of asArray(stmt['Ntry']).entries()) {
    const p = `${s}.Ntry[${i}]`;
    const a = c.amount(`${p}.Amt`, at(n, 'Amt'));
    const ind = textOf(at(n, 'CdtDbtInd'));
    if (ind !== 'CRDT' && ind !== 'DBIT') c.errors.push(`invalid ${p}.CdtDbtInd: "${ind ?? ''}"`);
    if (textOf(at(n, 'Sts.Cd')) === undefined) c.errors.push(`missing ${p}.Sts.Cd`);
    if (!RE.date.test(textOf(at(n, 'BookgDt.Dt')) ?? '')) c.errors.push(`invalid ${p}.BookgDt.Dt`);
    const svcrRef = textOf(at(n, 'AcctSvcrRef'));
    if (!svcrRef) c.errors.push(`missing ${p}.AcctSvcrRef`);
    else if (svcrRef.length > 35) c.errors.push(`${p}.AcctSvcrRef longer than 35 chars`);
    if (!textOf(at(n, 'NtryDtls.TxDtls.Refs.EndToEndId'))) c.errors.push(`missing ${p}.NtryDtls.TxDtls.Refs.EndToEndId`);
    if (a && acctCcy && a.currency !== acctCcy) c.errors.push(`${p} currency ${a.currency} differs from account ${acctCcy}`);
    if (a && textOf(at(n, 'Sts.Cd')) === 'BOOK') net += ind === 'DBIT' ? -a.minor : a.minor;
  }
  const opening = bals.get('OPBD');
  const closing = bals.get('CLBD');
  if (opening !== undefined && closing !== undefined && opening + net !== closing) {
    c.errors.push(`balances do not add up: opening ${opening} + booked entries ${net} != closing ${closing} (minor units)`);
  }
}

const BY_NAMESPACE: Record<string, { type: MessageType; root: string; check: (doc: Obj, c: Checker) => void }> = {
  [NS.pacs008]: { type: 'pacs.008', root: 'FIToFICstmrCdtTrf', check: validatePacs008 },
  [NS.pacs002]: { type: 'pacs.002', root: 'FIToFIPmtStsRpt', check: validatePacs002 },
  [NS.camt053]: { type: 'camt.053', root: 'BkToCstmrStmt', check: validateCamt053 },
};

export function parseAndValidate(xml: string): ValidationResult {
  const wellFormed = XMLValidator.validate(xml);
  if (wellFormed !== true) {
    return { ok: false, messageType: null, errors: [`not well-formed XML: ${wellFormed.err.msg} (line ${wellFormed.err.line})`] };
  }
  const parsed = parser.parse(xml) as Obj;
  const docNode = parsed['Document'];
  if (!isObj(docNode)) return { ok: false, messageType: null, errors: ['root element must be <Document>'], document: parsed };
  const ns = docNode['@_xmlns'];
  const spec = typeof ns === 'string' ? BY_NAMESPACE[ns] : undefined;
  if (!spec) {
    return { ok: false, messageType: null, errors: [`unsupported or missing namespace: ${String(ns)}`], document: parsed };
  }
  if (!isObj(docNode[spec.root])) {
    return { ok: false, messageType: spec.type, errors: [`expected <${spec.root}> under <Document> for ${spec.type}`], document: parsed };
  }
  const c = new Checker(docNode);
  spec.check(docNode, c);
  return { ok: c.errors.length === 0, messageType: spec.type, errors: c.errors, document: parsed };
}
