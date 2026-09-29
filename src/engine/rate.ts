// Product math. A rate controller dispenses  rate × applied acres, where
// applied acres includes every overlap. The ticket (and the load) is usually
// figured on surface acres, so the controller rate has to be scaled by
// surface ÷ applied to come out even.
//
// Machine bias: most machines don't put out exactly what the monitor says.
// bias = actual product out ÷ product the monitor reports − 1, so +0.03 means
// the machine puts out 3% more than it shows. Every controller setting below
// is divided by (1 + bias) so the product that really leaves the machine
// comes out even.

export interface RateInputs {
  surfaceAc: number;
  appliedAc: number;
  /** Prescribed rate per surface acre (lb/ac, gal/ac, ...). */
  targetRate: number;
  /** Product actually on the machine for this field; optional. */
  loaded?: number;
  /** Machine bias as a fraction (+0.03 = puts out 3% more than it shows). */
  bias?: number;
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
  const out = 1 + (i.bias ?? 0);
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
  const out = 1 + (i.bias ?? 0);
  if (!(remainingAc > 0) || !(i.remaining >= 0) || !(i.currentRate > 0) || !(out > 0)) return null;
  const rateToFinish = i.remaining / remainingAc / out;
  return {
    remainingAc,
    rateToFinish,
    changePct: rateToFinish / i.currentRate - 1,
    balance: i.remaining - i.currentRate * out * remainingAc,
  };
}
