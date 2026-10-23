import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
import { PresenterConsole } from './components/PresenterConsole';
import { ResetNotice, ScenarioBanner } from './components/ScenarioBanner';
import { hashFor, NAV_VIEWS } from './lib/route';

// The world-map main stage (owned by apps/web/src/stage) loads on demand: the other views stay light.
const MainStage = lazy(() => import('./stage/MainStage').then((m) => ({ default: m.MainStage })));

export function App() {
  const live = useLiveFeed();
  const { feed, connection, control } = live;
  const view = useHashRoute('stage');
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const lastSeq = useRef(0);
  const lastFocus = useRef(0);

  // Refresh the open drawer whenever its payment changes.
  useEffect(() => {
    if (feed.seq !== lastSeq.current) {
      lastSeq.current = feed.seq;
      if (selected && feed.lastBatch.includes(selected)) setVersion((v) => v + 1);
    }
  }, [feed.seq, feed.lastBatch, selected]);

  // The presenter's "Jump to explanation" opens (or closes) the drawer on every audience screen.
  useEffect(() => {
    if (!live.focus || live.focus.seq === lastFocus.current) return;
    lastFocus.current = live.focus.seq;
    if (view === 'presenter') return; // the console opens its own drawer
    setSelected(live.focus.paymentId);
  }, [live.focus, view]);

  // Audience keyboard shortcuts: 1..5 switch views (handy on the big screen).
  useEffect(() => {
    if (view === 'presenter') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const i = Number.parseInt(e.key, 10);
      const target = Number.isFinite(i) ? NAV_VIEWS[i - 1] : undefined;
      if (target) window.location.hash = hashFor(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  const close = useCallback(() => setSelected(null), []);
  const resetOverlay = live.resetNotice && view !== 'presenter' ? <ResetNotice startedAt={live.resetNotice.startedAt} now={now} /> : null;
  const drawer = selected ? <DetailDrawer paymentId={selected} version={version} onClose={close} /> : null;

  if (view === 'presenter') {
    return (
      <>
        <PresenterConsole live={live} onOpenPayment={setSelected} />
        {drawer}
      </>
    );
  }

  if (view === 'stage') {
    return (
      <>
        <Suspense fallback={<div className="stage-loading">Loading the main stage…</div>}>
          <MainStage />
        </Suspense>
        {drawer}
        {resetOverlay}
      </>
    );
  }

  return (
    <div className="app">
      <Header connection={connection} view={view} />
      <ScenarioBanner view={control?.view ?? null} />
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
        {view === 'providers' && <ProvidersView control={control?.view ?? null} />}
      </main>
      {drawer}
      {resetOverlay}
    </div>
  );
}
