// Main stage: the big-screen booth view. Self-contained (no props needed): opens its own live feed
// (payments + control pushes + reset/focus notices), polls the control state every second as a
// fallback, and polls the ledger trial balance. Every panel degrades on its own: an endpoint that is
// down or 404 hides that panel (or its status), it never blanks or crashes the stage.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, type ProviderOutage } from '@ct/contracts/browser';
import { usePoll } from '../hooks/usePoll';
import { fetchTrialBalance } from '../lib/api';
import { bannerFor } from '../lib/control';
import { PipelineStrip } from '../components/PipelineStrip';
import type { ConnectionStatus, ServerMessage, Stats } from '../lib/types';
import { DEFAULT_DOT_CONFIG, REDUCED_DOT_CONFIG } from './dots';
import { breakerMap, hubStyle, providerColor, stageAlert, type HubStyle } from './hubstyle';
import { StageIngest, type FeedMessage } from './ingest';
import { pickCounts, percentLabels, sharesOf, totalOf, type Share } from './traffic';
import { fetchStageControl, newerControl, NO_CONTROL, type StageControl } from './data';
import { kpiTiles, ledgerBadge } from './panels';
import type { StageResetState } from './reset';
import { usePrefersReducedMotion, useStageFeed } from './useStageFeed';
import { ROUTES, WorldMap } from './WorldMap';
import { parseAttract, showCta, storyCard, touchAttract, type StoryCard } from '../attract/attract';
import { KIOSK_AVAILABLE, KIOSK_HASH } from '../attract/kiosk';
import { AskPanel } from '../assistant/AskPanel';
import type { SuggestedQuestion } from '@ct/contracts/browser';
import { StoryCaption, TouchCta } from './AttractStory';
import './stage.css';

const PROVIDER_IDS = PROVIDERS.map((p) => p.id);
const shortName = (name: string) => name.replace(/^Provider\s+/i, '');
const SHORT_PROVIDERS = PROVIDERS.map((p) => ({ id: p.id, name: shortName(p.name) }));
/** Map line weights follow the last few seconds, so a re-route shows up right away. */
const NOW_WINDOW_MS = 15_000;
/** A presenter focus callout disappears on its own after this long. */
const FOCUS_MS = 20_000;
/** Attract-loop beats where the side panel shows the AI "Explained" card instead of provider health. */
const EXPLAINED_BEATS = new Set(['recovered', 'ledger', 'invite']);
const SCENARIO_CONTEXT = { kind: 'scenario' } as const;
/** The "Explained" card asks the outage-story question if the assistant offers one, else its first suggestion. */
const pickStoryQuestion = (qs: SuggestedQuestion[]) => (qs.find((q) => q.intent === 'outage_story') ?? qs[0])?.text ?? null;

function toFeedMessage(m: ServerMessage): FeedMessage {
  if (m.kind === 'snapshot') return { kind: 'snapshot', payments: m.payments };
  if (m.kind === 'update') return { kind: 'update', payments: m.payments, events: m.events };
  return { kind: 'stats' };
}

interface Tick {
  /** Local clock. */
  now: number;
  /** Last-minute share per provider (panel). */
  panel: Share[];
  /** Recent share per provider (map line weights). */
  map: Record<string, number>;
}

export interface MainStageProps {
  /** Fill the parent element instead of the whole viewport. */
  embedded?: boolean;
}

export function MainStage({ embedded = false }: MainStageProps = {}) {
  const reduced = usePrefersReducedMotion();
  const config = reduced ? REDUCED_DOT_CONFIG : DEFAULT_DOT_CONFIG;

  // ---- control plane: WS pushes and a 1 s poll; the newer view (gateway clock) wins ----------
  const [ctlState, setCtl] = useState<StageControl | null>(null);
  const skewRef = useRef(0); // gateway clock - local clock
  const takeControl = useCallback((v: StageControl | null) => {
    if (!v) return;
    if (v.atMs > 0) skewRef.current = v.atMs - Date.now();
    setCtl((prev) => newerControl(prev, v));
  }, []);
  const polled = usePoll<StageControl>(fetchStageControl, 1000);
  useEffect(() => takeControl(polled.data), [polled.data, takeControl]);
  const ctl = ctlState ?? NO_CONTROL;
  const breakers = useMemo(() => breakerMap(ctl.breakers), [ctl.breakers]);

  // ---- payments -> dots + local traffic (mutable, outside React state) -----------------------
  const ingestRef = useRef<StageIngest | null>(null);
  if (!ingestRef.current) ingestRef.current = new StageIngest({ routes: ROUTES, config });
  const ingest = ingestRef.current;
  ingest.config = config;
  ingest.isProbe = (pid) => breakers.get(pid)?.state === 'half-open';

  const { feed, connection, reset, focus } = useStageFeed({
    onMessages: (msgs) => {
      const now = Date.now();
      for (const m of msgs) ingest.apply(toFeedMessage(m), now);
    },
    onControl: takeControl,
    onReset: () => {
      ingest.reset();
      setCtl(null);
    },
  });
  // Back from a reset: anything the old gateway sent in its last moments goes too.
  useEffect(() => {
    if (reset.phase === 'back') ingest.reset();
  }, [reset.phase, ingest]);

  // ---- once a second: traffic shares and the clock (RECOVERED fades on time) -----------------
  const serverTraffic = ctl.traffic;
  const computeTick = useCallback((): Tick => {
    const now = Date.now();
    const local = ingest.traffic.counts(now);
    const panelCounts = pickCounts(serverTraffic, local);
    const recent = ingest.traffic.counts(now, NOW_WINDOW_MS);
    const mapCounts = totalOf(recent) > 0 ? recent : panelCounts;
    const map = Object.fromEntries(sharesOf(mapCounts, PROVIDER_IDS).map((s) => [s.key, s.share]));
    return { now, panel: sharesOf(panelCounts, PROVIDER_IDS), map };
  }, [ingest, serverTraffic]);
  const [tick, setTick] = useState<Tick>(computeTick);
  useEffect(() => {
    setTick(computeTick());
    const t = window.setInterval(() => setTick(computeTick()), 1000);
    return () => window.clearInterval(t);
  }, [computeTick]);

  const outages = ctl.control.outages as Readonly<Record<string, ProviderOutage>>;
  const gatewayNow = tick.now + skewRef.current;
  const hubStyles = useMemo(() => {
    const out: Record<string, HubStyle> = {};
    for (const id of PROVIDER_IDS) out[id] = hubStyle(id, breakers.get(id), outages[id], gatewayNow);
    return out;
  }, [breakers, outages, gatewayNow]);
  const alert = useMemo(() => stageAlert(hubStyles, SHORT_PROVIDERS, tick.map), [hubStyles, tick.map]);

  // ---- presenter focus: ring on the payment's dot + a small callout, for a while -------------
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    setFocusId(focus.paymentId);
    if (focus.paymentId === null) return;
    const t = window.setTimeout(() => setFocusId(null), FOCUS_MS);
    return () => window.clearTimeout(t);
  }, [focus]);

  const ledger = usePoll(fetchTrialBalance, 2000);
  const refreshLedger = ledger.refresh;
  useEffect(() => {
    if (reset.phase === 'back') refreshLedger();
  }, [reset.phase, refreshLedger]);
  const badge = ledgerBadge(ledger.data);

  // ---- M5 attract loop: story card, call to action, "Explained" card ------------------------
  const attract = useMemo(() => parseAttract(ctl.orchestrator), [ctl.orchestrator]);
  const story = reset.phase === 'idle' ? storyCard(ctl.control, attract) : null;
  const explained = story !== null && EXPLAINED_BEATS.has(story.stepId);
  // Someone touched the big screen: stop the loop and, when this build has one, open the kiosk.
  const onTouch = useCallback(() => {
    void touchAttract();
    if (KIOSK_AVAILABLE) window.location.hash = KIOSK_HASH;
  }, []);

  return (
    <div
      className={`ms-root${embedded ? ' ms-embedded' : ''}${reset.phase === 'resetting' ? ' ms-is-resetting' : ''}${story ? ' ms-attract' : ''}`}
      onPointerDown={story ? onTouch : undefined}
    >
      <StageHeader connection={connection} control={ctlState} story={story} />
      <div className="ms-hero">
        <WorldMap hubStyles={hubStyles} shares={tick.map} ingest={ingest} config={config} alert={reset.phase === 'idle' ? alert : null} focusId={focusId} />
        {showCta(story) && <TouchCta strong={story?.tone === 'invite'} />}
      </div>
      <aside className="ms-side">
        <StageKpis stats={feed.stats} badge={badge} />
        {explained ? (
          <AskPanel
            className="ms-explained"
            variant="stage"
            title="Explained"
            subtitle="What just happened, from the record"
            context={SCENARIO_CONTEXT}
            maxChips={0}
            autoAsk={pickStoryQuestion}
          />
        ) : (
          <ProviderPanel shares={tick.panel} hubStyles={hubStyles} hasBreakers={ctl.available && ctl.breakers.length > 0} />
        )}
      </aside>
      <div className="ms-pipe">
        <PipelineStrip stats={feed.stats} pulses={feed.pulses} />
      </div>
      <ResetVeil reset={reset} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
const CONN_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  polling: 'Polling',
  offline: 'Offline',
};

function StageHeader({ connection, control, story }: { connection: ConnectionStatus; control: StageControl | null; story: StoryCard | null }) {
  // Audience caption: scenario title + current step title (never the presenter narration).
  const banner = bannerFor(control);
  const paused = control?.orchestrator?.paused ?? control?.control.paused ?? false;
  return (
    <header className="ms-head">
      <div className="ms-brand">
        <h1>Global Fintech Control Tower</h1>
        <span className="ms-brand-sub">Cross-border payments · US→IN · DE→BR · GB→PH</span>
      </div>
      {story ? (
        <StoryCaption card={story} />
      ) : (
      <div className={`ms-caption${banner ? ' ms-caption-active' : ''}`} aria-live="polite">
        {banner ? (
          <>
            <span className="ms-caption-scenario">
              Scenario · {banner.title}
              {paused && <span className="ms-caption-paused">Paused</span>}
            </span>
            <span key={banner.step ?? 'start'} className="ms-caption-step">
              {banner.step ?? 'Starting…'}
            </span>
          </>
        ) : (
          <>
            <span className="ms-caption-scenario">Live traffic</span>
            <span className="ms-caption-step">Payments flowing across three corridors</span>
          </>
        )}
      </div>
      )}
      <div className="ms-head-right">
        <span className={`ms-conn ms-conn-${connection}`}>
          <i aria-hidden="true" />
          {CONN_LABEL[connection]}
        </span>
        <span className="ms-sim">SIMULATION · SYNTHETIC DATA</span>
      </div>
    </header>
  );
}

function StageKpis({ stats, badge }: { stats: Stats | null; badge: ReturnType<typeof ledgerBadge> }) {
  return (
    <section className="ms-kpis" aria-label="Key figures">
      {badge && (
        <div className={`ms-ledger ms-ledger-${badge.tone}`}>
          <span className="ms-ledger-mark" aria-hidden="true">
            {badge.mark}
          </span>
          <span className="ms-ledger-text">
            <span className="ms-ledger-title">{badge.title}</span>
            <span className="ms-ledger-sub">{badge.sub}</span>
          </span>
        </div>
      )}
      {kpiTiles(stats).map((t) => (
        <div key={t.key} className={`ms-kpi${t.tone ? ` ms-kpi-${t.tone}` : ''}`}>
          <span className="ms-kpi-value">{t.value}</span>
          <span className="ms-kpi-label">{t.label}</span>
        </div>
      ))}
    </section>
  );
}

function ProviderPanel({ shares, hubStyles, hasBreakers }: { shares: Share[]; hubStyles: Record<string, HubStyle>; hasBreakers: boolean }) {
  const labels = percentLabels(shares);
  return (
    <section className="ms-providers" aria-label="Provider health">
      <h2 className="ms-panel-title">
        Providers <span>share of traffic · last minute</span>
      </h2>
      {PROVIDERS.map((p, i) => {
        const s = shares[i];
        const st = hubStyles[p.id];
        const tone = st?.tone ?? 'unknown';
        return (
          <div key={p.id} className={`ms-prov ms-prov-${tone}`}>
            <div className="ms-prov-head">
              <i className="ms-prov-swatch" style={{ background: providerColor(p.id) }} aria-hidden="true" />
              <span className="ms-prov-name">{shortName(p.name)}</span>
              {st?.label && (
                <span className="ms-prov-state" style={{ color: st.color }}>
                  {st.label}
                </span>
              )}
              <span className="ms-prov-pct">{labels[i]}</span>
            </div>
            <div className="ms-prov-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((s?.share ?? 0) * 100)}%`, background: tone === 'open' ? 'var(--text-dim)' : providerColor(p.id) }} />
            </div>
            <div className="ms-prov-detail">{st?.detail || (hasBreakers ? '' : p.rail)}</div>
          </div>
        );
      })}
    </section>
  );
}

function ResetVeil({ reset }: { reset: StageResetState }) {
  if (reset.phase === 'idle') return null;
  const resetting = reset.phase === 'resetting';
  return (
    <div className={`ms-veil${resetting ? '' : ' ms-veil-back'}`} role="status" aria-live="polite">
      <div className="ms-veil-box">
        {resetting && <div className="ms-veil-spinner" aria-hidden="true" />}
        <h2>{resetting ? 'Resetting the demo…' : 'Ready · fresh demo'}</h2>
        <p>{resetting ? 'Fresh, empty, balanced ledger in a few seconds.' : 'New payments are starting to flow.'}</p>
      </div>
    </div>
  );
}
