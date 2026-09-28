// Planar geometry helpers. All coordinates here are in meters on a local
// tangent plane (x = east, y = north) produced by `projection.ts`.

import ClipperLib from 'clipper-lib';

export interface Pt {
  x: number;
  y: number;
}

export type Ring = Pt[];

/** One polygon: an outer ring plus zero or more holes (no-apply areas). */
export interface Poly {
  outer: Ring;
  holes: Ring[];
}

export const SQ_M_PER_ACRE = 4046.8564224;
export const M_PER_FT = 0.3048;

/** Signed shoelace area; positive when the ring is counter-clockwise. */
export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return -a / 2;
}

export function ringArea(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

export function polyArea(p: Poly): number {
  return ringArea(p.outer) - p.holes.reduce((s, h) => s + ringArea(h), 0);
}

export function polysArea(ps: Poly[]): number {
  return ps.reduce((s, p) => s + polyArea(p), 0);
}

export function ringLength(ring: Ring, closed = true): number {
  let len = 0;
  const n = ring.length;
  const end = closed ? n : n - 1;
  for (let i = 0; i < end; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

export function rotate(p: Pt, cos: number, sin: number): Pt {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

export function rotateRing(ring: Ring, cos: number, sin: number): Ring {
  return ring.map((p) => rotate(p, cos, sin));
}

export function rotatePoly(p: Poly, cos: number, sin: number): Poly {
  return { outer: rotateRing(p.outer, cos, sin), holes: p.holes.map((h) => rotateRing(h, cos, sin)) };
}

/** Drops a duplicated closing vertex and consecutive duplicates. */
export function cleanRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) out.pop();
  }
  return out;
}

/**
 * Heading (degrees, 0 = north, clockwise) of the longest edge of the ring.
 * Operators usually set their AB line along the longest straight side.
 */
export function longestEdgeHeading(ring: Ring): number {
  let best = 0;
  let heading = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) {
      best = len;
      heading = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    }
  }
  return ((heading % 180) + 180) % 180;
}

// ---------------------------------------------------------------------------
// Clipper wrappers (Clipper works on integers; we use millimeters).

const SCALE = 1000;

type IntPath = { X: number; Y: number }[];

function toPath(ring: Ring): IntPath {
  return ring.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function fromPath(path: IntPath): Ring {
  return path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

function polysToPaths(polys: Poly[]): IntPath[] {
  const paths: IntPath[] = [];
  for (const p of polys) {
    const outer = toPath(p.outer);
    if (!ClipperLib.Clipper.Orientation(outer)) outer.reverse();
    paths.push(outer);
    for (const h of p.holes) {
      const hole = toPath(h);
      if (ClipperLib.Clipper.Orientation(hole)) hole.reverse();
      paths.push(hole);
    }
  }
  return paths;
}

/** Converts a Clipper PolyTree into our outer/holes structure. */
function treeToPolys(tree: any): Poly[] {
  const out: Poly[] = [];
  const visit = (node: any) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) continue;
      const outer = fromPath(child.Contour());
      const holes: Ring[] = [];
      for (const h of child.Childs()) {
        holes.push(fromPath(h.Contour()));
        visit(h); // islands inside holes
      }
      if (outer.length >= 3) out.push({ outer, holes });
    }
  };
  visit(tree);
  return out;
}

/**
 * Offsets polygons by `delta` meters (negative shrinks). Miter joins keep
 * straight headland laps straight and corners square, like a real machine.
 */
export function offsetPolys(polys: Poly[], delta: number): Poly[] {
  const co = new ClipperLib.ClipperOffset(4, 0.05 * SCALE);
  co.AddPaths(polysToPaths(polys), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, delta * SCALE);
  return treeToPolys(tree);
}

/** Boolean difference a − b. */
export function differencePolys(a: Poly[], b: Poly[]): Poly[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(polysToPaths(a), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(polysToPaths(b), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return treeToPolys(tree);
}

/** Normalizes (fixes self-intersections, orientation) via a union. */
export function normalizePolys(polys: Poly[]): Poly[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(polysToPaths(polys), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return treeToPolys(tree);
}

// ---------------------------------------------------------------------------
// Scanline intersection of a horizontal line with a set of rings.

/**
 * X-intervals where the horizontal line at `y` lies inside the rings
 * (even-odd rule, so holes are excluded automatically).
 */
export function lineIntervals(rings: Ring[], y: number): [number, number][] {
  const xs: number[] = [];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[j];
      const b = ring[i];
      // Half-open rule avoids double-counting vertices exactly on the line.
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > 1e-9) out.push([xs[i], xs[i + 1]]);
  }
  return out;
}

export function allRings(polys: Poly[]): Ring[] {
  const rings: Ring[] = [];
  for (const p of polys) {
    rings.push(p.outer, ...p.holes);
  }
  return rings;
}

export type Intervals = [number, number][];

export function unionIntervals(sets: Intervals[]): Intervals {
  const all = sets.flat().sort((a, b) => a[0] - b[0]);
  const out: Intervals = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function intersectIntervals(a: Intervals, b: Intervals): Intervals {
  const out: Intervals = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}
