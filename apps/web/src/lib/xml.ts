// Tiny XML pretty-printer and highlighter for ISO 20022 messages (no DOM, no dependencies).

export type XmlTokenKind = 'punct' | 'tag' | 'attr' | 'value' | 'text' | 'decl';
export interface XmlToken {
  kind: XmlTokenKind;
  text: string;
}

const PART = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;

/** Indent an XML string, one element per line; leaf elements stay on one line. */
export function prettyXml(xml: string, indent = '  '): string {
  const parts = (xml.match(PART) ?? []).map((p) => (p.startsWith('<') ? p : p.trim())).filter((p) => p !== '');
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const pad = indent.repeat(Math.max(0, depth));
    if (p.startsWith('</')) {
      depth -= 1;
      lines.push(indent.repeat(Math.max(0, depth)) + p);
    } else if (p.startsWith('<?') || p.startsWith('<!')) {
      lines.push(pad + p);
    } else if (p.startsWith('<')) {
      const selfClosing = p.endsWith('/>');
      const text = parts[i + 1];
      const close = parts[i + 2];
      if (!selfClosing && text !== undefined && !text.startsWith('<') && close?.startsWith('</')) {
        lines.push(pad + p + text + close);
        i += 2;
      } else if (!selfClosing && text?.startsWith('</')) {
        lines.push(pad + p + text);
        i += 1;
      } else {
        lines.push(pad + p);
        if (!selfClosing) depth += 1;
      }
    } else {
      lines.push(pad + p);
    }
  }
  return lines.join('\n');
}

const ATTR = /([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')?/g;

function tagTokens(tag: string, out: XmlToken[]): void {
  if (tag.startsWith('<?') || tag.startsWith('<!')) {
    out.push({ kind: 'decl', text: tag });
    return;
  }
  const m = /^<(\/?)([^\s/>]+)([\s\S]*?)(\/?>)$/.exec(tag);
  if (!m) {
    out.push({ kind: 'text', text: tag });
    return;
  }
  out.push({ kind: 'punct', text: `<${m[1]}` });
  out.push({ kind: 'tag', text: m[2]! });
  const rest = m[3]!;
  let last = 0;
  for (const a of rest.matchAll(ATTR)) {
    if (a.index! > last) out.push({ kind: 'text', text: rest.slice(last, a.index) });
    out.push({ kind: 'attr', text: a[1]! });
    out.push({ kind: 'punct', text: a[2]! });
    if (a[3]) out.push({ kind: 'value', text: a[3] });
    last = a.index! + a[0].length;
  }
  if (last < rest.length) out.push({ kind: 'text', text: rest.slice(last) });
  out.push({ kind: 'punct', text: m[4]! });
}

/** Tokens for one line of (pretty-printed) XML. Concatenating token texts gives the line back. */
export function highlightXmlLine(line: string): XmlToken[] {
  const out: XmlToken[] = [];
  const lead = /^\s*/.exec(line)![0];
  if (lead) out.push({ kind: 'text', text: lead });
  for (const p of line.slice(lead.length).match(PART) ?? []) {
    if (p.startsWith('<')) tagTokens(p, out);
    else out.push({ kind: 'text', text: p });
  }
  return out;
}

/** Value of the first element with this local name (namespace prefixes ignored), e.g. "TxSts". */
export function xmlValue(xml: string, localName: string): string | null {
  const name = localName.replace(/[^\w.-]/g, '');
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</`).exec(xml);
  return m ? m[1]!.trim() : null;
}
