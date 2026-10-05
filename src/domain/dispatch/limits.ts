import { DomainError } from '../errors.ts';
export type PressureLimits = { minPressureKpa: number; maxPressureKpa: number; minMoles?: number; maxMoles?: number };
export type ViolationReason = 'minimum-pressure' | 'maximum-pressure' | 'minimum-inventory' | 'maximum-inventory';
export type LimitState = { safe: boolean; violated: ViolationReason[] };

export const VIOLATION_REASON_ORDER: ViolationReason[] = ['minimum-pressure', 'maximum-pressure', 'minimum-inventory', 'maximum-inventory'];

export function evaluateLimits(pressureKpa: number, totalMoles: number, limits: PressureLimits): LimitState {
  if (!(limits.minPressureKpa < limits.maxPressureKpa)) throw new DomainError('INVALID_PRESSURE_ENVELOPE', 'Minimum pressure must be below maximum pressure', 422, { limits });
  const violated: ViolationReason[] = [];
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
