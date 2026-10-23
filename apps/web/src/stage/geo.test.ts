import { describe, expect, it } from 'vitest';
import { CORRIDORS, PROVIDERS } from '@ct/contracts/browser';
import { buildRoute, buildRoutes, ENDPOINTS, greatCircle, HUBS, makeProjection, pathD, pointAt, projector, routeKey, VIEW_H, VIEW_W } from './geo';

const project = projector(makeProjection());

describe('geo', () => {
  it('has a place for every corridor endpoint and every provider hub', () => {
    for (const c of CORRIDORS) {
      expect(ENDPOINTS[c.sourceCountry]).toBeDefined();
      expect(ENDPOINTS[c.targetCountry]).toBeDefined();
    }
    for (const p of PROVIDERS) expect(HUBS[p.id]).toBeDefined();
  });

  it('projects every place inside the view box', () => {
    for (const place of [...Object.values(ENDPOINTS), ...Object.values(HUBS)]) {
      const [x, y] = project(place.lonLat);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(VIEW_W);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(VIEW_H);
    }
  });

  it('great circles start and end at the given places', () => {
    const pts = greatCircle([-74, 40.7], [72.9, 19.1], 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]?.[0]).toBeCloseTo(-74, 6);
    expect(pts[10]?.[1]).toBeCloseTo(19.1, 6);
  });

  it('builds exactly the routes the catalogue allows', () => {
    const routes = buildRoutes(project);
    const expected = PROVIDERS.flatMap((p) => p.corridors.map((c) => routeKey(c, p.id)));
    expect([...routes.keys()].sort()).toEqual(expected.sort());
    expect(routes.has('DE-BR:lyra')).toBe(false);
  });

  it('routes pass through the hub at hubT', () => {
    const src = ENDPOINTS.US!.lonLat;
    const hub = HUBS.orion!.lonLat;
    const dst = ENDPOINTS.IN!.lonLat;
    const r = buildRoute('US-IN', 'orion', src, hub, dst, project);
    expect(r.hubT).toBeGreaterThan(0);
    expect(r.hubT).toBeLessThan(1);
    const atHub = pointAt(r, r.hubT);
    const h = project(hub);
    expect(atHub[0]).toBeCloseTo(h[0], 3);
    expect(atHub[1]).toBeCloseTo(h[1], 3);
  });

  it('pointAt interpolates by length and clamps', () => {
    const r = buildRoute('X', 'y', [0, 0], [10, 0], [20, 0], ([lon, lat]) => [lon * 10, lat * 10], 4);
    expect(r.length).toBeCloseTo(200, 0);
    expect(pointAt(r, 0)).toEqual([0, 0]);
    expect(pointAt(r, -1)).toEqual([0, 0]);
    expect(pointAt(r, 2)[0]).toBeCloseTo(200, 3);
    expect(pointAt(r, 0.25)[0]).toBeCloseTo(50, 0);
    expect(pointAt(r, 0.5)[0]).toBeCloseTo(100, 0);
    expect(r.hubT).toBeCloseTo(0.5, 3);
  });

  it('pathD writes a compact polyline', () => {
    expect(pathD([
      [1.234, 2],
      [3, 4.56],
    ])).toBe('M1.2,2L3,4.6');
  });

  it('every route stays on screen (no antimeridian wrap) and its hub sits between source and target', () => {
    for (const r of buildRoutes(project).values()) {
      for (const [x, y] of r.points) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(VIEW_W);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(VIEW_H);
      }
      expect(r.hubT).toBeGreaterThan(0.05);
      expect(r.hubT).toBeLessThan(0.95);
      // no single jump across the map (a wrap would show as a huge segment)
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1]!;
        const b = r.points[i]!;
        expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(VIEW_W / 10);
      }
    }
  });

  it('places are far enough apart that markers and labels do not sit on top of each other', () => {
    const pts = [...Object.values(ENDPOINTS), ...Object.values(HUBS)].map((p) => project(p.lonLat));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1])).toBeGreaterThan(25);
  });
});
