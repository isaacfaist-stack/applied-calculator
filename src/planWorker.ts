// Runs the plan + coverage off the main thread so the UI stays responsive.

import type { Poly, Pt, Ring } from './engine/geometry';
import { longestEdgeHeading, ringArea } from './engine/geometry';
import { computeCoverage, coverageToRGBA } from './engine/coverage';
import { type CornerStyle, type PreparedField, type ShutoffMode, optimizeHeading, planWithPrepared, prepareField } from './engine/plan';

export interface PlanRequest {
  id: number;
  fieldKey: string;
  polys: Poly[];
  widthM: number;
  sections: number;
  headlandLaps: number;
  cornerStyle: CornerStyle;
  shutoff: ShutoffMode;
  headingMode: 'longest' | 'optimized' | 'manual';
  headingDeg: number;
}

export interface PlanResponse {
  id: number;
  error?: string;
  headingDeg: number;
  surfaceM2: number;
  appliedM2: number;
  headlandAppliedM2: number;
  passAppliedM2: number;
  interiorM2: number;
  passCount: number;
  onDistanceM: number;
  headlandPaths: Ring[];
  passLines: [Pt, Pt][];
  coverage: {
    minX: number;
    minY: number;
    cell: number;
    cols: number;
    rows: number;
    rgba: Uint8ClampedArray;
    singleM2: number;
    overlapAreaM2: number;
    overlapExtraM2: number;
    skipM2: number;
    offFieldM2: number;
  };
}

let cacheKey = '';
let cached: PreparedField | null = null;
const optimized = new Map<string, number>();

self.onmessage = (e: MessageEvent<PlanRequest>) => {
  const r = e.data;
  try {
    const key = [r.fieldKey, r.widthM, r.sections, r.headlandLaps, r.cornerStyle].join('|');
    if (key !== cacheKey || !cached) {
      cached = prepareField(r.polys, { widthM: r.widthM, sections: r.sections }, r.headlandLaps, r.cornerStyle);
      cacheKey = key;
    }
    let heading = r.headingDeg;
    if (r.headingMode === 'longest') {
      const main = r.polys.reduce((a, b) => (ringArea(b.outer) > ringArea(a.outer) ? b : a));
      heading = longestEdgeHeading(main.outer);
    } else if (r.headingMode === 'optimized') {
      const okey = key + '|' + r.shutoff;
      if (!optimized.has(okey)) optimized.set(okey, optimizeHeading(cached, r.shutoff).headingDeg);
      heading = optimized.get(okey)!;
    }
    const res = planWithPrepared(cached, { headingDeg: heading, shutoff: r.shutoff });
    const cov = computeCoverage(r.polys, res.swaths, r.widthM * 1.5);
    const rgba = coverageToRGBA(cov);
    const out: PlanResponse = {
      id: r.id,
      headingDeg: heading,
      surfaceM2: res.surfaceM2,
      appliedM2: res.appliedM2,
      headlandAppliedM2: res.headlandAppliedM2,
      passAppliedM2: res.passAppliedM2,
      interiorM2: res.interiorM2,
      passCount: res.passCount,
      onDistanceM: res.onDistanceM,
      headlandPaths: res.headlandPaths,
      passLines: res.passLines,
      coverage: {
        minX: cov.minX,
        minY: cov.minY,
        cell: cov.cell,
        cols: cov.cols,
        rows: cov.rows,
        rgba,
        singleM2: cov.singleM2,
        overlapAreaM2: cov.overlapAreaM2,
        overlapExtraM2: cov.overlapExtraM2,
        skipM2: cov.skipM2,
        offFieldM2: cov.offFieldM2,
      },
    };
    (self as unknown as Worker).postMessage(out, [rgba.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: r.id, error: String((err as Error)?.message ?? err) });
  }
};
