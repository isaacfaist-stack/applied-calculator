// Converts stored lon/lat boundaries into local-meter polygons for the engine.

import type { Poly } from './engine/geometry';
import { cleanRing, normalizePolys, polysArea, SQ_M_PER_ACRE } from './engine/geometry';
import { type LonLat, type Projection, projectionFor, ringToLocal } from './engine/projection';
import type { BoundaryGeometry } from './io/import';

export interface LocalField {
  proj: Projection;
  polys: Poly[];
  acres: number;
}

export function geometryRings(g: BoundaryGeometry): LonLat[][][] {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.map((p) => p.map((ring) => ring.map((c) => [c[0], c[1]] as LonLat)));
}

export function toLocalField(g: BoundaryGeometry): LocalField {
  const polys = geometryRings(g);
  const proj = projectionFor(polys.map((p) => p[0]));
  const local: Poly[] = polys.map(([outer, ...holes]) => ({
    outer: cleanRing(ringToLocal(proj, outer)),
    holes: holes.map((h) => cleanRing(ringToLocal(proj, h))),
  }));
  // Union fixes self-intersections, orientation and overlapping parts.
  const normalized = normalizePolys(local);
  return { proj, polys: normalized, acres: polysArea(normalized) / SQ_M_PER_ACRE };
}

/** Rough center for distance sorting. */
export function geometryCenter(g: BoundaryGeometry): LonLat {
  let sx = 0, sy = 0, n = 0;
  for (const p of geometryRings(g)) for (const [x, y] of p[0]) {
    sx += x;
    sy += y;
    n++;
  }
  return [sx / n, sy / n];
}

export function pointInGeometry(g: BoundaryGeometry, [x, y]: LonLat): boolean {
  for (const poly of geometryRings(g)) {
    let inside = false;
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

export function distanceMiles(a: LonLat, b: LonLat): number {
  const R = 3958.8;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
