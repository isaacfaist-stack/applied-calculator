// Local tangent-plane projection. Fields are small (a few km at most), so a
// WGS84 equirectangular projection centered on the field keeps distances and
// areas accurate to well under 0.01%.

import type { Pt, Ring } from './geometry';

export type LonLat = [number, number];

const A = 6378137; // WGS84 semi-major axis
const E2 = 0.00669437999014; // WGS84 first eccentricity squared

export interface Projection {
  lon0: number;
  lat0: number;
  toLocal(ll: LonLat): Pt;
  toLonLat(p: Pt): LonLat;
}

export function makeProjection(lon0: number, lat0: number): Projection {
  const phi = (lat0 * Math.PI) / 180;
  const s = Math.sin(phi);
  const w = 1 - E2 * s * s;
  const meridional = (A * (1 - E2)) / Math.pow(w, 1.5); // M
  const primeVertical = A / Math.sqrt(w); // N
  const mPerDegLat = (meridional * Math.PI) / 180;
  const mPerDegLon = (primeVertical * Math.cos(phi) * Math.PI) / 180;
  return {
    lon0,
    lat0,
    toLocal: ([lon, lat]) => ({ x: (lon - lon0) * mPerDegLon, y: (lat - lat0) * mPerDegLat }),
    toLonLat: (p) => [lon0 + p.x / mPerDegLon, lat0 + p.y / mPerDegLat],
  };
}

/** Projection centered on the bounding-box center of the given rings. */
export function projectionFor(rings: LonLat[][]): Projection {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return makeProjection((minX + maxX) / 2, (minY + maxY) / 2);
}

export function ringToLocal(proj: Projection, ring: LonLat[]): Ring {
  return ring.map((ll) => proj.toLocal(ll));
}
