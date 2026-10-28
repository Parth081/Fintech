// Provider statements (camt.053) list with an in-console XML viewer.
import { useState } from 'react';
import type { StatementRef } from '../../../lib/types';
import { useApi } from '../../ui/hooks';
import { formatMoney, formatNumber } from '../../lib/format';
import { providerName } from '../../../lib/format';
import { XmlViewer } from '../../../components/XmlViewer';
import { copyToClipboard } from '../../ui/hooks';
import { treasuryApi } from './data';
import { Button, Card, Drawer, EmptyState, ErrorState, LoadingBlock, LoadingRows, toast } from '../risk/kit';

export default function StatementsTab() {
  const list = useApi((s) => treasuryApi.statements(s), [], { intervalMs: 20_000 });
  const [open, setOpen] = useState<StatementRef | null>(null);
  const [provider, setProvider] = useState('');
  const rows = (list.data ?? []).filter((s) => !provider || s.providerId === provider);
  const providers = [...new Set((list.data ?? []).map((s) => s.providerId))].sort();
  return (
    <>
      <Card flush>
        <div className="ct-toolbar">
          <select className="ct-select" aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {providerName(p)}
              </option>
            ))}
          </select>
          <span className="ct-muted ctm-small">End-of-day bank-to-customer statements (ISO 20022 camt.053) reported by each provider, per value date and currency.</span>
        </div>
        {list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={list.refresh} />
        ) : (
          <div className="ct-table-wrap">
            <table className="ct-table ctm-table-dense">
              <thead>
                <tr>
                  <th>Value date</th>
                  <th>Provider</th>
                  <th>Currency</th>
                  <th className="ct-num">Entries</th>
                  <th className="ct-num">Total</th>
                  <th>Statement id</th>
                  <th />
                </tr>
              </thead>
              {list.loading ? (
                <LoadingRows cols={7} />
              ) : rows.length === 0 ? (
                <tbody>
                  <tr>
                    <td colSpan={7}>
                      <EmptyState title="No statements yet" hint="Statements are produced as settled payments are reported by providers." />
                    </td>
                  </tr>
                </tbody>
              ) : (
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.statementId} className="ct-row-link" onClick={() => setOpen(s)}>
                      <td>{s.date}</td>
                      <td>{providerName(s.providerId)}</td>
                      <td>{s.currency}</td>
                      <td className="ct-num">{formatNumber(s.entries)}</td>
                      <td className="ct-num">{formatMoney({ amountMinor: s.totalMinor, currency: s.currency })}</td>
                      <td className="ct-mono">{s.statementId}</td>
                      <td>
                        <Button size="sm" variant="ghost" icon="code">
                          View camt.053
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        )}
      </Card>
      {open && <StatementDrawer s={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function StatementDrawer({ s, onClose }: { s: StatementRef; onClose(): void }) {
  const xml = useApi((sig) => treasuryApi.statementXml(s.providerId, s.date, s.currency, sig), [s.providerId, s.date, s.currency]);
  return (
    <Drawer
      title="camt.053 statement"
      subtitle={`${providerName(s.providerId)} · ${s.date} · ${s.currency} · ${s.entries} entries · ${s.statementId}`}
      onClose={onClose}
      actions={
        xml.data ? (
          <Button
            size="sm"
            icon="copy"
            onClick={() => void copyToClipboard(xml.data!).then((ok) => toast({ tone: ok ? 'ok' : 'bad', title: ok ? 'XML copied' : 'Copy failed' }, 2500))}
          >
            Copy XML
          </Button>
        ) : undefined
      }
    >
      {xml.loading ? <LoadingBlock lines={8} /> : xml.error ? <ErrorState error={xml.error} onRetry={xml.refresh} /> : xml.data ? <XmlViewer xml={xml.data} title="BkToCstmrStmt" /> : null}
    </Drawer>
  );
}
