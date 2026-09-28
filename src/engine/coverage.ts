// Rasterizes a plan into a coverage grid: how many times each patch of
// ground receives product. This gives the overlap/skip breakdown and the
// map heat layer.

import { type Poly, type Pt, allRings, lineIntervals } from './geometry';
import type { Swath } from './plan';

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
  for (const s of swaths) {
    const quad = swathQuad(s);
    let qMinY = Infinity, qMaxY = -Infinity;
    for (const q of quad) {
      if (q.y < qMinY) qMinY = q.y;
      if (q.y > qMaxY) qMaxY = q.y;
    }
    const r0 = Math.max(0, Math.ceil((qMinY - minY) / cell - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((qMaxY - minY) / cell - 0.5));
    for (let r = r0; r <= r1; r++) {
      const y = minY + (r + 0.5) * cell;
      for (const [x0, x1] of lineIntervals([quad], y)) fillRow(r, x0, x1, inc);
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
