// `npm run verify:copy` - static scan of everything a visitor, buyer or presenter can read.
// It is a safety net for the legal/compliance review (docs/booth/legal-review-pack.md), not a replacement for it:
// it catches the mistakes a machine can catch (banned claims, real brand names, a missing SIMULATION label,
// a consent sentence that drifted, outside links, real contact details) and nothing else.
//
// Everything configurable lives in this file (RULES, SCAN_TARGETS, SCREENS, ALLOW) with a reason for each.
// In-process use (verify:m6): `scanCopy(rootDir)`. CLI: exit code 1 when there is any finding.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type RuleId = 'forbidden-claim' | 'brand-name' | 'sim-label' | 'consent-text' | 'external-url' | 'personal-contact';

export interface Finding {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** 1-based line; 0 when the finding is about the file as a whole (for example a missing label). */
  line: number;
  rule: RuleId;
  /** The offending text (trimmed, shortened). */
  text: string;
  /** What to do about it. */
  hint: string;
}

export interface CopyScanResult {
  findings: Finding[];
  /** Repo-relative paths of every file that was scanned. */
  scanned: string[];
  summary: { files: number; lines: number; findings: number; byRule: Record<RuleId, number>; allowed: number };
}

// ------------------------------------------------------------------------------------------------ configuration

/** Which files are scanned, and as what. `ui`/`answers`/`narration` are visitor-facing source code; `docs` is Markdown. */
export type TargetKind = 'ui' | 'answers' | 'narration' | 'docs';
export interface ScanTarget {
  kind: TargetKind;
  /** Repo-relative directory (scanned recursively) or file. */
  path: string;
  /** Only files whose repo-relative path matches (default: every .ts/.tsx or .md file). */
  include?: RegExp;
  reason: string;
}

export const SCAN_TARGETS: readonly ScanTarget[] = [
  { kind: 'ui', path: 'apps/web/src', reason: 'every screen: stage, kiosk, presenter, console' },
  { kind: 'answers', path: 'services/assistant/src', reason: 'answer templates and knowledge shown to visitors' },
  { kind: 'narration', path: 'services/orchestrator/src', include: /\/(scenarios[^/]*|attract)\.ts$/, reason: 'scenario and attract-loop narration read aloud or shown on the big screen' },
  { kind: 'docs', path: 'README.md', reason: 'public project description' },
  { kind: 'docs', path: 'PROJECT_OVERVIEW.md', reason: 'public project description' },
  { kind: 'docs', path: 'docs/booth', reason: 'booth team documents' },
];

export interface ForbiddenClaim {
  /** Matches the claim; compared case-insensitively. */
  pattern: RegExp;
  reason: string;
  hint: string;
}

/** (a) Claims the booth must never make. Negated uses ("not certified", "never call it compliant") pass. */
export const FORBIDDEN_CLAIMS: readonly ForbiddenClaim[] = [
  { pattern: /\bcompliant\b/i, reason: 'implies a regulator or auditor has judged the system compliant', hint: 'say "supports compliance workflows" or "demonstrates sanctions screening", never "compliant"' },
  { pattern: /\bcertified\b/i, reason: 'no certification exists', hint: 'remove, or say "not certified for any regulation"' },
  { pattern: /\bcertification\b/i, reason: 'no certification exists', hint: 'remove, or say "not certified"' },
  { pattern: /\bguaranteed\b/i, reason: 'absolute promise the demo cannot back', hint: 'describe what the system does and which command proves it' },
  { pattern: /\bwe guarantee\b|\bit guarantees\b|\bguarantees (that|you|zero|no|safe|delivery)\b/i, reason: 'absolute promise the demo cannot back', hint: 'describe what the system does and which command proves it' },
  { pattern: /\bbank[- ]grade\b/i, reason: 'undefined security claim', hint: 'say what is actually done, e.g. "double-entry ledger that refuses unbalanced postings"' },
  { pattern: /\bpci[- ]?(dss[- ])?compliant\b/i, reason: 'PCI status is not claimed', hint: 'remove' },
  { pattern: /\biso[ -]?\d+\s+certified\b/i, reason: 'no ISO certification; the system only uses ISO 20022 message formats', hint: 'say "uses ISO 20022 message formats"' },
  { pattern: /\bregulator[- ]approved\b|\bapproved by (the )?regulators?\b/i, reason: 'no regulator has approved anything', hint: 'remove' },
  { pattern: /\b100\s?%\s?(secure|safe|accurate|reliable|uptime)\b/i, reason: 'absolute claim', hint: 'remove, or give the measured number and its source' },
  { pattern: /\b(un|im)?hack(able|proof)\b|\bunbreakable\b|\bfoolproof\b/i, reason: 'absolute security claim', hint: 'remove' },
  { pattern: /\btamper[- ]?proof\b/i, reason: 'the audit trail is append-only through the API, which is weaker than tamper-proof', hint: 'say "append-only audit trail"' },
  { pattern: /\bsoc ?2\b|\bhipaa\b|\bgdpr[- ]ready\b|\bfedramp\b/i, reason: 'no such attestation exists for this system', hint: 'remove' },
  { pattern: /\bproduction[- ]ready\b|\benterprise[- ]grade\b/i, reason: 'this is a demonstration, not a production system', hint: 'say "reference implementation" or "demonstration"' },
];

/** Words that make an occurrence of a claim a denial ("not certified", "never call the system compliant"). */
const NEGATION = /\b(not|never|no|isn't|aren't|wasn't|doesn't|don't|didn't|cannot|can't|won't|without|neither|nor|avoid|ban(ned)?|forbidden|do not|must not|nothing)\b|n't\b/i;

export interface BrandRule {
  name: string;
  pattern: RegExp;
}

/**
 * (b) Real brands must not appear in UI, narration, answers or booth documents: it would imply a partnership
 * or an endorsement. Ambiguous words (Wise, Square, Visa) are matched case-sensitively. "ISO 20022", "pacs.008"
 * and "camt.053" are standards, not brands, and are fine. Real country and currency names are fine.
 */
export const BRAND_NAMES: readonly BrandRule[] = [
  ...(
    [
      'Visa', 'Mastercard', 'MasterCard', 'Amex', 'American Express', 'PayPal', 'Stripe', 'Adyen', 'Wise', 'TransferWise', 'Revolut',
      'JPMorgan', 'J\\.P\\. Morgan', 'HSBC', 'Citibank', 'Barclays', 'Deutsche Bank', 'Wells Fargo', 'Bank of America',
      'Western Union', 'MoneyGram', 'Ripple', 'Zelle', 'Venmo', 'Alipay', 'WeChat Pay', 'Square', 'Cash App', 'Klarna',
      'Plaid', 'Marqeta', 'Airwallex', 'Nium', 'Ebury', 'Currencycloud', 'Payoneer', 'Worldpay', 'Checkout\\.com', 'Form3', 'Mambu',
      'Temenos', 'Finastra', 'Fiserv', 'Thought Machine', 'Modern Treasury', 'Featurespace', 'ComplyAdvantage', 'Refinitiv', 'LexisNexis', 'Actimize',
    ] as const
  ).map((name) => ({ name: name.replace(/\\/g, ''), pattern: new RegExp(`\\b${name}\\b`) })),
  { name: 'SWIFT', pattern: /\bSWIFT\b/ },
  { name: 'Swift gpi', pattern: /\bSWIFT gpi\b|\bSwift gpi\b/ },
];

/** (c) Screens that a visitor can land on. Each source file must carry the simulation / synthetic-data label. */
export interface RequiredLabel {
  screen: string;
  file: string;
  /** Any one of these counts. */
  label: RegExp;
}
export const SCREENS: readonly RequiredLabel[] = [
  { screen: '#/stage (big screen)', file: 'apps/web/src/stage/MainStage.tsx', label: /SIMULATION|synthetic data/i },
  { screen: '#/kiosk (visitor kiosk)', file: 'apps/web/src/kiosk/Kiosk.tsx', label: /SIMULATION|synthetic data|fictional data/i },
  { screen: '#/presenter (presenter console)', file: 'apps/web/src/components/PresenterConsole.tsx', label: /simulation|synthetic data/i },
  { screen: '#/console (operations console header)', file: 'apps/web/src/console/shell/Shell.tsx', label: /synthetic data|SIMULATION/i },
  { screen: '#/console (sign-in page)', file: 'apps/web/src/console/shell/SignInPage.tsx', label: /synthetic data|SIMULATION/i },
  { screen: '#/live #/ledger #/fx #/providers (audience header)', file: 'apps/web/src/components/Header.tsx', label: /SIMULATION|synthetic data/i },
];

/** (d) The consent sentence. The UI constant is the source of truth; these topics must all be in it. */
export const CONSENT_SOURCE = { file: 'apps/web/src/kiosk/lead.ts', constant: 'CONSENT_TEXT' } as const;
export const CONSENT_TOPICS: readonly { topic: string; pattern: RegExp }[] = [
  { topic: 'contact purpose (we will email the visitor)', pattern: /\b(email|contact|get in touch)\b/i },
  { topic: 'where the data is kept (on this booth laptop only)', pattern: /\b(this|the) (booth )?laptop\b/i },
  { topic: 'deletion (after the event / on request)', pattern: /\bdelete\b/i },
];
/** Documents that must quote the consent sentence word for word when they quote it at all. */
export const CONSENT_QUOTED_IN = ['docs/booth/legal-review-pack.md', 'docs/booth/staff-lead-handling.md'] as const;
/** A booth-side constant, if the booth service ever stores the sentence itself, must be identical to the UI one. */
export const CONSENT_BOOTH_DIR = 'services/booth/src';

/** (e) Hosts allowed in a URL in visitor-facing source. Everything else is a hard-coded external link. */
export const ALLOWED_URL_HOST = (host: string): boolean =>
  host === 'www.w3.org' || // SVG / XML namespaces
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '[::1]' ||
  host.endsWith('.test') ||
  host.endsWith('.localhost') ||
  host === 'example.com' || host === 'example.org' || host === 'example.net' ||
  host.endsWith('.example.com') || host.endsWith('.example.org') || host.endsWith('.example.net') ||
  host.endsWith('.example') ||
  host.startsWith('${') || // template literal: host comes from configuration
  host.endsWith('.local'); // placeholder base for parsing relative URLs (new URL(path, 'http://booth.local'))

/** (f) Contact details. Fictional ones (example/test domains, 555-01xx numbers) are fine. */
export const ALLOWED_EMAIL_DOMAIN = (domain: string): boolean =>
  /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|local)$/i.test(domain);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const PHONE_RES: readonly RegExp[] = [
  /(?<![\w.])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\w.])/g, // +44 20 7946 0000
  /(?<![\w.])\(\d{3}\)\s?\d{3}[-.\s]\d{4}(?![\w.])/g, // (415) 555-0100
  /(?<![\w.])\d{3}[-.]\d{3}[-.]\d{4}(?![\w.])/g, // 415-555-0100
];
const isFictionalPhone = (s: string): boolean => /555[-.\s)]*01\d\d/.test(s) || /\+\d*[\s-]*0{6,}/.test(s);

export interface AllowEntry {
  rule: RuleId;
  /** Repo-relative file (exact) or pattern. */
  file: string | RegExp;
  /** Only lines that match (default: every line of the file). */
  line?: RegExp;
  reason: string;
}

/**
 * Allow-list: places where a rule would fire but the use is right. Every entry needs a reason a reviewer can judge.
 * A single line can also opt out inline with `copy-check:allow <rule> -- <reason>` on the line or the line above.
 */
export const ALLOW: readonly AllowEntry[] = [
  { rule: 'forbidden-claim', file: 'docs/booth/legal-review-pack.md', reason: 'the legal pack lists the banned words so the reviewer can search for them' },
  { rule: 'forbidden-claim', file: 'docs/booth/claims-register.md', reason: 'the claims register lists what is NOT claimed, naming the banned words' },
  { rule: 'forbidden-claim', file: 'docs/booth/faq.md', line: /compliant|certified|guarantee|bank-grade/i, reason: 'the FAQ answers "is it compliant?" and must name the word to deny it' },
  { rule: 'forbidden-claim', file: 'docs/booth/training-plan.md', reason: 'the self-test and the "never say" list name the banned words' },
  { rule: 'forbidden-claim', file: 'docs/booth/presenter-runbook.md', line: /never|do not|don't|not say|avoid/i, reason: 'the runbook tells presenters which words to avoid' },
  { rule: 'brand-name', file: 'docs/booth/legal-review-pack.md', reason: 'the brand policy names the brands that must not appear' },
  { rule: 'brand-name', file: 'docs/booth/training-plan.md', reason: 'the self-test mentions the brand rule' },
  { rule: 'brand-name', file: 'docs/booth/faq.md', line: /real (bank|brand|payment)|name|brand/i, reason: 'the FAQ explains why no real brands appear' },
  { rule: 'brand-name', file: 'docs/booth/claims-register.md', reason: 'the register states what is not claimed about real networks' },
  { rule: 'brand-name', file: 'docs/booth/presenter-runbook.md', line: /never|do not|don't|avoid/i, reason: 'the runbook tells presenters not to name real brands' },
];

// ------------------------------------------------------------------------------------------------ scanning

interface SourceFile {
  rel: string;
  kind: TargetKind;
  lines: string[];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.data', '.git', 'coverage']);
const isTest = (rel: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

function walk(abs: string, rel: string, out: string[]): void {
  const st = statSync(abs);
  if (st.isFile()) {
    out.push(rel);
    return;
  }
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walk(path.join(abs, name), `${rel}/${name}`, out);
  }
}

function collect(rootDir: string): SourceFile[] {
  const files = new Map<string, SourceFile>();
  for (const t of SCAN_TARGETS) {
    const abs = path.join(rootDir, t.path);
    if (!existsSync(abs)) continue;
    const rels: string[] = [];
    walk(abs, t.path, rels);
    for (const rel of rels) {
      const wantsCode = t.kind !== 'docs';
      if (wantsCode ? !/\.(ts|tsx)$/.test(rel) || isTest(rel) : !/\.md$/.test(rel)) continue;
      if (t.include && !t.include.test(rel)) continue;
      if (files.has(rel)) continue;
      files.set(rel, { rel, kind: t.kind, lines: readFileSync(path.join(rootDir, rel), 'utf8').split(/\r?\n/) });
    }
  }
  return [...files.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/** True for lines that are only a comment in TS/TSX: not shown to anyone. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('{/*');
}

/** The text of a code line that can reach a screen: comments removed. */
function visibleText(line: string): string {
  return line.replace(/\s\/\/\s.*$/, '').replace(/\/\*.*?\*\//g, '');
}

function shorten(s: string, n = 160): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const INLINE_ALLOW = /copy-check:allow\s+([a-z-]+)/gi;
function inlineAllowed(lines: string[], idx: number, rule: RuleId): boolean {
  for (const l of [lines[idx], idx > 0 ? lines[idx - 1] : undefined]) {
    if (!l) continue;
    for (const m of l.matchAll(INLINE_ALLOW)) if (m[1] === rule) return true;
  }
  return false;
}

function allowListed(f: Finding, lineText: string): boolean {
  return ALLOW.some(
    (a) => a.rule === f.rule && (typeof a.file === 'string' ? a.file === f.file : a.file.test(f.file)) && (!a.line || a.line.test(lineText)),
  );
}

/** Is the claim at `index` denied by the words in front of it, in the same sentence? */
function negatedBefore(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 90), index);
  const sentence = before.split(/[.!?;:]\s|[|]/).pop() ?? before;
  return NEGATION.test(sentence);
}

function urlHost(url: string): string {
  const m = /^https?:\/\/([^/:?#\s]+|\[[^\]]+\]|\$\{[^}]*\})/i.exec(url);
  return (m?.[1] ?? '').toLowerCase();
}

/** Extract `export const NAME = '...'` (single, double or backtick quoted; adjacent "a" + "b" pieces joined). */
export function extractStringConstant(source: string, name: string): string | null {
  const start = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::\\s*string)?\\s*=\\s*`).exec(source);
  if (!start) return null;
  let i = start.index + start[0].length;
  let out = '';
  for (;;) {
    while (/\s/.test(source[i] ?? '')) i++;
    const q = source[i];
    if (q !== '"' && q !== "'" && q !== '`') return out || null;
    i++;
    for (; i < source.length && source[i] !== q; i++) {
      if (source[i] === '\\') {
        const n = source[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '');
      } else out += source[i];
    }
    i++;
    while (/\s/.test(source[i] ?? '')) i++;
    if (source[i] === '+') {
      i++;
      continue;
    }
    return out;
  }
}

export function scanCopy(rootDir: string): CopyScanResult {
  const files = collect(rootDir);
  const findings: Finding[] = [];
  let lineCount = 0;
  let allowed = 0;

  const push = (f: Finding, lines: string[] | undefined, lineText: string): void => {
    if (f.line > 0 && lines && inlineAllowed(lines, f.line - 1, f.rule)) {
      allowed++;
      return;
    }
    if (allowListed(f, lineText)) {
      allowed++;
      return;
    }
    findings.push(f);
  };

  for (const file of files) {
    const isCode = file.kind !== 'docs';
    for (let i = 0; i < file.lines.length; i++) {
      const raw = file.lines[i]!;
      lineCount++;
      if (isCode && isCommentLine(raw)) continue;
      const text = isCode ? visibleText(raw) : raw;
      if (!text.trim()) continue;
      const at = (rule: RuleId, hint: string, shown: string): Finding => ({ file: file.rel, line: i + 1, rule, text: shorten(shown), hint });

      // (a) forbidden claims
      for (const c of FORBIDDEN_CLAIMS) {
        const re = new RegExp(c.pattern.source, c.pattern.flags.includes('g') ? c.pattern.flags : `${c.pattern.flags}g`);
        for (const m of text.matchAll(re)) {
          if (negatedBefore(text, m.index ?? 0)) continue;
          push(at('forbidden-claim', `${c.hint} (${c.reason})`, text), file.lines, text);
          break;
        }
      }

      // (b) real brand names
      for (const b of BRAND_NAMES) {
        const m = b.pattern.exec(text);
        if (!m) continue;
        push(at('brand-name', `remove "${b.name}": real company and network names imply a partnership; use "a card network", "a bank" or a fictional name (Orion, Lyra, Vega)`, text), file.lines, text);
      }

      // (e) external URLs in visitor-facing source (docs may link out)
      if (isCode) {
        for (const m of text.matchAll(/https?:\/\/[^\s'"`)<>\\]+/gi)) {
          if (ALLOWED_URL_HOST(urlHost(m[0]))) continue;
          push(at('external-url', 'the booth runs offline: remove the link or use a local address; the screen must not point visitors at a live site', text), file.lines, text);
          break;
        }
      }

      // (f) real people's contact details
      for (const m of text.matchAll(EMAIL_RE)) {
        if (ALLOWED_EMAIL_DOMAIN(m[1]!)) continue;
        push(at('personal-contact', 'replace with a fictional address on example.com (or remove it); never publish a real person\'s email', text), file.lines, text);
        break;
      }
      for (const re of PHONE_RES) {
        const hit = [...text.matchAll(re)].find((m) => m[0].replace(/\D/g, '').length >= 9 && !isFictionalPhone(m[0]));
        if (hit) {
          push(at('personal-contact', 'replace with a fictional number (555-0100 to 555-0199) or remove it', text), file.lines, text);
          break;
        }
      }
    }
  }

  // (c) the simulation label on every top-level screen
  for (const s of SCREENS) {
    const abs = path.join(rootDir, s.file);
    if (!existsSync(abs)) {
      push({ file: s.file, line: 0, rule: 'sim-label', text: `file for ${s.screen} not found`, hint: 'update SCREENS in tools/booth/copy-check.ts if the screen moved' }, undefined, '');
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    const has = lines.some((l) => !isCommentLine(l) && s.label.test(l));
    if (!has) {
      push({ file: s.file, line: 0, rule: 'sim-label', text: `${s.screen} has no SIMULATION / synthetic-data label`, hint: 'add the label component or text ("SIMULATION · SYNTHETIC DATA") to this screen' }, undefined, '');
    }
  }

  // (d) consent sentence
  const consentFile = path.join(rootDir, CONSENT_SOURCE.file);
  let consent: string | null = null;
  if (existsSync(consentFile)) consent = extractStringConstant(readFileSync(consentFile, 'utf8'), CONSENT_SOURCE.constant);
  if (consent === null) {
    push({ file: CONSENT_SOURCE.file, line: 0, rule: 'consent-text', text: `${CONSENT_SOURCE.constant} not found`, hint: 'the lead form needs its consent sentence in one exported constant' }, undefined, '');
  } else {
    const where = (() => {
      const idx = readFileSync(consentFile, 'utf8').split(/\r?\n/).findIndex((l) => l.includes(CONSENT_SOURCE.constant));
      return idx + 1;
    })();
    for (const t of CONSENT_TOPICS) {
      if (!t.pattern.test(consent)) {
        push({ file: CONSENT_SOURCE.file, line: where, rule: 'consent-text', text: shorten(consent), hint: `the consent sentence must mention ${t.topic}` }, undefined, '');
      }
    }
    for (const doc of CONSENT_QUOTED_IN) {
      const abs = path.join(rootDir, doc);
      if (!existsSync(abs)) continue;
      const body = readFileSync(abs, 'utf8').replace(/\s+/g, ' ');
      const norm = consent.replace(/\s+/g, ' ');
      if (!body.includes(norm)) {
        push({ file: doc, line: 0, rule: 'consent-text', text: 'does not contain the exact consent sentence shown on the kiosk', hint: `paste ${CONSENT_SOURCE.constant} from ${CONSENT_SOURCE.file} word for word` }, undefined, '');
      }
    }
    const boothDir = path.join(rootDir, CONSENT_BOOTH_DIR);
    if (existsSync(boothDir)) {
      const rels: string[] = [];
      walk(boothDir, CONSENT_BOOTH_DIR, rels);
      for (const rel of rels.filter((r) => /\.ts$/.test(r) && !isTest(r))) {
        const stored = extractStringConstant(readFileSync(path.join(rootDir, rel), 'utf8'), 'CONSENT_TEXT');
        if (stored !== null && stored !== consent) {
          push({ file: rel, line: 0, rule: 'consent-text', text: shorten(stored), hint: `the booth's stored consent text differs from ${CONSENT_SOURCE.file}; they must be identical` }, undefined, '');
        }
      }
    }
  }

  const byRule: Record<RuleId, number> = { 'forbidden-claim': 0, 'brand-name': 0, 'sim-label': 0, 'consent-text': 0, 'external-url': 0, 'personal-contact': 0 };
  for (const f of findings) byRule[f.rule]++;
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return {
    findings,
    scanned: files.map((f) => f.rel),
    summary: { files: files.length, lines: lineCount, findings: findings.length, byRule, allowed },
  };
}

/** Plain-text report for the terminal. */
export function formatCopyReport(r: CopyScanResult): string {
  const out: string[] = [];
  for (const f of r.findings) {
    out.push(`${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]`);
    out.push(`    ${f.text}`);
    out.push(`    fix: ${f.hint}`);
  }
  const s = r.summary;
  const rules = Object.entries(s.byRule).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  out.push(
    r.findings.length === 0
      ? `Copy check passed: ${s.files} files, ${s.lines} lines scanned, ${s.allowed} allow-listed use(s).`
      : `Copy check FAILED: ${s.findings} finding(s) (${rules}) in ${s.files} files, ${s.lines} lines scanned.`,
  );
  return out.join('\n');
}

export const COPY_CHECK_USAGE = `Usage: npm run verify:copy [-- options]

Scans visitor-facing text (screens, assistant answers, scenario narration, README, booth docs) for banned
claims, real brand names, a missing SIMULATION label, a drifting consent sentence, outside links and real
contact details. Exit code 1 when anything is found. It supports the legal review; it does not replace it.

Options:
  --root <dir>   Repository root (default: this repository)
  --json         Print the result as JSON
  -h, --help     Show this help
`;

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function main(argv: readonly string[]): number {
  let root = DEFAULT_ROOT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      process.stdout.write(COPY_CHECK_USAGE);
      return 0;
    }
    if (a === '--json') json = true;
    else if (a === '--root') root = path.resolve(argv[++i] ?? '');
    else {
      console.error(`Unknown option "${a}". Run "npm run verify:copy -- --help".`);
      return 2;
    }
  }
  const r = scanCopy(root);
  console.log(json ? JSON.stringify(r, null, 2) : formatCopyReport(r));
  return r.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
