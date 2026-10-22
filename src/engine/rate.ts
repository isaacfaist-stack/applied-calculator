// Product math. A rate controller dispenses  rate × applied acres, where
// applied acres includes every overlap. The ticket (and the load) is usually
// figured on surface acres, so the controller rate has to be scaled by
// surface ÷ applied to come out even.
//
// Two machine factors scale what really leaves the machine:
//  - tracking: the average rate the controller actually achieves ÷ the rate
//    requested (a belt that can't keep up with speed changes averages low,
//    e.g. 0.96). The monitor's job summary shows the achieved average.
//  - bias: actual product out ÷ product the monitor reports − 1, so +0.03
//    means the machine puts out 3% more than it shows.
// Product out = requested rate × tracking × (1 + bias) × applied acres, so
// every controller setting below is divided by tracking × (1 + bias).

export interface RateInputs {
  surfaceAc: number;
  appliedAc: number;
  /** Prescribed rate per surface acre (lb/ac, gal/ac, ...). */
  targetRate: number;
  /** Product actually on the machine for this field; optional. */
  loaded?: number;
  /** Machine bias as a fraction (+0.03 = puts out 3% more than it shows). */
  bias?: number;
  /** Achieved ÷ requested rate (0.96 = averages 4% under the request). */
  tracking?: number;
}

export interface RateAdvice {
  /** applied ÷ surface − 1, e.g. 0.052 = 5.2% more acres counted than exist. */
  overlapPct: number;
  /** Product really used if the controller is left at the target rate. */
  productAtTarget: number;
  /** Product the field actually needs (target × surface). */
  productNeeded: number;
  /** Controller rate that uses exactly `productNeeded`. */
  rateForTarget: number;
  /** Percent to change the controller rate (negative = cut back). */
  rateChangePct: number;
  /** With a load entered: controller rate that empties the machine exactly. */
  rateToEmpty?: number;
  rateToEmptyChangePct?: number;
  /** With a load entered: average rate the ground actually receives. */
  groundRateIfEmptied?: number;
  /** With a load entered: product short (−) or left over (+) at target rate. */
  loadBalance?: number;
}

export function adviseRate(i: RateInputs): RateAdvice | null {
  if (!(i.surfaceAc > 0) || !(i.appliedAc > 0) || !(i.targetRate > 0)) return null;
  const out = (1 + (i.bias ?? 0)) * (i.tracking ?? 1);
  if (!(out > 0)) return null;
  const factor = i.surfaceAc / i.appliedAc / out;
  const advice: RateAdvice = {
    overlapPct: i.appliedAc / i.surfaceAc - 1,
    productAtTarget: i.targetRate * i.appliedAc * out,
    productNeeded: i.targetRate * i.surfaceAc,
    rateForTarget: i.targetRate * factor,
    rateChangePct: factor - 1,
  };
  if (i.loaded !== undefined && i.loaded > 0) {
    advice.rateToEmpty = i.loaded / i.appliedAc / out;
    advice.rateToEmptyChangePct = advice.rateToEmpty / i.targetRate - 1;
    advice.groundRateIfEmptied = i.loaded / i.surfaceAc;
    advice.loadBalance = i.loaded - advice.productAtTarget;
  }
  return advice;
}

/**
 * Why the controller setting differs from the target: the output multiplier
 * (setting ÷ target rate) split into factors that multiply back to it.
 *  - given:    product given ÷ product needed for the surface acres
 *              (ticket acres vs. boundary acres); only with a load entered
 *  - overlap:  surface ÷ applied acres
 *  - tracking: 1 ÷ achieved-rate fraction
 *  - bias:     1 ÷ (1 + bias)
 * A factor below 1 means put out less; for a density setting the change is
 * 1 ÷ factor − 1 instead of factor − 1.
 */
export interface ChangePart {
  key: 'given' | 'overlap' | 'tracking' | 'bias';
  factor: number;
}

export function splitChange(i: RateInputs): ChangePart[] {
  if (!(i.surfaceAc > 0) || !(i.appliedAc > 0) || !(i.targetRate > 0)) return [];
  const parts: ChangePart[] = [];
  if (i.loaded !== undefined && i.loaded > 0) parts.push({ key: 'given', factor: i.loaded / (i.targetRate * i.surfaceAc) });
  parts.push({ key: 'overlap', factor: i.surfaceAc / i.appliedAc });
  if (i.tracking !== undefined && i.tracking > 0 && i.tracking !== 1) parts.push({ key: 'tracking', factor: 1 / i.tracking });
  if (i.bias) parts.push({ key: 'bias', factor: 1 / (1 + i.bias) });
  return parts;
}

// ---------------------------------------------------------------------------
// Density adjustment. A dry rate controller meters by volume and converts to
// pounds with the density programmed into it:
//   volume metered = displayed rate ÷ programmed density
//   pounds on the ground = volume × true density
// So the ground actually gets  displayed rate × true ÷ programmed. Programming
// a higher density than the product really has stretches it; lower dumps it.
// The displayed (and recorded) rate stays at the prescription.

/**
 * Density to program so a controller left at `displayRate` meters product as
 * if its rate were `effectiveRate`.
 */
export function densityFor(trueDensity: number, displayRate: number, effectiveRate: number): number {
  return (trueDensity * displayRate) / effectiveRate;
}

/** What the ground actually receives per applied acre at a programmed density. */
export function actualRateAt(trueDensity: number, displayRate: number, programmedDensity: number): number {
  return (displayRate * trueDensity) / programmedDensity;
}

export interface MidFieldInputs {
  /** Planned applied acres for the whole field (from the plan). */
  plannedAppliedAc: number;
  /** Applied acres the monitor shows so far. */
  appliedSoFarAc: number;
  /** Product left on the machine. */
  remaining: number;
  /** Rate currently set on the controller. */
  currentRate: number;
  /** Machine bias as a fraction (+0.03 = puts out 3% more than it shows). */
  bias?: number;
  /** Achieved ÷ requested rate (0.96 = averages 4% under the request). */
  tracking?: number;
}

export interface MidFieldAdvice {
  remainingAc: number;
  rateToFinish: number;
  changePct: number;
  /** Product short (−) or left over (+) at the current rate. */
  balance: number;
}

export function adviseMidField(i: MidFieldInputs): MidFieldAdvice | null {
  const remainingAc = i.plannedAppliedAc - i.appliedSoFarAc;
  const out = (1 + (i.bias ?? 0)) * (i.tracking ?? 1);
  if (!(remainingAc > 0) || !(i.remaining >= 0) || !(i.currentRate > 0) || !(out > 0)) return null;
  const rateToFinish = i.remaining / remainingAc / out;
  return {
    remainingAc,
    rateToFinish,
    changePct: rateToFinish / i.currentRate - 1,
    balance: i.remaining - i.currentRate * out * remainingAc,
  };
}

// ---------------------------------------------------------------------------
// After the job: split what happened into rate tracking and a remaining gap.

export interface JobCheckInputs {
  /** Rate set on the controller (lb/ac). */
  requestedRate: number;
  /** Average applied rate from the monitor's job summary; optional. */
  achievedRate?: number;
  /** Applied acres the monitor counted. */
  appliedAc: number;
  /** The monitor's own applied total, when a job report gives it (more exact than rate × acres). */
  monitorTotal?: number;
  /** Product that really left the machine (load − leftover, by weight). */
  used: number;
  /** True product density and the density programmed in; optional. */
  trueDensity?: number;
  programmedDensity?: number;
}

export interface JobCheckResult {
  /** Achieved ÷ requested, when the achieved rate is known. */
  tracking?: number;
  /** Pounds the monitor believes it put out (achieved rate × acres). */
  monitorProduct: number;
  /** Pounds that should have left given the density setting. */
  expectedOut: number;
  /** used ÷ expected − 1: what tracking and density don't explain. */
  gap: number;
  /** Density that would explain the whole gap (when one was programmed). */
  impliedDensity?: number;
}

export function checkJob(i: JobCheckInputs): JobCheckResult | null {
  if (!(i.requestedRate > 0) || !(i.appliedAc > 0) || !(i.used > 0)) return null;
  const reported = i.monitorTotal && i.monitorTotal > 0 ? i.monitorTotal / i.appliedAc : undefined;
  const achievedRate = reported ?? (i.achievedRate && i.achievedRate > 0 ? i.achievedRate : undefined);
  const achieved = achievedRate ?? i.requestedRate;
  const monitorProduct = achieved * i.appliedAc;
  const densityRatio =
    i.trueDensity && i.programmedDensity && i.trueDensity > 0 && i.programmedDensity > 0
      ? i.trueDensity / i.programmedDensity
      : 1;
  const expectedOut = monitorProduct * densityRatio;
  return {
    tracking: achievedRate !== undefined ? achievedRate / i.requestedRate : undefined,
    monitorProduct,
    expectedOut,
    gap: i.used / expectedOut - 1,
    impliedDensity:
      i.programmedDensity && i.programmedDensity > 0 ? (i.programmedDensity * i.used) / monitorProduct : undefined,
  };
}

// ---------------------------------------------------------------------------
// Averaging several finished jobs. One job mixes machine behavior with that
// blend's density error and whatever happened that day; over several jobs the
// machine's consistent part shows through.

export interface CalibrationJob {
  id: string;
  requestedRate: number;
  achievedRate?: number;
  appliedAc: number;
  /** The monitor's applied total from a job report. */
  monitorTotal?: number;
  used: number;
  trueDensity?: number;
  programmedDensity?: number;
  /** True density came from a density cup on that load, not the ticket. */
  densityMeasured?: boolean;
  /** Plan's speed changes per mile with product on (see PlanResult). */
  changesPerMile?: number;
  /** Plan's applied acres, to compare with the monitor's. */
  predictedAc?: number;
  /** When the job was done (ms); older jobs count for less. */
  date?: number;
  /** Left out of the average. */
  excluded?: boolean;
}

/** A job's weight halves every this many days, so the log follows wear. */
export const CAL_HALF_LIFE_DAYS = 365;

export interface TrackingModel {
  /** Rate decrease with no speed changes (fraction). */
  a: number;
  /** Extra rate decrease per speed change per mile (fraction). */
  k: number;
}

export interface CalibrationAverage {
  /** Jobs counted. */
  n: number;
  /** Achieved ÷ requested over all counted jobs with a monitor average (acre-weighted). */
  tracking?: number;
  trackingN: number;
  /** Rate decrease that grows with the field's speed changes, when the jobs show it. */
  trackingModel?: TrackingModel;
  /** Total product out ÷ total expected − 1 (each job weighted by recency). */
  gap: number;
  /** Spread of the per-job gaps (weighted standard deviation). */
  gapSd: number;
  /** Uncertainty of `gap` itself (standard error). */
  gapSe: number;
  /** Jobs the gap was taken from: only cup-checked ones when there are 2+. */
  gapN: number;
  gapFromMeasured: boolean;
  /** Monitor applied acres ÷ plan applied acres − 1, over jobs that have both. */
  acreError?: number;
  acreN: number;
  /** Per-job gaps by id. */
  gaps: Record<string, number>;
  /** Jobs that don't fit the rest (only flagged with 3 or more jobs). */
  outliers: string[];
}

interface Weighted {
  w: number;
  v: number;
}

function wMean(xs: Weighted[]): number {
  const sw = xs.reduce((s, x) => s + x.w, 0);
  return sw > 0 ? xs.reduce((s, x) => s + x.w * x.v, 0) / sw : 0;
}

function wSd(xs: Weighted[], mean = wMean(xs)): number {
  const sw = xs.reduce((s, x) => s + x.w, 0);
  return sw > 0 ? Math.sqrt(xs.reduce((s, x) => s + x.w * (x.v - mean) ** 2, 0) / sw) : 0;
}

/** Effective number of jobs once weights are uneven. */
function nEff(xs: Weighted[]): number {
  const sw = xs.reduce((s, x) => s + x.w, 0);
  const sw2 = xs.reduce((s, x) => s + x.w * x.w, 0);
  return sw2 > 0 ? (sw * sw) / sw2 : 0;
}

function recency(date: number | undefined, now: number): number {
  if (!date) return 1;
  const days = Math.max(0, (now - date) / 86_400_000);
  return 0.5 ** (days / CAL_HALF_LIFE_DAYS);
}

/**
 * Fits rate decrease = a + k × speed changes per mile, weighted by acres and
 * recency. Only returned when the jobs cover different kinds of fields and
 * the slope is clearly there; otherwise a flat average is the honest answer.
 */
export function fitTracking(pts: { x: number; y: number; w: number }[]): TrackingModel | undefined {
  if (pts.length < 3) return undefined;
  const sw = pts.reduce((s, p) => s + p.w, 0);
  const mx = pts.reduce((s, p) => s + p.w * p.x, 0) / sw;
  const my = pts.reduce((s, p) => s + p.w * p.y, 0) / sw;
  const sxx = pts.reduce((s, p) => s + p.w * (p.x - mx) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + p.w * (p.x - mx) * (p.y - my), 0);
  // Need real variety in field shape (weighted spread of 2+ changes per mile).
  if (!(sxx / sw >= 4)) return undefined;
  const k = sxy / sxx;
  const a = my - k * mx;
  if (!(k > 0)) return undefined;
  const ne = (sw * sw) / pts.reduce((s, p) => s + p.w * p.w, 0);
  const resid = pts.reduce((s, p) => s + p.w * (p.y - a - k * p.x) ** 2, 0) / sw;
  const seK = Math.sqrt(resid / Math.max(ne - 2, 1) / (sxx / sw));
  if (seK > 0 && k / seK < 2) return undefined;
  return { a, k };
}

export function trackingFor(model: TrackingModel, changesPerMile: number): number {
  const decrease = Math.min(0.5, Math.max(-0.2, model.a + model.k * changesPerMile));
  return 1 - decrease;
}

export function averageCalibration(all: CalibrationJob[], now = Date.now()): CalibrationAverage | null {
  const rows = all
    .map((j) => ({ j, r: checkJob(j) }))
    .filter((x): x is { j: CalibrationJob; r: JobCheckResult } => !!x.r);
  const gaps: Record<string, number> = {};
  for (const { j, r } of rows) gaps[j.id] = r.gap;
  const counted = rows.filter((x) => !x.j.excluded);
  if (!counted.length) return null;
  const age = (j: CalibrationJob) => recency(j.date, now);

  const tracked = counted.filter((x) => x.r.tracking !== undefined);
  const tracking = tracked.length
    ? tracked.reduce((s, x) => s + x.r.tracking! * x.j.requestedRate * x.j.appliedAc * age(x.j), 0) /
      tracked.reduce((s, x) => s + x.j.requestedRate * x.j.appliedAc * age(x.j), 0)
    : undefined;
  const shaped = tracked.filter((x) => x.j.changesPerMile !== undefined);
  const trackingModel = fitTracking(
    shaped.map((x) => ({ x: x.j.changesPerMile!, y: 1 - x.r.tracking!, w: x.j.appliedAc * age(x.j) })),
  );

  // With density measured on 2+ loads, the gap from those is the machine;
  // the rest also carry each blend's density error.
  const measured = counted.filter((x) => x.j.densityMeasured);
  const gapRows = measured.length >= 2 ? measured : counted;
  const parts = gapRows.map((x) => ({ id: x.j.id, w: x.r.expectedOut * age(x.j), v: x.r.gap }));
  const gap = wMean(parts);
  const gapSd = wSd(parts, gap);
  const ne = nEff(parts);
  // Below 3 jobs the spread can't be judged; assume a typical 2% per job.
  const perJob = ne >= 3 ? gapSd : Math.max(gapSd, 0.02);
  const gapSe = perJob / Math.sqrt(Math.max(ne, 1));

  const acreRows = counted.filter((x) => x.j.predictedAc && x.j.predictedAc > 0);
  const acreError = acreRows.length
    ? wMean(acreRows.map((x) => ({ w: x.j.appliedAc * age(x.j), v: x.j.appliedAc / x.j.predictedAc! - 1 })))
    : undefined;

  // A job is an outlier when it sits well away from the average of the others.
  const all3 = counted.map((x) => ({ id: x.j.id, w: x.r.expectedOut * age(x.j), v: x.r.gap }));
  const outliers: string[] = [];
  if (all3.length >= 3) {
    for (const p of all3) {
      const others = all3.filter((o) => o !== p);
      const om = wMean(others);
      if (Math.abs(p.v - om) > Math.max(0.03, 2.5 * wSd(others, om))) outliers.push(p.id);
    }
  }
  return {
    n: counted.length,
    tracking,
    trackingN: tracked.length,
    trackingModel,
    gap,
    gapSd,
    gapSe,
    gapN: gapRows.length,
    gapFromMeasured: gapRows === measured,
    acreError,
    acreN: acreRows.length,
    gaps,
    outliers,
  };
}

// ---------------------------------------------------------------------------
// Blend density from its ingredients. Bulk volumes roughly add, so
//   1 / blend density = Σ (mass fraction × 1 / ingredient density).
// That is linear in each ingredient's specific volume (1/density), so every
// density-cup reading of a blend is one linear equation. With a weak prior per
// ingredient, a regularized least-squares fit learns your products' real
// densities and predicts new blends better than the plant's calculated value.

export interface Ingredient {
  name: string;
  /** lb/ac (or any amount; only the proportions matter). */
  rate: number;
}

export interface DensityReading {
  id: string;
  date: number;
  label?: string;
  ingredients: Ingredient[];
  /** Measured with a density cup, lb/ft³. */
  density: number;
}

/** Rough starting densities (lb/ft³); cup readings quickly take over. */
const PRIOR_DENSITY: [RegExp, number][] = [
  [/46-0-0|\burea\b/, 47],
  [/0-0-60|0-0-62|potash|\bmop\b|\bkcl\b/, 68],
  [/0-46-0|triple|\btsp\b/, 66],
  [/18-46-0|\bdap\b/, 62],
  [/11-52-0|\bmap\b/, 62],
  [/21-0-0|\bams\b|ammonium sulfate/, 63],
];
const DEFAULT_DENSITY = 62;
/** Prior uncertainty per ingredient, and a cup reading's (as fractions). */
const PRIOR_SD = 0.08;
const CUP_SD = 0.015;

export function ingredientKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function priorDensity(name: string): number {
  const key = ingredientKey(name);
  return PRIOR_DENSITY.find(([re]) => re.test(key))?.[1] ?? DEFAULT_DENSITY;
}

export interface DensityModel {
  keys: string[];
  /** Specific volume (ft³/lb) per ingredient. */
  v: number[];
  cov: number[][];
  /** Ingredients that appear in at least one reading. */
  seen: Set<string>;
  readings: number;
}

function fractions(ings: Ingredient[]): Map<string, number> {
  const total = ings.reduce((s, i) => s + Math.max(0, i.rate), 0);
  const m = new Map<string, number>();
  if (!(total > 0)) return m;
  for (const i of ings) if (i.rate > 0) m.set(ingredientKey(i.name), (m.get(ingredientKey(i.name)) ?? 0) + i.rate / total);
  return m;
}

/** Inverse of a small symmetric positive-definite matrix (Gauss–Jordan). */
function invert(a: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}

export function learnDensities(readings: DensityReading[], extra: Ingredient[] = []): DensityModel {
  const names = new Map<string, string>();
  for (const r of readings) for (const i of r.ingredients) names.set(ingredientKey(i.name), i.name);
  for (const i of extra) names.set(ingredientKey(i.name), i.name);
  const keys = [...names.keys()];
  const idx = new Map(keys.map((k, i) => [k, i]));
  const n = keys.length;
  const v0 = keys.map((k) => 1 / priorDensity(names.get(k)!));
  const A = keys.map((_, i) => keys.map((__, j) => (i === j ? 1 / (PRIOR_SD * v0[i]) ** 2 : 0)));
  const b = v0.map((v) => v / (PRIOR_SD * v) ** 2);
  const seen = new Set<string>();
  for (const r of readings) {
    if (!(r.density > 0)) continue;
    const f = fractions(r.ingredients);
    if (!f.size) continue;
    const y = 1 / r.density;
    const wt = 1 / (CUP_SD * y) ** 2;
    const row = new Array(n).fill(0);
    for (const [k, x] of f) {
      row[idx.get(k)!] = x;
      seen.add(k);
    }
    for (let i = 0; i < n; i++) {
      if (!row[i]) continue;
      b[i] += wt * row[i] * y;
      for (let j = 0; j < n; j++) A[i][j] += wt * row[i] * row[j];
    }
  }
  const cov = n ? invert(A) : [];
  const v = cov.map((row) => row.reduce((s, c, j) => s + c * b[j], 0));
  return { keys, v, cov, seen, readings: readings.length };
}

export interface DensityPrediction {
  density: number;
  /** One standard deviation, lb/ft³. */
  sd: number;
  /** Share of the blend (by weight) made of ingredients you've cup-checked. */
  coverage: number;
}

export function predictDensity(model: DensityModel, ings: Ingredient[]): DensityPrediction | null {
  const f = fractions(ings);
  if (!f.size) return null;
  const idx = new Map(model.keys.map((k, i) => [k, i]));
  const w = new Array(model.keys.length).fill(0);
  let y = 0;
  let coverage = 0;
  for (const [k, x] of f) {
    const i = idx.get(k);
    if (i === undefined) {
      y += x / priorDensity(k);
      continue;
    }
    w[i] = x;
    y += x * model.v[i];
    if (model.seen.has(k)) coverage += x;
  }
  let varY = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) varY += w[i] * model.cov[i][j] * w[j];
  const density = 1 / y;
  return { density, sd: (density * Math.sqrt(Math.max(varY, 0))) / y, coverage };
}
