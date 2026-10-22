import { useEffect } from 'react';
import { fetchStatementXml } from '../lib/api';
import { providerName } from '../lib/format';
import { usePoll } from '../hooks/usePoll';
import { XmlViewer } from './XmlViewer';

interface Props {
  providerId: string;
  date: string;
  currency?: string;
  onClose(): void;
}

export function StatementViewer({ providerId, date, currency, onClose }: Props) {
  const xml = usePoll((signal) => fetchStatementXml(providerId, date, currency, signal), 0, `${providerId}|${date}|${currency ?? ''}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="camt.053 statement">
        <div className="drawer-head">
          <div>
            <h2>camt.053 statement</h2>
            <div className="mono drawer-id">
              {providerName(providerId)} · {date}
              {currency ? ` · ${currency}` : ''}
            </div>
          </div>
          <button type="button" className="btn btn-close" onClick={onClose} aria-label="Close statement">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          {xml.error && <p className="msg-error">⚠ {xml.error}</p>}
          {!xml.data && !xml.error && <p className="empty">Loading…</p>}
          {xml.data && <XmlViewer xml={xml.data} title="BkToCstmrStmt" />}
        </div>
      </aside>
    </>
  );
}
