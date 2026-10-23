// The hero map: static SVG (land, routes, cities, provider hubs) plus a canvas overlay for the moving
// payment dots, drawn every animation frame without React re-rendering.
import { memo, useEffect, useMemo, useRef } from 'react';
import { geoGraticule10, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import worldData from 'world-atlas/countries-110m.json';
import { CORRIDORS, PROVIDERS } from '@ct/contracts/browser';
import { buildRoutes, CORRIDOR_COUNTRY_IDS, ENDPOINTS, HUBS, makeProjection, pathD, pointAt, projector, VIEW_H, VIEW_W, type Place, type Pt, type Route } from './geo';
import { advanceDots, dotAlpha, type Dot, type DotConfig } from './dots';
import { providerColor, type HubStyle, type StageAlert } from './hubstyle';
import type { StageIngest } from './ingest';

// ---- static geometry (computed once per page load) -----------------------------------------
const projection = makeProjection();
const project = projector(projection);
export const ROUTES: ReadonlyMap<string, Route> = buildRoutes(project);

const MAP = (() => {
  const topo = worldData as unknown as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
  const countries = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name?: string }>;
  const path = geoPath(projection);
  const highlighted = new Set(CORRIDOR_COUNTRY_IDS);
  const rest: Feature[] = [];
  const hi: Feature[] = [];
  for (const f of countries.features) (highlighted.has(String(f.id)) ? hi : rest).push(f);
  return {
    land: path({ type: 'FeatureCollection', features: rest }) ?? '',
    highlight: path({ type: 'FeatureCollection', features: hi }) ?? '',
    graticule: path(geoGraticule10()) ?? '',
    sphere: path({ type: 'Sphere' }) ?? '',
  };
})();

const CURRENCY_OF: Record<string, string> = Object.fromEntries(
  CORRIDORS.flatMap((c) => [
    [c.sourceCountry, c.sourceCurrency],
    [c.targetCountry, c.targetCurrency],
  ]),
);

function labelOffset(anchor: Place['anchor'], gap: number): { dx: number; dy: number; textAnchor: 'start' | 'middle' | 'end' } {
  switch (anchor) {
    case 'left':
      return { dx: -gap, dy: 4, textAnchor: 'end' };
    case 'right':
      return { dx: gap, dy: 4, textAnchor: 'start' };
    case 'above':
      return { dx: 0, dy: -gap, textAnchor: 'middle' };
    default:
      return { dx: 0, dy: gap + 10, textAnchor: 'middle' };
  }
}

// ---- static SVG layer --------------------------------------------------------------------------
interface MapSvgProps {
  hubStyles: Readonly<Record<string, HubStyle>>;
  shares: Readonly<Record<string, number>>;
}

const MapSvg = memo(function MapSvg({ hubStyles, shares }: MapSvgProps) {
  return (
    <svg className="ms-map-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="World map of payment corridors and provider hubs">
      <path className="ms-sphere" d={MAP.sphere} />
      <path className="ms-graticule" d={MAP.graticule} />
      <path className="ms-land" d={MAP.land} />
      <path className="ms-land-hi" d={MAP.highlight} />

      <g className="ms-routes">
        {[...ROUTES.values()].map((r) => {
          const style = hubStyles[r.providerId];
          const muted = style?.routesMuted ?? false;
          const share = shares[r.providerId] ?? 0;
          return (
            <path
              key={r.key}
              d={pathD(r.points)}
              className={`ms-route${muted ? ' ms-route-muted' : ''}`}
              style={{ stroke: muted ? undefined : providerColor(r.providerId), strokeWidth: muted ? 1.2 : 1.2 + share * 4.5, opacity: muted ? undefined : 0.3 + share * 0.55 }}
            />
          );
        })}
      </g>

      <g className="ms-endpoints">
        {Object.values(ENDPOINTS).map((pl) => {
          const [x, y] = project(pl.lonLat);
          const o = labelOffset(pl.anchor, 11);
          return (
            <g key={pl.id} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}>
              <circle className="ms-city-ring" r={7.5} />
              <circle className="ms-city" r={4} />
              <text className="ms-city-label" x={o.dx} y={o.dy} textAnchor={o.textAnchor}>
                {pl.city}
                <tspan className="ms-city-ccy"> {CURRENCY_OF[pl.id] ?? ''}</tspan>
              </text>
            </g>
          );
        })}
      </g>

      <g className="ms-hubs">
        {PROVIDERS.map((p) => {
          const hub = HUBS[p.id];
          if (!hub) return null;
          const [x, y] = project(hub.lonLat);
          const st = hubStyles[p.id];
          const tone = st?.tone ?? 'unknown';
          const color = st?.color ?? providerColor(p.id);
          const above = hub.anchor === 'above';
          const nameY = above ? -22 : 36;
          // Name on one side of the hub, status pill on the other, so neither hides the other.
          // CIRCUIT OPEN gets the biggest pill: it has to read from across the aisle.
          const big = tone === 'open';
          const pillH = big ? 36 : 30;
          const pillY = above ? 24 : -(pillH + 26);
          const label = st?.label ?? '';
          const pillW = Math.max(80, label.length * (big ? 15.5 : 12) + 28);
          return (
            <g key={p.id} className={`ms-hub ms-hub-${tone}`} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`} style={{ color }}>
              {st?.alert && <circle className="ms-hub-alert" r={16} />}
              <circle className="ms-hub-halo" r={16} />
              <circle className="ms-hub-core" r={9} />
              {tone === 'open' && <path className="ms-hub-x" d="M-5,-5L5,5M5,-5L-5,5" />}
              <text className="ms-hub-name" y={nameY} textAnchor="middle">
                {p.name.replace(/^Provider\s+/i, '').toUpperCase()}
              </text>
              {label && tone !== 'closed' && (
                <g className={`ms-hub-pill${big ? ' ms-hub-pill-big' : ''}`} transform={`translate(0,${pillY})`}>
                  <rect x={-pillW / 2} y={0} width={pillW} height={pillH} rx={7} />
                  <text y={pillH * 0.71} textAnchor="middle">
                    {label}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
});

// ---- canvas dot layer ----------------------------------------------------------------------------
export interface Palette {
  provider: Record<string, string>;
  text: string;
  bad: string;
  ok: string;
  warn: string;
  halo: string;
}

export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    provider: { orion: v('--ms-orion', '#4cc2ff'), lyra: v('--ms-lyra', '#b98cff'), vega: v('--ms-vega', '#2ee6c9') },
    text: v('--text', '#e8edf7'),
    bad: v('--bad', '#ff5d6c'),
    ok: v('--ok', '#3ddc97'),
    warn: v('--warn', '#ffb547'),
    halo: v('--bg', '#0a0f1c'),
  };
}

const TAIL = 0.035;
const DOT_R = 3.6;

function drawDot(ctx: CanvasRenderingContext2D, d: Dot, route: Route, pal: Palette, cfg: DotConfig): void {
  const a = dotAlpha(d, cfg);
  if (a <= 0) return;
  const pos = pointAt(route, d.p);
  const color = d.phase === 'failing' ? pal.bad : (pal.provider[d.providerId] ?? pal.ok);
  ctx.globalAlpha = a;
  if (d.phase === 'landed') {
    // delivery flash: green ring growing at the destination
    const k = Math.min(1, d.phaseMs / cfg.flashMs);
    ctx.strokeStyle = pal.ok;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], DOT_R + k * 12, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (d.phase === 'failing' && d.p >= d.stopAt) {
    // rejected at the provider: red burst
    const k = Math.min(1, d.phaseMs / cfg.failMs);
    ctx.strokeStyle = pal.bad;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], DOT_R + 2 + k * 14, 0, Math.PI * 2);
    ctx.stroke();
  } else if (d.phase !== 'fading' && d.p > 0.005) {
    const tail: Pt = pointAt(route, Math.max(0, d.p - TAIL));
    const grad = ctx.createLinearGradient(tail[0], tail[1], pos[0], pos[1]);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, color);
    ctx.strokeStyle = grad;
    ctx.lineWidth = DOT_R * 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tail[0], tail[1]);
    ctx.lineTo(pos[0], pos[1]);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pos[0], pos[1], d.phase === 'failing' ? DOT_R * 1.25 : DOT_R, 0, Math.PI * 2);
  ctx.fill();
  if (d.probe && d.phase === 'flying') {
    ctx.strokeStyle = pal.warn;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], DOT_R + 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Draw every dot (canvas already transformed to viewBox units). `focusId` gets a highlight ring. */
export function drawDots(ctx: CanvasRenderingContext2D, dots: readonly Dot[], pal: Palette, cfg: DotConfig, focusId: string | null = null): void {
  for (const d of dots) {
    const route = ROUTES.get(d.routeKey);
    if (!route) continue;
    drawDot(ctx, d, route, pal, cfg);
    if (focusId !== null && d.paymentId === focusId && d.phase !== 'fading') {
      const pos = pointAt(route, d.p);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos[0], pos[1], DOT_R + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function DotCanvas({ ingest, config, focusId }: { ingest: StageIngest; config: DotConfig; focusId: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let pal = readPalette(canvas);
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    const onScheme = () => {
      pal = readPalette(canvas);
    };
    mq?.addEventListener('change', onScheme);

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // Cap the backing store at ~4K so a high-DPI laptop driving a 4K screen stays smooth.
      dpr = Math.min(window.devicePixelRatio || 1, 2, 3840 / Math.max(1, rect.width));
      w = Math.max(1, Math.round(rect.width * dpr));
      h = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = w;
      canvas.height = h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsSince = last;
    let workMs = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const started = performance.now();
      const cfg = cfgRef.current;
      advanceDots(ingest.engine, now - last, cfg);
      last = now;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const s = Math.min(w / VIEW_W, h / VIEW_H);
      ctx.setTransform(s, 0, 0, s, (w - VIEW_W * s) / 2, (h - VIEW_H * s) / 2);
      drawDots(ctx, ingest.engine.dots, pal, cfg, focusRef.current);
      workMs += performance.now() - started;
      frames++;
      if (now - fpsSince >= 1000) {
        canvas.dataset.fps = String(Math.round((frames * 1000) / (now - fpsSince)));
        canvas.dataset.dots = String(ingest.engine.dots.length);
        // Diagnostics for performance checks: mean JS time per frame spent on dots.
        canvas.dataset.frameMs = (workMs / Math.max(1, frames)).toFixed(2);
        workMs = 0;
        frames = 0;
        fpsSince = now;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq?.removeEventListener('change', onScheme);
    };
  }, [ingest]);

  return <canvas ref={ref} className="ms-map-canvas" aria-hidden="true" />;
}

export interface WorldMapProps extends MapSvgProps {
  ingest: StageIngest;
  config: DotConfig;
  /** The one thing the map shouts (breaker open, failing, probing, recovered). */
  alert: StageAlert | null;
  /** Payment the presenter is explaining: its dot gets a ring and a small callout. */
  focusId: string | null;
}

export function WorldMap({ hubStyles, shares, ingest, config, alert, focusId }: WorldMapProps) {
  const legend = useMemo(
    () =>
      PROVIDERS.map((p) => (
        <span key={p.id} className="ms-legend-item">
          <i style={{ background: providerColor(p.id) }} />
          {p.name.replace(/^Provider\s+/i, '')}
        </span>
      )),
    [],
  );
  return (
    <div className="ms-map">
      <MapSvg hubStyles={hubStyles} shares={shares} />
      <DotCanvas ingest={ingest} config={config} focusId={focusId} />
      {alert && (
        <div key={`${alert.providerId}:${alert.tone}`} className={`ms-alert ms-alert-${alert.tone}`} role="status" aria-live="assertive">
          <span className="ms-alert-head">{alert.headline}</span>
          <span className="ms-alert-sub">{alert.sub}</span>
        </div>
      )}
      {focusId && (
        <div className="ms-focus" role="status">
          Presenter is explaining payment <b>{focusId}</b>
        </div>
      )}
      <div className="ms-legend" aria-label="Map legend">
        {legend}
        <span className="ms-legend-item">
          <i className="ms-legend-ok" />
          Settled
        </span>
        <span className="ms-legend-item">
          <i className="ms-legend-bad" />
          Rejected
        </span>
      </div>
    </div>
  );
}
