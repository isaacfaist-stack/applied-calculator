import { describe, expect, it } from 'vitest';
import { type Poly, SQ_M_PER_ACRE, polysArea } from '../src/engine/geometry';
import { optimizeHeading, plan, prepareField } from '../src/engine/plan';
import { computeCoverage } from '../src/engine/coverage';
import { adviseMidField, adviseRate } from '../src/engine/rate';

const rect = (w: number, h: number): Poly[] => [
  { outer: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], holes: [] },
];

describe('plan', () => {
  it('a rectangle that divides evenly has almost no overlap', () => {
    // 360 m x 540 m, 18 m width, passes north-south, 2 headland laps.
    const field = rect(360, 540);
    const r = plan(field, { widthM: 18, sections: 1 }, { headlandLaps: 2, cornerStyle: 'pivot', headingDeg: 0, shutoff: 'center' });
    expect(r.surfaceM2).toBeCloseTo(360 * 540, 3);
    // Headland: lap centerlines are rectangles inset 9 m and 27 m.
    const lap1 = 2 * (342 + 522) * 18;
    const lap2 = 2 * (306 + 486) * 18;
    expect(r.headlandAppliedM2).toBeCloseTo(lap1 + lap2, 0);
    // Interior 288 x 468 covered by 16 passes, no overlap.
    expect(r.passCount).toBe(16);
    expect(r.passAppliedM2).toBeCloseTo(288 * 468, 0);
    // Pivoting on square corners: the double-hit inside each turn exactly
    // offsets the unapplied wedge outside it, so applied == surface.
    expect(r.appliedM2 / r.surfaceM2 - 1).toBeCloseTo(0, 6);
    // Overrunning 4 corners on each of 2 laps adds 8 x 9 m x 18 m.
    const o = plan(field, { widthM: 18, sections: 1 }, { headlandLaps: 2, cornerStyle: 'overrun', headingDeg: 0, shutoff: 'center' });
    expect(o.appliedM2 - r.appliedM2).toBeCloseTo(8 * 9 * 18, 0);
    const cov = computeCoverage(field, o.swaths, 20);
    expect(cov.skipM2).toBeLessThan(5);
  });

  it('a partial last pass is still applied and shows up as overlap', () => {
    // 100 m interior with 18 m width -> 5 full passes + 10 m leftover.
    const field = rect(100, 300);
    const r = plan(field, { widthM: 18, sections: 1 }, { headlandLaps: 0, cornerStyle: 'pivot', headingDeg: 0, shutoff: 'center' });
    expect(r.passCount).toBe(6);
    expect(r.appliedM2).toBeCloseTo(6 * 18 * 300, 0);
    const cov = computeCoverage(field, r.swaths, 20);
    expect(cov.skipM2 / r.surfaceM2).toBeLessThan(0.005);
  });

  it('angled headland lines cost more with no-skip than with center shutoff', () => {
    // Parallelogram field: passes cross the ends at an angle.
    const field: Poly[] = [
      { outer: [{ x: 0, y: 0 }, { x: 360, y: 0 }, { x: 560, y: 500 }, { x: 200, y: 500 }], holes: [] },
    ];
    const m = { widthM: 27, sections: 1 };
    const noskip = plan(field, m, { headlandLaps: 2, cornerStyle: 'pivot', headingDeg: 90, shutoff: 'noskip' });
    const center = plan(field, m, { headlandLaps: 2, cornerStyle: 'pivot', headingDeg: 90, shutoff: 'center' });
    const noover = plan(field, m, { headlandLaps: 2, cornerStyle: 'pivot', headingDeg: 90, shutoff: 'nooverlap' });
    expect(noskip.appliedM2).toBeGreaterThan(center.appliedM2);
    expect(center.appliedM2).toBeGreaterThan(noover.appliedM2);
    // More sections -> less overlap.
    const sections = plan(field, { widthM: 27, sections: 9 }, { headlandLaps: 2, cornerStyle: 'pivot', headingDeg: 90, shutoff: 'noskip' });
    expect(sections.appliedM2).toBeLessThan(noskip.appliedM2);
  });

  it('coverage accounting matches applied area', () => {
    const field: Poly[] = [
      { outer: [{ x: 0, y: 0 }, { x: 400, y: 30 }, { x: 380, y: 420 }, { x: 150, y: 500 }, { x: -20, y: 300 }], holes: [] },
    ];
    const r = plan(field, { widthM: 18.288, sections: 1 }, { headlandLaps: 2, cornerStyle: 'pivot', headingDeg: 37, shutoff: 'center' });
    const cov = computeCoverage(field, r.swaths, 20);
    const fromRaster = cov.singleM2 + cov.overlapAreaM2 + cov.overlapExtraM2 + cov.offFieldM2;
    expect(Math.abs(fromRaster - r.appliedM2) / r.appliedM2).toBeLessThan(0.01);
    expect(Math.abs(cov.singleM2 + cov.overlapAreaM2 + cov.skipM2 - r.surfaceM2) / r.surfaceM2).toBeLessThan(0.01);
    // Center shutoff trades small skips for small overlaps at angled ends.
    expect(cov.skipM2 / r.surfaceM2).toBeLessThan(0.02);
    const ns = plan(field, { widthM: 18.288, sections: 1 }, { headlandLaps: 2, cornerStyle: 'overrun', headingDeg: 37, shutoff: 'noskip' });
    expect(computeCoverage(field, ns.swaths, 20).skipM2 / r.surfaceM2).toBeLessThan(0.002);
  });

  it('excludes holes from surface acres and from the passes', () => {
    const field: Poly[] = [
      {
        outer: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }],
        holes: [[{ x: 150, y: 150 }, { x: 250, y: 150 }, { x: 250, y: 250 }, { x: 150, y: 250 }]],
      },
    ];
    expect(polysArea(field)).toBeCloseTo(400 * 400 - 100 * 100, 3);
    const r = plan(field, { widthM: 20, sections: 1 }, { headlandLaps: 1, cornerStyle: 'pivot', headingDeg: 0, shutoff: 'center' });
    expect(r.passAppliedM2).toBeCloseTo(360 * 360 - 100 * 100, -1);
  });

  it('optimizer finds the heading aligned with a rotated rectangle', () => {
    const t = (30 * Math.PI) / 180;
    const pts = [[0, 0], [300, 0], [300, 470], [0, 470]].map(([x, y]) => ({
      x: x * Math.cos(t) - y * Math.sin(t),
      y: x * Math.sin(t) + y * Math.cos(t),
    }));
    const prep = prepareField([{ outer: pts, holes: [] }], { widthM: 18, sections: 1 }, 2);
    const best = optimizeHeading(prep, 'noskip');
    // Rectangle long side points 30deg counter-clockwise from north => heading 150 (or 60).
    const d = Math.min(Math.abs(best.headingDeg - 150), Math.abs(best.headingDeg - 60));
    expect(d).toBeLessThan(1.5);
  });
});

describe('rate', () => {
  it('scales the rate by surface / applied', () => {
    const a = adviseRate({ surfaceAc: 100, appliedAc: 105, targetRate: 200, loaded: 20000 })!;
    expect(a.rateForTarget).toBeCloseTo(190.476, 2);
    expect(a.rateChangePct).toBeCloseTo(-0.047619, 5);
    expect(a.productAtTarget).toBe(21000);
    expect(a.loadBalance).toBe(-1000);
    expect(a.rateToEmpty).toBeCloseTo(190.476, 2);
  });

  it('mid-field: rate to finish with what is left', () => {
    const m = adviseMidField({ plannedAppliedAc: 105, appliedSoFarAc: 60, remaining: 8500, currentRate: 200 })!;
    expect(m.remainingAc).toBe(45);
    expect(m.rateToFinish).toBeCloseTo(188.89, 2);
    expect(m.balance).toBe(-500);
  });

  it('acre constant', () => {
    expect(SQ_M_PER_ACRE).toBeCloseTo(4046.86, 2);
  });
});
