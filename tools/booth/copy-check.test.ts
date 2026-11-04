import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractStringConstant, formatCopyReport, scanCopy, SCREENS, type RuleId } from './copy-check';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GOOD_CONSENT =
  "We'd like to email you about this demo. We store your details on this booth laptop only and delete them after the event. You can ask us to delete them at any time.";

/** A tiny repo that passes every rule; each test then adds one defect. */
function fixture(extra: Record<string, string> = {}, consent = GOOD_CONSENT): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ct-copy-'));
  roots.push(root);
  const files: Record<string, string> = {
    'apps/web/src/kiosk/lead.ts': `export const CONSENT_TEXT =\n  ${JSON.stringify(consent)};\n`,
    'README.md': '# Demo\n\nSimulation. Not certified for any regulation.\n',
    ...Object.fromEntries(SCREENS.map((s) => [s.file, `export const L = '${s.label.source.includes('synthetic') ? 'SIMULATION · synthetic data' : 'SIMULATION'}';\n`])),
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const rules = (root: string): RuleId[] => scanCopy(root).findings.map((f) => f.rule);

describe('copy-check', () => {
  it('passes a clean fixture and reports what it scanned', () => {
    const r = scanCopy(fixture());
    expect(r.findings).toEqual([]);
    expect(r.scanned).toContain('README.md');
    expect(r.scanned).toContain('apps/web/src/kiosk/lead.ts');
    expect(r.summary.findings).toBe(0);
    expect(formatCopyReport(r)).toMatch(/passed/);
  });

  describe('(a) forbidden claims', () => {
    it.each(['compliant', 'certified', 'guaranteed', 'bank-grade', 'PCI-compliant', 'ISO 27001 certified', 'regulator-approved', '100% secure', 'tamper-proof'])(
      'flags "%s" in UI copy with file:line',
      (word) => {
        const r = scanCopy(fixture({ 'apps/web/src/kiosk/Banner.tsx': `const a = 1;\nexport const t = 'Our platform is ${word}.';\n` }));
        const f = r.findings.find((x) => x.rule === 'forbidden-claim');
        expect(f, word).toBeDefined();
        expect(f).toMatchObject({ file: 'apps/web/src/kiosk/Banner.tsx', line: 2 });
        expect(f!.hint.length).toBeGreaterThan(10);
      },
    );

    it('accepts explicitly negated uses', () => {
      const root = fixture({
        'apps/web/src/kiosk/Banner.tsx': "export const a = 'This demo is not certified for any regulation.';\nexport const b = 'We never call the system compliant.';\n",
        'docs/booth/x.md': 'The booth does not claim to be bank-grade or regulator-approved.\n',
      });
      expect(rules(root)).toEqual([]);
    });

    it('does not flag the noun "compliance" or a comment', () => {
      const root = fixture({ 'apps/web/src/kiosk/Banner.tsx': "// we are compliant here\nexport const a = 'Compliance workflows with four eyes.';\n" });
      expect(rules(root)).toEqual([]);
    });

    it('honours the inline allow marker and the allow-list, but only for that rule', () => {
      const inline = fixture({ 'docs/booth/y.md': '<!-- copy-check:allow forbidden-claim -- quoting the banned word -->\nA reviewer must hunt for the word compliant.\nIt is certified. <!-- copy-check:allow forbidden-claim -- same line -->\n' });
      expect(rules(inline)).toEqual([]);
      const wrongRule = fixture({ 'docs/booth/y.md': 'It is certified. <!-- copy-check:allow brand-name -- wrong rule -->\n' });
      expect(rules(wrongRule)).toEqual(['forbidden-claim']);
      const listed = fixture({ 'docs/booth/legal-review-pack.md': `Banned words: compliant, certified, guaranteed.\n${GOOD_CONSENT}\n` });
      expect(rules(listed)).toEqual([]);
      const notListed = fixture({ 'docs/booth/other.md': 'Banned words: compliant, certified, guaranteed.\n' });
      expect(rules(notListed)).toContain('forbidden-claim');
    });
  });

  describe('(b) brand names', () => {
    it.each(['Visa', 'Mastercard', 'PayPal', 'Stripe', 'Adyen', 'Wise', 'Revolut', 'JPMorgan', 'HSBC', 'SWIFT', 'Western Union', 'MoneyGram', 'Ripple', 'Temenos'])(
      'flags %s in narration',
      (brand) => {
        const root = fixture({ 'services/orchestrator/src/scenarios.ts': `export const n = 'Payments travel over ${brand} today.';\n` });
        const f = scanCopy(root).findings.find((x) => x.rule === 'brand-name');
        expect(f, brand).toMatchObject({ file: 'services/orchestrator/src/scenarios.ts', line: 1 });
      },
    );

    it('accepts standards, countries, currencies, fictional providers and ordinary words', () => {
      const root = fixture({
        'services/assistant/src/answer.ts':
          "export const a = 'ISO 20022 pacs.008 and camt.053 between Germany and Brazil, EUR to BRL, via Orion, Lyra and Vega. A visa is not needed; be wise.';\n",
      });
      expect(rules(root)).toEqual([]);
    });

    it('ignores test files and non-scanned folders', () => {
      const root = fixture({ 'apps/web/src/kiosk/x.test.ts': "export const t = 'Stripe';\n", 'tools/other.ts': "export const t = 'Stripe';\n" });
      expect(rules(root)).toEqual([]);
    });
  });

  describe('(c) simulation label', () => {
    it('flags a screen without the label', () => {
      const s = SCREENS[0]!;
      const root = fixture({ [s.file]: "export const L = 'Welcome';\n" });
      const f = scanCopy(root).findings.find((x) => x.rule === 'sim-label');
      expect(f).toMatchObject({ file: s.file, line: 0 });
      expect(f!.text).toContain(s.screen);
    });
    it('flags a missing screen file', () => {
      const root = fixture();
      rmSync(path.join(root, SCREENS[1]!.file));
      expect(scanCopy(root).findings.some((x) => x.rule === 'sim-label' && /not found/.test(x.text))).toBe(true);
    });
    it('a label that only appears in a comment does not count', () => {
      const s = SCREENS[2]!;
      expect(rules(fixture({ [s.file]: '// SIMULATION label goes here\nexport const L = 1;\n' }))).toEqual(['sim-label']);
    });
  });

  describe('(d) consent sentence', () => {
    it.each([
      ['contact purpose', 'We store your details on this booth laptop only and delete them after the event.'],
      ['laptop', "We'd like to email you about this demo and delete your details after the event."],
      ['deletion', "We'd like to email you about this demo. We keep your details on this booth laptop."],
    ])('flags a sentence missing the %s', (_n, sentence) => {
      expect(rules(fixture({}, sentence))).toEqual(['consent-text']);
    });
    it('flags a document that quotes a different sentence', () => {
      const root = fixture({ 'docs/booth/legal-review-pack.md': 'Consent: "We may email you."\n' });
      const f = scanCopy(root).findings.find((x) => x.rule === 'consent-text');
      expect(f?.file).toBe('docs/booth/legal-review-pack.md');
    });
    it('accepts a document that quotes it exactly, and a booth constant that is identical', () => {
      const root = fixture({
        'docs/booth/legal-review-pack.md': `> ${GOOD_CONSENT}\n`,
        'services/booth/src/consent.ts': `export const CONSENT_TEXT = ${JSON.stringify(GOOD_CONSENT)};\n`,
      });
      expect(rules(root)).toEqual([]);
    });
    it('flags a booth constant that drifted from the UI sentence', () => {
      const root = fixture({ 'services/booth/src/consent.ts': "export const CONSENT_TEXT = 'We will contact you and keep your data on this laptop; ask us to delete it.';\n" });
      expect(scanCopy(root).findings.map((f) => f.file)).toContain('services/booth/src/consent.ts');
    });
    it('reads concatenated and escaped constants', () => {
      expect(extractStringConstant("export const C = 'a \\'b\\' ' +\n  \"c\";", 'C')).toBe("a 'b' c");
    });
  });

  describe('(e) external URLs', () => {
    it('flags a live site in UI source', () => {
      const r = scanCopy(fixture({ 'apps/web/src/kiosk/Link.tsx': "export const a = 'x';\nexport const u = 'https://acme-payments.io/demo';\n" }));
      expect(r.findings.find((f) => f.rule === 'external-url')).toMatchObject({ file: 'apps/web/src/kiosk/Link.tsx', line: 2 });
    });
    it('accepts SVG/XML namespaces, loopback, .test and example domains, and template hosts', () => {
      const root = fixture({
        'apps/web/src/kiosk/Ok.tsx':
          "export const a = 'http://www.w3.org/2000/svg';\nexport const b = 'http://127.0.0.1:7072';\nexport const c = 'http://localhost:5173';\nexport const d = 'https://bank.test/x';\nexport const e = 'https://www.example.com/x';\nexport const f = `http://${'${host}'}:1`;\n",
      });
      expect(rules(root)).toEqual([]);
    });
    it('docs may link out', () => {
      expect(rules(fixture({ 'docs/booth/z.md': 'See https://app.diagrams.net\n' }))).toEqual([]);
    });
  });

  describe('(f) personal contact details', () => {
    it('flags a real-looking email and phone number', () => {
      const root = fixture({
        'docs/booth/contacts.md': 'Ask jane.doe@acmebank.com on +44 20 7946 0958 or (415) 867-5309.\n',
      });
      const f = scanCopy(root).findings.filter((x) => x.rule === 'personal-contact');
      expect(f.length).toBeGreaterThanOrEqual(1);
      expect(f[0]).toMatchObject({ file: 'docs/booth/contacts.md', line: 1 });
    });
    it('accepts fictional addresses and numbers', () => {
      const root = fixture({ 'docs/booth/contacts.md': 'ada@example.com, ops@bank.test, call (415) 555-0123 or 415-555-0100.\n' });
      expect(rules(root)).toEqual([]);
    });
    it('does not mistake ids, dates or amounts for phone numbers', () => {
      const root = fixture({ 'docs/booth/n.md': 'Run 2026-10-30T12:00:00Z paid 1,234,567.89 USD, id 0192837465, port 7070-7079.\n' });
      expect(rules(root)).toEqual([]);
    });
  });

  it('scans the real repository without crashing and reports a stable shape', () => {
    const r = scanCopy(path.resolve(import.meta.dirname, '..', '..'));
    expect(r.summary.files).toBe(r.scanned.length);
    expect(r.scanned.some((f) => f.startsWith('apps/web/src/'))).toBe(true);
    expect(r.scanned.some((f) => f.startsWith('services/assistant/src/'))).toBe(true);
    expect(r.scanned.some((f) => /^services\/orchestrator\/src\/(scenarios|attract)/.test(f))).toBe(true);
  });
});
