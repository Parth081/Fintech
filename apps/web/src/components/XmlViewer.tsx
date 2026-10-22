import { useMemo, useState } from 'react';
import { highlightXmlLine, prettyXml } from '../lib/xml';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (e.g. http on a LAN address).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function XmlViewer({ xml, title }: { xml: string; title?: string }) {
  const pretty = useMemo(() => prettyXml(xml), [xml]);
  const lines = useMemo(() => pretty.split('\n').map(highlightXmlLine), [pretty]);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  return (
    <div className="xml">
      <div className="xml-head">
        {title && <span className="xml-title">{title}</span>}
        <button
          type="button"
          className="btn btn-small"
          onClick={() =>
            void copyText(pretty).then((ok) => {
              setCopied(ok ? 'ok' : 'fail');
              window.setTimeout(() => setCopied(null), 1500);
            })
          }
        >
          {copied === 'ok' ? 'Copied ✓' : copied === 'fail' ? 'Copy failed' : 'Copy XML'}
        </button>
      </div>
      <pre className="xml-body mono">
        {lines.map((toks, i) => (
          <div key={i} className="xml-line">
            {toks.map((t, j) => (
              <span key={j} className={`x-${t.kind}`}>
                {t.text}
              </span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}
