import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveFeed } from './hooks/useLiveFeed';
import { useNow } from './hooks/useNow';
import { Header } from './components/Header';
import { PipelineStrip } from './components/PipelineStrip';
import { Controls } from './components/Controls';
import { KpiRow } from './components/KpiRow';
import { PaymentsTable } from './components/PaymentsTable';
import { DetailDrawer } from './components/DetailDrawer';

export function App() {
  const { feed, connection } = useLiveFeed();
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const lastSeq = useRef(0);

  // Refresh the open drawer whenever its payment changes.
  useEffect(() => {
    const lc = feed.lastChanged;
    if (lc && lc.seq !== lastSeq.current) {
      lastSeq.current = lc.seq;
      if (lc.paymentId === selected) setVersion((v) => v + 1);
    }
  }, [feed.lastChanged, selected]);

  const close = useCallback(() => setSelected(null), []);

  return (
    <div className="app">
      <Header connection={connection} />
      <main className="main">
        <PipelineStrip stats={feed.stats} pulses={feed.pulses} />
        <div className="bar">
          <Controls />
          <KpiRow stats={feed.stats} />
        </div>
        <PaymentsTable
          payments={feed.payments}
          now={now}
          lastChanged={feed.lastChanged}
          selectedId={selected}
          onSelect={setSelected}
        />
      </main>
      {selected && <DetailDrawer paymentId={selected} version={version} onClose={close} />}
    </div>
  );
}
