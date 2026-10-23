// Map geometry for the main stage: where the corridor endpoints and provider hubs sit, and the
// great-circle routes (source -> provider hub -> target) that payment dots travel along.
// Pure: no DOM. Coordinates are [longitude, latitude]; projected points are in viewBox units.
import { geoEqualEarth, geoInterpolate, type GeoProjection } from 'd3-geo';
import { CORRIDORS, PROVIDERS } from '@ct/contracts/browser';

export type LonLat = readonly [number, number];
export type Pt = readonly [number, number];

export interface Place {
  id: string;
  /** City shown on the map. */
  city: string;
  lonLat: LonLat;
  /** Label placement relative to the marker. */
  anchor: 'left' | 'right' | 'above' | 'below';
}

/** One city per corridor endpoint (ISO 3166-1 alpha-2 country -> financial centre). */
export const ENDPOINTS: Readonly<Record<string, Place>> = {
  US: { id: 'US', city: 'New York', lonLat: [-74.0, 40.71], anchor: 'left' },
  DE: { id: 'DE', city: 'Frankfurt', lonLat: [8.68, 50.11], anchor: 'above' },
  GB: { id: 'GB', city: 'London', lonLat: [-0.13, 51.51], anchor: 'left' },
  IN: { id: 'IN', city: 'Mumbai', lonLat: [72.88, 19.08], anchor: 'below' },
  BR: { id: 'BR', city: 'São Paulo', lonLat: [-46.63, -23.55], anchor: 'left' },
  PH: { id: 'PH', city: 'Manila', lonLat: [120.98, 14.6], anchor: 'below' },
};

/** Fictional provider processing hubs, spread out so each provider's routes are distinct on the map. */
export const HUBS: Readonly<Record<string, Place>> = {
  orion: { id: 'orion', city: 'Istanbul', lonLat: [28.98, 41.01], anchor: 'above' },
  lyra: { id: 'lyra', city: 'Dubai', lonLat: [55.27, 25.2], anchor: 'above' },
  vega: { id: 'vega', city: 'Lagos', lonLat: [3.38, 6.52], anchor: 'below' },
};

/** ISO 3166-1 numeric ids (world-atlas feature ids) of the corridor countries. */
export const CORRIDOR_COUNTRY_IDS: readonly string[] = ['840', '276', '826', '356', '076', '608'];

/** Area of the world the stage shows (lon/lat corners); everything relevant fits with some margin. */
export const VIEW_BOUNDS: readonly LonLat[] = [
  [-100, 58],
  [145, 58],
  [-100, -38],
  [145, -38],
];

export const VIEW_W = 1000;
export const VIEW_H = 560;

export function makeProjection(width = VIEW_W, height = VIEW_H, pad = 24): GeoProjection {
  return geoEqualEarth()
    .precision(0.2)
    .fitExtent(
      [
        [pad, pad],
        [width - pad, height - pad],
      ],
      { type: 'MultiPoint', coordinates: VIEW_BOUNDS.map((p) => [p[0], p[1]]) },
    );
}

export type Projector = (lonLat: LonLat) => Pt;

export function projector(projection: GeoProjection): Projector {
  return (ll) => {
    const p = projection([ll[0], ll[1]]);
    return p ? [p[0], p[1]] : [Number.NaN, Number.NaN];
  };
}

/** Sample the great circle between two places (inclusive of both ends). */
export function greatCircle(a: LonLat, b: LonLat, samples = 48): LonLat[] {
  const interp = geoInterpolate([a[0], a[1]], [b[0], b[1]]);
  const out: LonLat[] = [];
  for (let i = 0; i <= samples; i++) {
    const p = interp(i / samples);
    out.push([p[0], p[1]]);
  }
  return out;
}

export interface Route {
  key: string; // `${corridorId}:${providerId}`
  corridorId: string;
  providerId: string;
  points: Pt[];
  /** cum[i] = path length from points[0] to points[i]. */
  cum: number[];
  length: number;
  /** Fraction of the route at which the provider hub sits. */
  hubT: number;
}

export function routeKey(corridorId: string, providerId: string): string {
  return `${corridorId}:${providerId}`;
}

function cumulative(points: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Pt;
    const b = points[i] as Pt;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return cum;
}

/** Route source -> hub -> target as one projected polyline. */
export function buildRoute(corridorId: string, providerId: string, src: LonLat, hub: LonLat, dst: LonLat, project: Projector, samples = 48): Route {
  const leg1 = greatCircle(src, hub, samples).map(project);
  const leg2 = greatCircle(hub, dst, samples).map(project).slice(1);
  const points = [...leg1, ...leg2];
  const cum = cumulative(points);
  const length = cum[cum.length - 1] ?? 0;
  const hubLen = cum[leg1.length - 1] ?? 0;
  return { key: routeKey(corridorId, providerId), corridorId, providerId, points, cum, length, hubT: length > 0 ? hubLen / length : 0 };
}

/** Every (corridor, provider) route the catalogue allows. */
export function buildRoutes(project: Projector): Map<string, Route> {
  const routes = new Map<string, Route>();
  for (const c of CORRIDORS) {
    const src = ENDPOINTS[c.sourceCountry];
    const dst = ENDPOINTS[c.targetCountry];
    if (!src || !dst) continue;
    for (const p of PROVIDERS) {
      const hub = HUBS[p.id];
      if (!hub || !p.corridors.includes(c.id)) continue;
      const r = buildRoute(c.id, p.id, src.lonLat, hub.lonLat, dst.lonLat, project);
      routes.set(r.key, r);
    }
  }
  return routes;
}

/** Point at fraction t (0..1, by length) along the route. */
export function pointAt(route: Route, t: number): Pt {
  const { points, cum, length } = route;
  const first = points[0];
  if (!first) return [Number.NaN, Number.NaN];
  if (!(t > 0) || length === 0) return first;
  if (t >= 1) return points[points.length - 1] as Pt;
  const target = t * length;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) <= target) lo = mid;
    else hi = mid;
  }
  const a = points[lo] as Pt;
  const b = points[hi] as Pt;
  const seg = (cum[hi] as number) - (cum[lo] as number);
  const f = seg > 0 ? (target - (cum[lo] as number)) / seg : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** SVG path data for a polyline (rounded to 0.1 units to keep strings small). */
export function pathD(points: readonly Pt[]): string {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Pt;
    d += `${i === 0 ? 'M' : 'L'}${Math.round(p[0] * 10) / 10},${Math.round(p[1] * 10) / 10}`;
  }
  return d;
}

/** Endpoint places of a corridor id like "US-IN". */
export function corridorPlaces(corridorId: string): { src: Place; dst: Place } | null {
  const c = CORRIDORS.find((x) => x.id === corridorId);
  const src = c ? ENDPOINTS[c.sourceCountry] : undefined;
  const dst = c ? ENDPOINTS[c.targetCountry] : undefined;
  return src && dst ? { src, dst } : null;
}
