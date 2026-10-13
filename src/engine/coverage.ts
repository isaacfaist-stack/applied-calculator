// Rasterizes a plan into a coverage grid: how many times each patch of
// ground receives product. This gives the overlap/skip breakdown and the
// map heat layer.

import { type Poly, type Pt, allRings, lineIntervals } from './geometry';
import { type Swath, SHARP_TURN_RAD } from './plan';

export interface CoverageResult {
  /** Grid origin (lower-left, local meters) and cell size. */
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** Times applied, row-major, row 0 at minY. */
  counts: Uint16Array;
  /** 1 where the cell center is inside the field (holes excluded). */
  mask: Uint8Array;
  singleM2: number;
  /** Field area receiving product two or more times. */
  overlapAreaM2: number;
  /** Extra applications on overlapped ground (a double-hit counts once). */
  overlapExtraM2: number;
  /** Field area receiving no product. */
  skipM2: number;
  /** Product applied outside the field or on excluded areas (by area). */
  offFieldM2: number;
}

const MAX_CELLS = 2_500_000;

export function computeCoverage(field: Poly[], swaths: Swath[], margin: number): CoverageResult {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of field) for (const q of p.outer) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;
  const cell = Math.max(0.25, Math.sqrt(((maxX - minX) * (maxY - minY)) / MAX_CELLS));
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell));
  const counts = new Uint16Array(cols * rows);
  const mask = new Uint8Array(cols * rows);

  const fillRow = (row: number, x0: number, x1: number, fn: (i: number) => void) => {
    // Cells whose center lies in [x0, x1).
    const c0 = Math.max(0, Math.ceil((x0 - minX) / cell - 0.5));
    const c1 = Math.min(cols - 1, Math.ceil((x1 - minX) / cell - 0.5) - 1);
    const base = row * cols;
    for (let c = c0; c <= c1; c++) fn(base + c);
  };

  const fieldRings = allRings(field);
  for (let r = 0; r < rows; r++) {
    const y = minY + (r + 0.5) * cell;
    for (const [x0, x1] of lineIntervals(fieldRings, y)) fillRow(r, x0, x1, (i) => (mask[i] = 1));
  }

  const inc = (i: number) => {
    if (counts[i] < 65535) counts[i]++;
  };
  /** Calls fn for every cell whose center is inside the convex polygon. */
  const fillPoly = (poly: Pt[], fn: (i: number) => void) => {
    let pMinY = Infinity, pMaxY = -Infinity;
    for (const q of poly) {
      if (q.y < pMinY) pMinY = q.y;
      if (q.y > pMaxY) pMaxY = q.y;
    }
    const r0 = Math.max(0, Math.ceil((pMinY - minY) / cell - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((pMaxY - minY) / cell - 0.5));
    for (let r = r0; r <= r1; r++) {
      const y = minY + (r + 0.5) * cell;
      for (const [x0, x1] of lineIntervals([poly], y)) fillRow(r, x0, x1, fn);
    }
  };

  // Interior passes: each strip adds one application.
  const laps = new Map<number, Swath[]>();
  for (const s of swaths) {
    if (s.group !== undefined) {
      const list = laps.get(s.group);
      if (list) list.push(s);
      else laps.set(s.group, [s]);
    } else {
      fillPoly(swathQuad(s), inc);
    }
  }

  // Headland laps: one continuous band. Gentle bends are joined smoothly
  // (no skip outside the bend, no double inside it). At sharp corners the
  // two straight runs overlap, and pivoting leaves the outside corner bare.
  const lapMask = new Uint8Array(cols * rows);
  for (const lap of laps.values()) {
    const quads = lap.map(swathQuad);
    for (const q of quads) fillPoly(q, (i) => (lapMask[i] = 1));
    for (let k = 0; k < lap.length; k++) {
      const s1 = lap[k];
      const s2 = lap[(k + 1) % lap.length];
      if (lap.length < 2) break;
      if (turnAngle(s1, s2) < SHARP_TURN_RAD) {
        // Fill the wedges between the two strips on both sides of the bend.
        const v = s2.a;
        const n1 = halfNormal(s1);
        const n2 = halfNormal(s2);
        fillPoly([v, { x: v.x + n1.x, y: v.y + n1.y }, { x: v.x + n2.x, y: v.y + n2.y }], (i) => (lapMask[i] = 1));
        fillPoly([v, { x: v.x - n1.x, y: v.y - n1.y }, { x: v.x - n2.x, y: v.y - n2.y }], (i) => (lapMask[i] = 1));
      } else {
        // Corner: ground under both runs gets product twice.
        const both = clipConvex(quads[k], quads[(k + 1) % quads.length]);
        if (both.length >= 3) fillPoly(both, inc);
      }
    }
    for (let i = 0; i < lapMask.length; i++) {
      if (lapMask[i]) {
        inc(i);
        lapMask[i] = 0;
      }
    }
  }

  const a = cell * cell;
  let singleM2 = 0, overlapAreaM2 = 0, overlapExtraM2 = 0, skipM2 = 0, offFieldM2 = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (mask[i]) {
      if (c === 0) skipM2 += a;
      else if (c === 1) singleM2 += a;
      else {
        overlapAreaM2 += a;
        overlapExtraM2 += (c - 1) * a;
      }
    } else if (c > 0) {
      offFieldM2 += c * a;
    }
  }

  return { minX, minY, cell, cols, rows, counts, mask, singleM2, overlapAreaM2, overlapExtraM2, skipM2, offFieldM2 };
}

/** Absolute change of direction between consecutive strips, radians. */
function turnAngle(s1: Swath, s2: Swath): number {
  let t = Math.atan2(s2.b.y - s2.a.y, s2.b.x - s2.a.x) - Math.atan2(s1.b.y - s1.a.y, s1.b.x - s1.a.x);
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return Math.abs(t);
}

/** Left-pointing normal of a strip, half its width long. */
function halfNormal(s: Swath): Pt {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (-dy / len) * (s.width / 2), y: (dx / len) * (s.width / 2) };
}

/** Sutherland–Hodgman: the part of convex polygon `subject` inside convex `clip`. */
export function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
  // Orient the clip polygon counter-clockwise so "inside" is to the left.
  let area = 0;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    area += a.x * b.y - b.x * a.y;
  }
  const c = area < 0 ? [...clip].reverse() : clip;
  let out = subject;
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const side = (p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return out;
}

export function swathQuad(s: Swath): Pt[] {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (s.width / 2);
  const ny = (dx / len) * (s.width / 2);
  return [
    { x: s.a.x + nx, y: s.a.y + ny },
    { x: s.b.x + nx, y: s.b.y + ny },
    { x: s.b.x - nx, y: s.b.y - ny },
    { x: s.a.x - nx, y: s.a.y - ny },
  ];
}

export const COVERAGE_COLORS = {
  skip: [220, 38, 38, 200],
  single: [34, 197, 94, 110],
  double: [250, 204, 21, 190],
  triple: [249, 115, 22, 220],
  offField: [96, 165, 250, 170],
} as const;

/** Paints the grid into RGBA pixels, top row first (north up). */
export function coverageToRGBA(cov: CoverageResult): Uint8ClampedArray {
  const px = new Uint8ClampedArray(cov.cols * cov.rows * 4);
  for (let r = 0; r < cov.rows; r++) {
    const outRow = cov.rows - 1 - r;
    for (let c = 0; c < cov.cols; c++) {
      const i = r * cov.cols + c;
      const n = cov.counts[i];
      let color: readonly number[] | null = null;
      if (cov.mask[i]) {
        color = n === 0 ? COVERAGE_COLORS.skip : n === 1 ? COVERAGE_COLORS.single : n === 2 ? COVERAGE_COLORS.double : COVERAGE_COLORS.triple;
      } else if (n > 0) {
        color = COVERAGE_COLORS.offField;
      }
      if (!color) continue;
      const o = (outRow * cov.cols + c) * 4;
      px[o] = color[0];
      px[o + 1] = color[1];
      px[o + 2] = color[2];
      px[o + 3] = color[3];
    }
  }
  return px;
}
