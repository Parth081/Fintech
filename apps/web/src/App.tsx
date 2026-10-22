import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveFeed } from './hooks/useLiveFeed';
import { useNow } from './hooks/useNow';
import { useHashRoute } from './hooks/useHashRoute';
import { Header } from './components/Header';
import { PipelineStrip } from './components/PipelineStrip';
import { Controls } from './components/Controls';
import { KpiRow } from './components/KpiRow';
import { PaymentsTable } from './components/PaymentsTable';
import { DetailDrawer } from './components/DetailDrawer';
import { LedgerView } from './components/LedgerView';
import { FxView } from './components/FxView';
import { ProvidersView } from './components/ProvidersView';

export function App() {
  const { feed, connection } = useLiveFeed();
  const view = useHashRoute();
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const lastSeq = useRef(0);

  // Refresh the open drawer whenever its payment changes.
  useEffect(() => {
    if (feed.seq !== lastSeq.current) {
      lastSeq.current = feed.seq;
      if (selected && feed.lastBatch.includes(selected)) setVersion((v) => v + 1);
    }
  }, [feed.seq, feed.lastBatch, selected]);

  const close = useCallback(() => setSelected(null), []);

  return (
    <div className="app">
      <Header connection={connection} view={view} />
      <main className="main">
        {view === 'live' && (
          <>
            <PipelineStrip stats={feed.stats} pulses={feed.pulses} />
            <div className="bar">
              <Controls />
              <KpiRow stats={feed.stats} />
            </div>
            <PaymentsTable
              livePayments={feed.payments}
              liveTotal={feed.stats?.total ?? feed.payments.length}
              now={now}
              lastChanged={feed.lastChanged}
              selectedId={selected}
              onSelect={setSelected}
            />
          </>
        )}
        {view === 'ledger' && <LedgerView />}
        {view === 'fx' && <FxView />}
        {view === 'providers' && <ProvidersView />}
      </main>
      {selected && view === 'live' && <DetailDrawer paymentId={selected} version={version} onClose={close} />}
    </div>
  );
}
