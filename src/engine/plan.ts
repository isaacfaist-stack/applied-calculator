// Builds a hypothetical work plan for a field: headland laps around the
// boundary, then straight back-and-forth passes through the middle.
//
// The key number is *applied acres*: what the rate controller will count.
// A rate controller meters product by  rate × working width × distance
// traveled with product on, so every foot of overlap (headland corners,
// pass ends crossing an angled headland, a partial last pass) is product that
// leaves the machine. Comparing that to the true surface acres tells us how
// much product the job will really use.

import {
  type Intervals,
  type Poly,
  type Pt,
  type Ring,
  allRings,
  cleanRing,
  differencePolys,
  intersectIntervals,
  lineIntervals,
  offsetPolys,
  polysArea,
  rotate,
  rotatePoly,
  signedArea,
  unionIntervals,
} from './geometry';

/**
 * Distance to keep driving past a headland corner at b (coming from a, going
 * on to c) so the outside of the swath reaches the boundary corner. Only
 * applies where the lap turns toward the field interior (a field corner),
 * and grows with the sharpness of the turn: W/2 for a square corner.
 */
function cornerOverrun(a: Pt, b: Pt, c: Pt, W: number, ringIsCcw: boolean): number {
  const h1 = Math.atan2(b.y - a.y, b.x - a.x);
  const h2 = Math.atan2(c.y - b.y, c.x - b.x);
  let turn = h2 - h1;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  // A CCW ring turns left (+) at convex corners.
  const convex = ringIsCcw ? turn > 0 : turn < 0;
  const angle = Math.abs(turn);
  if (!convex || angle < (15 * Math.PI) / 180) return 0;
  return Math.min(W, (W / 2) * Math.tan(angle / 2));
}

/**
 * When a section (or the whole boom) is switched off at the headland line.
 *  - noskip:    on whenever any part of the section is over unapplied ground
 *               (no skips, most overlap — typical for manual on/off)
 *  - center:    on while the section's center is over unapplied ground
 *               (balanced; the "50% overlap" setting on section control)
 *  - nooverlap: on only while the whole section is over unapplied ground
 *               (least overlap, leaves small skips)
 * In every mode a partial pass that would otherwise leave a strip unapplied
 * (e.g. the last pass across the field) is still run, as an operator would.
 */
export type ShutoffMode = 'noskip' | 'center' | 'nooverlap';

export interface MachineSpec {
  /** Programmed working width / pass spacing, meters. */
  widthM: number;
  /** Number of independently controlled sections (1 = no section control). */
  sections: number;
}

/**
 * How headland laps handle corners.
 *  - pivot:   turn on the lap line; leaves a small unapplied wedge in each
 *             field corner
 *  - overrun: keep going until the spread reaches the boundary, then turn;
 *             no corner skips but extra product in every corner
 */
export type CornerStyle = 'pivot' | 'overrun';

export interface PlanOptions {
  headlandLaps: number;
  cornerStyle: CornerStyle;
  /** Direction of the interior passes, degrees from north (0–180). */
  headingDeg: number;
  shutoff: ShutoffMode;
}

/** A strip of applied product: rectangle centered on segment a→b. */
export interface Swath {
  a: Pt;
  b: Pt;
  width: number;
  kind: 'headland' | 'pass';
}

export interface PlanResult {
  surfaceM2: number;
  appliedM2: number;
  headlandAppliedM2: number;
  passAppliedM2: number;
  /** Area inside the headland laps that the passes must cover. */
  interiorM2: number;
  swaths: Swath[];
  /** Headland lap centerlines (closed rings) for drawing. */
  headlandPaths: Ring[];
  /** Guidance line for each interior pass, for drawing. */
  passLines: [Pt, Pt][];
  passCount: number;
  /** Total distance driven with product on, meters. */
  onDistanceM: number;
}

/** Heading-independent parts of the plan, cached while trying headings. */
export interface PreparedField {
  field: Poly[];
  machine: MachineSpec;
  headlandLaps: number;
  cornerStyle: CornerStyle;
  surfaceM2: number;
  headlandPaths: Ring[];
  headlandSwaths: Swath[];
  headlandAppliedM2: number;
  interior: Poly[];
  interiorM2: number;
}

export function prepareField(
  field: Poly[],
  machine: MachineSpec,
  headlandLaps: number,
  cornerStyle: CornerStyle = 'pivot',
): PreparedField {
  const W = machine.widthM;
  const outerOnly: Poly[] = field.map((p) => ({ outer: p.outer, holes: [] }));
  const holes: Poly[] = field.flatMap((p) => p.holes.map((h) => ({ outer: h, holes: [] })));

  const headlandPaths: Ring[] = [];
  const headlandSwaths: Swath[] = [];
  let headlandAppliedM2 = 0;
  for (let lap = 1; lap <= headlandLaps; lap++) {
    const centerline = offsetPolys(outerOnly, -(lap - 0.5) * W);
    for (const p of centerline) {
      for (const raw of [p.outer, ...p.holes]) {
        const ring = simplifyRing(cleanRing(raw), 0.3);
        if (ring.length < 3) continue;
        headlandPaths.push(ring);
        // Every lap leaves an outside-corner wedge when pivoting, since the
        // lap outside it only reaches the edge of this lap's swath.
        const overrun = cornerStyle === 'overrun';
        const turnsLeft = signedArea(ring) > 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          let b = ring[(i + 1) % ring.length];
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len < 1e-3) continue;
          if (overrun) {
            const c = ring[(i + 2) % ring.length];
            const extra = cornerOverrun(a, b, c, W, turnsLeft);
            if (extra > 0) b = { x: b.x + ((b.x - a.x) / len) * extra, y: b.y + ((b.y - a.y) / len) * extra };
          }
          const onLen = Math.hypot(b.x - a.x, b.y - a.y);
          headlandSwaths.push({ a, b, width: W, kind: 'headland' });
          headlandAppliedM2 += onLen * W;
        }
      }
    }
  }

  const shrunk = headlandLaps > 0 ? offsetPolys(outerOnly, -headlandLaps * W) : outerOnly;
  const interior = holes.length ? differencePolys(shrunk, holes) : shrunk;

  return {
    field,
    machine,
    headlandLaps,
    cornerStyle,
    surfaceM2: polysArea(field),
    headlandPaths,
    headlandSwaths,
    headlandAppliedM2,
    interior,
    interiorM2: polysArea(interior),
  };
}

interface PassRun {
  passApplied: number;
  swaths: Swath[];
  passLines: [Pt, Pt][];
  passCount: number;
  onDistance: number;
}

function runPasses(prep: PreparedField, headingDeg: number, shutoff: ShutoffMode, collect: boolean): PassRun {
  const W = prep.machine.widthM;
  const n = Math.max(1, Math.round(prep.machine.sections));
  const w = W / n;
  const result: PassRun = { passApplied: 0, swaths: [], passLines: [], passCount: 0, onDistance: 0 };
  if (!prep.interior.length) return result;

  // Rotate the world so passes run along +x.
  const alpha = ((headingDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(alpha);
  const sin = Math.sin(alpha);
  const back = (p: Pt) => rotate(p, cos, -sin);
  const rings = allRings(prep.interior.map((p) => rotatePoly(p, cos, sin)));

  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) for (const p of r) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // Sample lines across each section, at most ~2 m apart.
  const samplesPerSection = Math.max(5, Math.ceil(w / 2) + 1);

  for (let yc = minY + W / 2; yc - W / 2 < maxY - 1e-6; yc += W) {
    let passMin = Infinity;
    let passMax = -Infinity;
    let passHasProduct = false;
    for (let s = 0; s < n; s++) {
      const y0 = yc - W / 2 + s * w;
      const eps = w * 1e-3;
      const sampleSets: Intervals[] = [];
      for (let k = 0; k < samplesPerSection; k++) {
        const t = k / (samplesPerSection - 1);
        sampleSets.push(lineIntervals(rings, y0 + eps + t * (w - 2 * eps)));
      }
      const any = unionIntervals(sampleSets);
      if (!any.length) continue;
      const center = lineIntervals(rings, y0 + w / 2);
      const all = sampleSets.reduce((acc, set) => intersectIntervals(acc, set));

      const on: Intervals = [];
      for (const u of any) {
        if (shutoff === 'noskip') {
          on.push(u);
          continue;
        }
        const c = intersectIntervals(center, [u]);
        const x = shutoff === 'nooverlap' ? intersectIntervals(all, [u]) : [];
        if (x.length) on.push(...x);
        else if (c.length) on.push(...c);
        else on.push(u); // partial strip nobody else will cover
      }

      for (const [x0, x1] of on) {
        const len = x1 - x0;
        if (len < 0.5) continue;
        passHasProduct = true;
        result.passApplied += len * w;
        result.onDistance += len / n;
        passMin = Math.min(passMin, x0);
        passMax = Math.max(passMax, x1);
        if (collect) {
          const ys = y0 + w / 2;
          result.swaths.push({ a: back({ x: x0, y: ys }), b: back({ x: x1, y: ys }), width: w, kind: 'pass' });
        }
      }
    }
    if (passHasProduct) {
      result.passCount++;
      if (collect) result.passLines.push([back({ x: passMin, y: yc }), back({ x: passMax, y: yc })]);
    }
  }
  return result;
}

export function planWithPrepared(prep: PreparedField, opts: Pick<PlanOptions, 'headingDeg' | 'shutoff'>): PlanResult {
  const run = runPasses(prep, opts.headingDeg, opts.shutoff, true);
  let headlandDistance = 0;
  for (const s of prep.headlandSwaths) headlandDistance += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  return {
    surfaceM2: prep.surfaceM2,
    appliedM2: prep.headlandAppliedM2 + run.passApplied,
    headlandAppliedM2: prep.headlandAppliedM2,
    passAppliedM2: run.passApplied,
    interiorM2: prep.interiorM2,
    swaths: [...prep.headlandSwaths, ...run.swaths],
    headlandPaths: prep.headlandPaths,
    passLines: run.passLines,
    passCount: run.passCount,
    onDistanceM: headlandDistance + run.onDistance,
  };
}

export function plan(field: Poly[], machine: MachineSpec, opts: PlanOptions): PlanResult {
  return planWithPrepared(prepareField(field, machine, opts.headlandLaps, opts.cornerStyle), opts);
}

/**
 * Finds the pass heading that minimizes applied acres (i.e. overlap).
 * Coarse 1° sweep, then a 0.1° refinement around the best heading.
 */
export function optimizeHeading(prep: PreparedField, shutoff: ShutoffMode): { headingDeg: number; appliedM2: number } {
  const cost = (h: number) => runPasses(prep, h, shutoff, false).passApplied;
  let best = 0;
  let bestCost = Infinity;
  for (let h = 0; h < 180; h += 1) {
    const c = cost(h);
    if (c < bestCost - 1e-6) {
      bestCost = c;
      best = h;
    }
  }
  for (let h = best - 1; h <= best + 1; h += 0.1) {
    const hh = ((h % 180) + 180) % 180;
    const c = cost(hh);
    if (c < bestCost - 1e-6) {
      bestCost = c;
      best = hh;
    }
  }
  return { headingDeg: Math.round(best * 10) / 10, appliedM2: prep.headlandAppliedM2 + bestCost };
}

// Douglas–Peucker on a closed ring. Machines don't follow GPS jitter in a
// boundary, so the headland path is smoothed before measuring it.
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length < 4) return ring;
  // Split the ring at the vertex farthest from vertex 0 and simplify both halves.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const first = simplifyLine(ring.slice(0, far + 1), tolerance);
  const second = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i];
    const b = pts[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = -1;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k].x - a.x) * dy - (pts[k].y - a.y) * dx) / len;
      if (d > maxD) {
        maxD = d;
        idx = k;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
