import { describe, expect, it } from 'vitest';
import { type Poly, SQ_M_PER_ACRE, polysArea } from '../src/engine/geometry';
import { optimizeHeading, plan, prepareField } from '../src/engine/plan';
import { computeCoverage } from '../src/engine/coverage';
import { actualRateAt, adviseMidField, adviseRate, averageCalibration, checkJob, densityFor, splitChange } from '../src/engine/rate';

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
    // Passes shut off across the hole. The two passes running right along its
    // sides stay on (half over the hole) rather than leave a strip each side.
    const need = 360 * 360 - 100 * 100;
    expect(r.passAppliedM2).toBeGreaterThanOrEqual(need - 5);
    expect(r.passAppliedM2).toBeLessThanOrEqual(need + 2 * 20 * 100);
    const cov = computeCoverage(field, r.swaths, 20);
    expect(cov.skipM2 / r.surfaceM2).toBeLessThan(0.01);
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

describe('exclusions: drive through vs go around', () => {
  // 400 x 400 m field with a 100 x 100 m block of trees in the middle.
  const trees = [{ x: 150, y: 150 }, { x: 250, y: 150 }, { x: 250, y: 250 }, { x: 150, y: 250 }];
  const field: Poly[] = [
    { outer: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }], holes: [trees] },
  ];
  const opts = { headlandLaps: 2, cornerStyle: 'pivot' as const, headingDeg: 0, shutoff: 'center' as const };
  const m = { widthM: 20, sections: 1 };

  it('drive through: no laps around it, passes run across with product off', () => {
    const r = plan(field, m, opts);
    expect(r.headlandPaths.length).toBe(2); // only the outer boundary
    expect(r.surfaceM2).toBeCloseTo(400 * 400 - 100 * 100, 3);
  });

  it('go around: headland laps wrap the trees and passes stop at their headland', () => {
    const r = plan(field, m, opts, [{ outer: trees, holes: [] }]);
    expect(r.headlandPaths.length).toBe(4); // 2 laps around the edge + 2 around the trees
    expect(r.surfaceM2).toBeCloseTo(400 * 400 - 100 * 100, 3);
    // Interior: field minus 2 laps (360 → 320 square) minus trees grown by 2 laps (140 square).
    expect(r.interiorM2).toBeCloseTo(320 * 320 - 180 * 180, -2);
    // Nothing is applied on the trees either way, and coverage stays complete.
    const cov = computeCoverage(field, r.swaths, 20);
    expect(cov.skipM2 / r.surfaceM2).toBeLessThan(0.01);
  });
});

describe('headland laps follow curves smoothly', () => {
  const headlandOnly = (field: Poly[], laps: number, W: number) => {
    const r = plan(field, { widthM: W, sections: 1 }, { headlandLaps: laps, cornerStyle: 'pivot', headingDeg: 0, shutoff: 'center' });
    const cov = computeCoverage(field, r.swaths.filter((s) => s.kind === 'headland'), 20);
    const bandM2 = r.surfaceM2 - r.interiorM2;
    // Everything inside the headland laps is a "skip" here (no passes drawn).
    return { bandM2, skipInBand: cov.skipM2 - r.interiorM2, overlap: cov.overlapAreaM2 };
  };

  it('a round field: no speckled skips or doubles around the curve', () => {
    const ring = Array.from({ length: 180 }, (_, i) => {
      const t = (i / 180) * 2 * Math.PI;
      return { x: 400 * Math.cos(t), y: 400 * Math.sin(t) };
    });
    const { bandM2, skipInBand, overlap } = headlandOnly([{ outer: ring, holes: [] }], 2, 18);
    expect(Math.abs(skipInBand) / bandM2).toBeLessThan(0.005);
    expect(overlap / bandM2).toBeLessThan(0.005);
  });

  it('a GPS-traced boundary with jitter behaves the same', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.8;
    const ring = [];
    for (let x = 0; x < 600; x += 3) ring.push({ x, y: rnd() });
    for (let y = 0; y < 400; y += 3) ring.push({ x: 600 + rnd(), y });
    for (let x = 600; x > 0; x -= 3) ring.push({ x, y: 400 + rnd() });
    for (let y = 400; y > 0; y -= 3) ring.push({ x: rnd(), y });
    const { bandM2, skipInBand, overlap } = headlandOnly([{ outer: ring, holes: [] }], 2, 18);
    // Only the 4 real corners show up (2 laps x 4 corners x ~9 m x 9 m:
    // doubled inside, bare outside when pivoting), nothing along the edges.
    // Before smoothing, jitter alone produced ~4,400 m² of each.
    expect(overlap).toBeLessThan(8 * 81 * 1.5);
    expect(Math.abs(skipInBand)).toBeLessThan(8 * 81 * 1.5);
    expect(overlap / bandM2).toBeLessThan(0.02);
  });

  it('a square corner still overlaps where the two runs meet', () => {
    const { overlap } = headlandOnly(rect(360, 540), 2, 18);
    // 4 corners x 2 laps x (9 m x 9 m) inner square.
    expect(overlap).toBeGreaterThan(8 * 81 * 0.8);
    expect(overlap).toBeLessThan(8 * 81 * 1.2);
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

  it('density adjustment is the inverse of a rate adjustment', () => {
    // Rate cut to 190.476 (−4.76%) is the same as programming 5% more density.
    const d = densityFor(60, 200, 190.476);
    expect(d).toBeCloseTo(63, 2);
    expect(d / 60 - 1).toBeCloseTo(0.05, 4);
    // With that density and the screen left at 200, the machine meters 190.476.
    expect(actualRateAt(60, 200, d)).toBeCloseTo(190.476, 3);
    // Product left over at the end: program less density to dump it.
    expect(densityFor(60, 200, 210)).toBeLessThan(60);
  });

  it('machine bias: a spreader that puts out 3% extra gets set 3% lower', () => {
    const a = adviseRate({ surfaceAc: 100, appliedAc: 105, targetRate: 200, loaded: 20000, bias: 0.03 })!;
    // Controller setting × applied acres × 1.03 must equal what the field needs.
    expect(a.rateForTarget * 105 * 1.03).toBeCloseTo(200 * 100, 6);
    expect(a.productAtTarget).toBeCloseTo(200 * 105 * 1.03, 6);
    expect(a.rateToEmpty! * 105 * 1.03).toBeCloseTo(20000, 6);
    // A machine that under-applies needs a higher setting.
    const low = adviseRate({ surfaceAc: 100, appliedAc: 105, targetRate: 200, bias: -0.03 })!;
    expect(low.rateForTarget).toBeGreaterThan(adviseRate({ surfaceAc: 100, appliedAc: 105, targetRate: 200 })!.rateForTarget);
    const m = adviseMidField({ plannedAppliedAc: 105, appliedSoFarAc: 60, remaining: 9000, currentRate: 200, bias: 0.03 })!;
    expect(m.rateToFinish * 45 * 1.03).toBeCloseTo(9000, 6);
    expect(m.balance).toBeCloseTo(9000 - 200 * 1.03 * 45, 6);
  });

  it("acres' worth given: 67 ac of product over 70.3 applied ac", () => {
    // Real job: GIS 64.49 ac, planned 70.3 applied ac, given 67 acres' worth.
    const rate = 200;
    const a = adviseRate({ surfaceAc: 64.49, appliedAc: 70.3, targetRate: rate, loaded: 67 * rate })!;
    expect(a.rateToEmpty).toBeCloseTo((200 * 67) / 70.3, 6); // 190.61
    expect(a.rateToEmptyChangePct!).toBeCloseTo(67 / 70.3 - 1, 6); // −4.69%
    // Same thing as a density change, true density 62: +4.93%.
    expect(densityFor(62, rate, a.rateToEmpty!) / 62 - 1).toBeCloseTo(70.3 / 67 - 1, 6);
  });

  it('rate tracking: a machine averaging 96% of the request is set higher', () => {
    const a = adviseRate({ surfaceAc: 100, appliedAc: 105, targetRate: 200, loaded: 20000, tracking: 0.96 })!;
    expect(a.rateToEmpty! * 0.96 * 105).toBeCloseTo(20000, 6);
    expect(a.productAtTarget).toBeCloseTo(200 * 0.96 * 105, 6);
    // Tracking and bias stack.
    const both = adviseRate({ surfaceAc: 100, appliedAc: 105, targetRate: 200, tracking: 0.96, bias: 0.02 })!;
    expect(both.rateForTarget * 105 * 0.96 * 1.02).toBeCloseTo(200 * 100, 6);
    const m = adviseMidField({ plannedAppliedAc: 105, appliedSoFarAc: 60, remaining: 9000, currentRate: 200, tracking: 0.96 })!;
    expect(m.rateToFinish * 0.96 * 45).toBeCloseTo(9000, 6);
  });

  it('job check: the real field (250 lb/ac, 68.5 true, 70 set, 67 ac worth, 1,084 lb left)', () => {
    const used = 67 * 250 - 1084; // 15,666
    // Without the monitor's average rate, everything lands in the gap.
    const blind = checkJob({ requestedRate: 250, appliedAc: 69.5, used, trueDensity: 68.5, programmedDensity: 70 })!;
    expect(blind.expectedOut).toBeCloseTo(250 * 69.5 * (68.5 / 70), 6);
    expect(blind.gap).toBeCloseTo(used / (250 * 69.5 * (68.5 / 70)) - 1, 9); // ≈ −7.9%
    expect(blind.impliedDensity).toBeCloseTo((70 * used) / (250 * 69.5), 6); // ≈ 63.1
    // If the monitor averaged 238 lb/ac, tracking explains part of it.
    const r = checkJob({ requestedRate: 250, achievedRate: 238, appliedAc: 69.5, used, trueDensity: 68.5, programmedDensity: 70 })!;
    expect(r.tracking).toBeCloseTo(0.952, 6);
    expect(Math.abs(r.gap)).toBeLessThan(Math.abs(blind.gap));
    expect(r.impliedDensity).toBeCloseTo((70 * used) / (238 * 69.5), 6);
  });

  it('splits the change into ticket acres vs overlap (the Barrett ticket)', () => {
    // 27,900 lb for 62 ac at 450, boundary 64.61 ac, plan 65.71 applied ac.
    const i = { surfaceAc: 64.61, appliedAc: 65.71, targetRate: 450, loaded: 27900, density: 65 };
    const parts = splitChange(i);
    expect(parts.map((p) => p.key)).toEqual(['given', 'overlap']);
    const a = adviseRate(i)!;
    // The parts multiply back to the controller setting.
    expect(parts.reduce((m, p) => m * p.factor, 1)).toBeCloseTo(a.rateToEmpty! / 450, 10);
    // As density changes: +4.2% from the ticket, +1.7% from overlap, +6.0% total.
    const dens = (f: number) => 1 / f - 1;
    expect(dens(parts[0].factor)).toBeCloseTo(0.042, 3);
    expect(dens(parts[1].factor)).toBeCloseTo(0.017, 3);
    expect(densityFor(65, 450, a.rateToEmpty!) / 65 - 1).toBeCloseTo(0.0597, 3);
    // Machine factors join in when set.
    const withMachine = splitChange({ ...i, tracking: 0.96, bias: 0.03 });
    expect(withMachine.map((p) => p.key)).toEqual(['given', 'overlap', 'tracking', 'bias']);
    const b = adviseRate({ ...i, tracking: 0.96, bias: 0.03 })!;
    expect(withMachine.reduce((m, p) => m * p.factor, 1)).toBeCloseTo(b.rateToEmpty! / 450, 10);
  });

  it('calibration: averages several jobs and flags the odd one out', () => {
    // Machine really puts out 2% more and the belt averages 96% of the request.
    const job = (id: string, ac: number, gapPct: number) => {
      const requestedRate = 250;
      const achievedRate = 240;
      return { id, requestedRate, achievedRate, appliedAc: ac, used: achievedRate * ac * (1 + gapPct / 100) };
    };
    const jobs = [job('a', 70, 2.5), job('b', 40, 1.5), job('c', 120, 2.0), job('d', 60, 1.8)];
    const avg = averageCalibration(jobs)!;
    expect(avg.n).toBe(4);
    expect(avg.tracking).toBeCloseTo(0.96, 6);
    expect(avg.gap).toBeCloseTo(0.02, 2);
    expect(avg.gapSd).toBeLessThan(0.005);
    expect(avg.outliers).toEqual([]);

    // A load with a badly wrong ticket density stands out…
    const withBad = [...jobs, job('e', 65, 9)];
    const bad = averageCalibration(withBad)!;
    expect(bad.outliers).toEqual(['e']);
    expect(bad.gap).toBeGreaterThan(0.03);
    // …and excluding it brings the average back.
    const fixed = averageCalibration(withBad.map((j) => (j.id === 'e' ? { ...j, excluded: true } : j)))!;
    expect(fixed.n).toBe(4);
    expect(fixed.gap).toBeCloseTo(avg.gap, 10);
    expect(fixed.gaps.e).toBeCloseTo(0.09, 6);
  });

  it('calibration: bigger loads count for more', () => {
    const avg = averageCalibration([
      { id: 'small', requestedRate: 200, appliedAc: 10, used: 200 * 10 * 1.1 },
      { id: 'big', requestedRate: 200, appliedAc: 90, used: 200 * 90 * 1.0 },
    ])!;
    expect(avg.gap).toBeCloseTo(200 / 20000, 6); // 20,200 lb out of 20,000 expected
    expect(avg.tracking).toBeUndefined();
  });

  it('acre constant', () => {
    expect(SQ_M_PER_ACRE).toBeCloseTo(4046.86, 2);
  });
});
