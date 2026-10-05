import { DomainError } from '../errors.ts';
export type PressureLimits = { minPressureKpa: number; maxPressureKpa: number; minMoles?: number; maxMoles?: number };
export type LimitState = { safe: boolean; violated: Array<'minimum-pressure' | 'maximum-pressure' | 'minimum-inventory' | 'maximum-inventory'> };
export function evaluateLimits(pressureKpa: number, totalMoles: number, limits: PressureLimits): LimitState {
  if (!(limits.minPressureKpa < limits.maxPressureKpa)) throw new DomainError('INVALID_PRESSURE_ENVELOPE', 'Minimum pressure must be below maximum pressure', 422, { limits });
  const violated: LimitState['violated'] = [];
  if (pressureKpa < limits.minPressureKpa) violated.push('minimum-pressure');
  if (pressureKpa > limits.maxPressureKpa) violated.push('maximum-pressure');
  if (limits.minMoles !== undefined && totalMoles < limits.minMoles) violated.push('minimum-inventory');
  if (limits.maxMoles !== undefined && totalMoles > limits.maxMoles) violated.push('maximum-inventory');
  return { safe: violated.length === 0, violated };
}
export function crossingFraction(before: number, after: number, boundary: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(boundary)) throw new DomainError('INVALID_CROSSING_INPUT', 'Crossing interpolation inputs must be finite', 422);
  if ((before - boundary) * (after - boundary) > 0 || before === after) return 1;
  return Math.max(0, Math.min(1, (boundary - before) / (after - before)));
}
export type LimitCrossing = { fraction: number; violated: LimitState['violated'] };
export type LimitSample = { pressureKpa: number; totalMoles: number };
export type ContinuousCrossing = { elapsedHours: number; violated: LimitState['violated'] };
function boundaryDistance(value: number, boundary: number): number { return value - boundary; }
function touchesBoundary(before: number, after: number, boundary: number, below: boolean): boolean { return below ? before >= boundary && after < boundary : before <= boundary && after > boundary; }
function stableFraction(value: number): number { return Math.max(0, Math.min(1, value)); }
function addCandidate(list: Array<{ fraction: number; reason: LimitState['violated'][number]; distance: number }>, before: number, after: number, boundary: number | undefined, reason: LimitState['violated'][number], below: boolean): void {
  if (boundary === undefined || !touchesBoundary(before, after, boundary, below)) return;
  list.push({ fraction: stableFraction(crossingFraction(before, after, boundary)), reason, distance: Math.abs(boundaryDistance(after, boundary)) });
}
export function firstLimitCrossing(beforePressureKpa: number, afterPressureKpa: number, beforeMoles: number, afterMoles: number, limits: PressureLimits): LimitCrossing | null {
  const candidates: Array<{ fraction: number; reason: LimitState['violated'][number]; distance: number }> = [];
  const check = (before: number, after: number, boundary: number | undefined, reason: LimitState['violated'][number], below: boolean) => {
    if (boundary === undefined) return;
    const startDistance = boundaryDistance(before, boundary);
    const endDistance = boundaryDistance(after, boundary);
    if (!touchesBoundary(before, after, boundary, below)) return;
    const fraction = stableFraction(crossingFraction(before, after, boundary));
    addCandidate(candidates, before, after, boundary, reason, below);
    if (endDistance === 0 && startDistance !== 0) candidates[candidates.length - 1].distance = 0;
  };
  check(beforePressureKpa, afterPressureKpa, limits.minPressureKpa, 'minimum-pressure', true);
  check(beforePressureKpa, afterPressureKpa, limits.maxPressureKpa, 'maximum-pressure', false);
  check(beforeMoles, afterMoles, limits.minMoles, 'minimum-inventory', true);
  check(beforeMoles, afterMoles, limits.maxMoles, 'maximum-inventory', false);
  if (beforePressureKpa < limits.minPressureKpa || beforePressureKpa > limits.maxPressureKpa) candidates.push({ fraction: 0, reason: beforePressureKpa < limits.minPressureKpa ? 'minimum-pressure' : 'maximum-pressure', distance: 0 });
  if (limits.minMoles !== undefined && beforeMoles < limits.minMoles) candidates.push({ fraction: 0, reason: 'minimum-inventory', distance: 0 });
  if (limits.maxMoles !== undefined && beforeMoles > limits.maxMoles) candidates.push({ fraction: 0, reason: 'maximum-inventory', distance: 0 });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.fraction - b.fraction || b.distance - a.distance || a.reason.localeCompare(b.reason));
  const first = candidates[0].fraction;
  return { fraction: first, violated: candidates.filter((item) => Math.abs(item.fraction - first) <= 1e-10).map((item) => item.reason) };
}

const CROSSING_BISECTION_ITERATIONS = 60;
const CROSSING_EXTREMUM_ITERATIONS = 60;

function bisectEntry(violates: (elapsedHours: number) => boolean, startHours: number, endHours: number): number {
  let low = startHours;
  let high = endHours;
  for (let iteration = 0; iteration < CROSSING_BISECTION_ITERATIONS; iteration += 1) {
    const mid = low + (high - low) / 2;
    if (violates(mid)) high = mid; else low = mid;
  }
  return high;
}

function extremumHours(value: (elapsedHours: number) => number, startHours: number, endHours: number, maximize: boolean): number {
  let low = startHours;
  let high = endHours;
  for (let iteration = 0; iteration < CROSSING_EXTREMUM_ITERATIONS; iteration += 1) {
    const firstThird = low + (high - low) / 3;
    const secondThird = high - (high - low) / 3;
    const keepLower = maximize ? value(firstThird) >= value(secondThird) : value(firstThird) <= value(secondThird);
    if (keepLower) high = secondThird; else low = firstThird;
  }
  return (low + high) / 2;
}

// Locates the first envelope violation along a continuously advancing state trajectory.
// `sample(elapsedHours)` must return the exact pressure and inventory state at that offset
// within [0, spanHours]. When `monotone` is false the pressure trajectory may turn inside
// the interval (e.g. heat exchange opposing inventory change), so interior extrema are
// inspected as well; inventory always advances linearly and needs no interior check.
// `slopeEpsilonHours` should be small against the fastest dynamic scale of the trajectory.
export function firstContinuousCrossing(sample: (elapsedHours: number) => LimitSample, spanHours: number, limits: PressureLimits, options: { monotone?: boolean; slopeEpsilonHours?: number } = {}): ContinuousCrossing | null {
  if (!(spanHours > 0) || !Number.isFinite(spanHours)) throw new DomainError('INVALID_CROSSING_SPAN', 'Crossing search span must be positive and finite', 422, { spanHours });
  const cache = new Map<number, LimitSample>();
  const at = (elapsedHours: number): LimitSample => {
    const cached = cache.get(elapsedHours);
    if (cached) return cached;
    const evaluated = sample(elapsedHours);
    cache.set(elapsedHours, evaluated);
    return evaluated;
  };
  const start = at(0);
  const startStatus = evaluateLimits(start.pressureKpa, start.totalMoles, limits);
  if (!startStatus.safe) return { elapsedHours: 0, violated: startStatus.violated };
  const monotone = options.monotone ?? false;
  const pressureAt = (elapsedHours: number): number => at(elapsedHours).pressureKpa;
  // With at most one interior turning point, the endpoint slope signs decide whether an
  // interior dip or peak can exist at all, so the extremum search only runs then.
  let interiorDip = false;
  let interiorPeak = false;
  if (!monotone) {
    const slopeEpsilon = Math.min(options.slopeEpsilonHours ?? spanHours * 1e-6, spanHours / 2);
    const slopeStart = (pressureAt(slopeEpsilon) - pressureAt(0)) / slopeEpsilon;
    const slopeEnd = (pressureAt(spanHours) - pressureAt(spanHours - slopeEpsilon)) / slopeEpsilon;
    interiorDip = slopeStart < 0 && slopeEnd > 0;
    interiorPeak = slopeStart > 0 && slopeEnd < 0;
  }
  const candidates: Array<{ elapsedHours: number; reason: LimitState['violated'][number] }> = [];
  const inspect = (value: (elapsedHours: number) => number, boundary: number | undefined, below: boolean, reason: LimitState['violated'][number], interior: boolean): void => {
    if (boundary === undefined) return;
    const violates = (reading: number): boolean => below ? reading < boundary : reading > boundary;
    if (violates(value(spanHours))) {
      candidates.push({ elapsedHours: bisectEntry((elapsedHours) => violates(value(elapsedHours)), 0, spanHours), reason });
      return;
    }
    if (!interior) return;
    const peak = extremumHours(value, 0, spanHours, !below);
    if (violates(value(peak))) candidates.push({ elapsedHours: bisectEntry((elapsedHours) => violates(value(elapsedHours)), 0, peak), reason });
  };
  inspect(pressureAt, limits.minPressureKpa, true, 'minimum-pressure', interiorDip);
  inspect(pressureAt, limits.maxPressureKpa, false, 'maximum-pressure', interiorPeak);
  inspect((elapsedHours) => at(elapsedHours).totalMoles, limits.minMoles, true, 'minimum-inventory', false);
  inspect((elapsedHours) => at(elapsedHours).totalMoles, limits.maxMoles, false, 'maximum-inventory', false);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.elapsedHours - b.elapsedHours);
  const first = candidates[0].elapsedHours;
  const tolerance = Math.max(1e-12, spanHours * 1e-9);
  return { elapsedHours: first, violated: candidates.filter((candidate) => candidate.elapsedHours - first <= tolerance).map((candidate) => candidate.reason) };
}
