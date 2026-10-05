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
