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
  const achieved = i.achievedRate && i.achievedRate > 0 ? i.achievedRate : i.requestedRate;
  const monitorProduct = achieved * i.appliedAc;
  const densityRatio =
    i.trueDensity && i.programmedDensity && i.trueDensity > 0 && i.programmedDensity > 0
      ? i.trueDensity / i.programmedDensity
      : 1;
  const expectedOut = monitorProduct * densityRatio;
  return {
    tracking: i.achievedRate && i.achievedRate > 0 ? i.achievedRate / i.requestedRate : undefined,
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
  used: number;
  trueDensity?: number;
  programmedDensity?: number;
  /** Left out of the average. */
  excluded?: boolean;
}

export interface CalibrationAverage {
  /** Jobs counted. */
  n: number;
  /** Achieved ÷ requested over all counted jobs with a monitor average (acre-weighted). */
  tracking?: number;
  trackingN: number;
  /** Product out ÷ expected − 1 over all counted jobs (weighted by product). */
  gap: number;
  /** Spread of the per-job gaps (weighted standard deviation). */
  gapSd: number;
  /** Per-job gaps by id. */
  gaps: Record<string, number>;
  /** Jobs that don't fit the rest (only flagged with 3 or more jobs). */
  outliers: string[];
}

function weightedGap(jobs: { used: number; expected: number }[]): number {
  const used = jobs.reduce((s, j) => s + j.used, 0);
  const expected = jobs.reduce((s, j) => s + j.expected, 0);
  return expected > 0 ? used / expected - 1 : 0;
}

export function averageCalibration(all: CalibrationJob[]): CalibrationAverage | null {
  const rows = all
    .map((j) => ({ j, r: checkJob(j) }))
    .filter((x): x is { j: CalibrationJob; r: JobCheckResult } => !!x.r);
  const gaps: Record<string, number> = {};
  for (const { j, r } of rows) gaps[j.id] = r.gap;
  const counted = rows.filter((x) => !x.j.excluded);
  if (!counted.length) return null;

  const tracked = counted.filter((x) => x.j.achievedRate && x.j.achievedRate > 0);
  const tracking = tracked.length
    ? tracked.reduce((s, x) => s + x.j.achievedRate! * x.j.appliedAc, 0) /
      tracked.reduce((s, x) => s + x.j.requestedRate * x.j.appliedAc, 0)
    : undefined;

  const parts = counted.map((x) => ({ id: x.j.id, used: x.j.used, expected: x.r.expectedOut, gap: x.r.gap }));
  const gap = weightedGap(parts);
  const wSum = parts.reduce((s, p) => s + p.used, 0);
  const gapSd = Math.sqrt(parts.reduce((s, p) => s + p.used * (p.gap - gap) ** 2, 0) / wSum);

  // A job is an outlier when it sits well away from the average of the others.
  const outliers: string[] = [];
  if (parts.length >= 3) {
    for (const p of parts) {
      const others = parts.filter((o) => o !== p);
      const og = weightedGap(others);
      const ow = others.reduce((s, o) => s + o.used, 0);
      const osd = Math.sqrt(others.reduce((s, o) => s + o.used * (o.gap - og) ** 2, 0) / ow);
      if (Math.abs(p.gap - og) > Math.max(0.03, 2.5 * osd)) outliers.push(p.id);
    }
  }
  return { n: counted.length, tracking, trackingN: tracked.length, gap, gapSd, gaps, outliers };
}
