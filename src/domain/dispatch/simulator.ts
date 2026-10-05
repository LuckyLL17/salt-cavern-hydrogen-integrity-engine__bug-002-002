import { DomainError } from '../errors.ts';
import { normalizeComposition } from '../inventory/composition.ts';
import { normalizeTimeline } from './timeline.ts';
import { solveGasState } from './eos.ts';
import {
  crossingFraction,
  evaluateLimits,
  VIOLATION_REASON_ORDER,
  type PressureLimits,
  type ViolationReason,
} from './limits.ts';
import { COMPONENTS, type Composition, type ScheduleStep } from '../types.ts';

export type DispatchState = { pressureKpa: number; temperatureK: number; totalMoles: number; composition?: Composition };
export type DispatchLimits = PressureLimits & { cavernVolumeM3: number; thermalRelaxationPerHour: number; maxStepHours?: number };
export type DispatchPoint = { hour: number; pressureKpa: number; temperatureK: number; totalMoles: number; composition: Composition; safe: boolean; violated: ViolationReason[] };
export type DispatchResult = { trajectory: DispatchPoint[]; firstViolation: DispatchPoint | null; violations: DispatchPoint[]; completedHour: number };

type PhaseSample = { fraction: number; hour: number; pressureKpa: number; temperatureK: number; totalMoles: number; composition: Composition };

type PhaseContext = {
  startHour: number;
  dtHours: number;
  startMoles: number;
  startTemperatureK: number;
  startComposition: Composition;
  targetTemperatureK: number;
  flowMolPerSecond: number;
  inletComposition: Composition;
  relaxationPerHour: number;
  cavernVolumeM3: number;
};

const ROOT_TOLERANCE = 1e-10;
const SIMULTANEOUS_HOUR_TOLERANCE = 1e-9;
const PHASE_GRID_DIVISIONS = 64;

function mixComposition(base: Composition, baseMoles: number, incoming: Composition, incomingMoles: number): Composition {
  const total = baseMoles + incomingMoles;
  if (total <= 0) return base;
  return Object.fromEntries(COMPONENTS.map((key) => [key, (base[key] * baseMoles + incoming[key] * incomingMoles) / total])) as Composition;
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function phaseMoles(phase: PhaseContext, fraction: number): number {
  const deltaMoles = phase.flowMolPerSecond * phase.dtHours * 3600;
  return Math.max(0, phase.startMoles + deltaMoles * fraction);
}

function phaseTemperature(phase: PhaseContext, fraction: number): number {
  const dt = phase.dtHours * fraction;
  return phase.targetTemperatureK + (phase.startTemperatureK - phase.targetTemperatureK) * Math.exp(-phase.relaxationPerHour * dt);
}

function phaseComposition(phase: PhaseContext, fraction: number): Composition {
  if (phase.flowMolPerSecond < 0) return phase.startComposition;
  const added = Math.max(0, phase.flowMolPerSecond * phase.dtHours * 3600 * fraction);
  return mixComposition(phase.startComposition, phase.startMoles, phase.inletComposition, added);
}

/**
 * State anywhere inside an injection, withdrawal or standstill substep is sampled with the
 * exact continuous laws: inventory drifts linearly with flow, temperature relaxes towards
 * the inlet/ambient temperature exponentially, and pressure always comes from the equation
 * of state. Pressure and temperature are never linearly interpolated between step ends, so
 * long steps cannot produce early or late boundary alarms.
 */
function samplePhase(phase: PhaseContext, fraction: number): PhaseSample {
  const u = clampFraction(fraction);
  const totalMoles = phaseMoles(phase, u);
  const temperatureK = phaseTemperature(phase, u);
  const composition = phaseComposition(phase, u);
  const gas = solveGasState(totalMoles, phase.cavernVolumeM3, temperatureK, composition);
  return { fraction: u, hour: phase.startHour + phase.dtHours * u, pressureKpa: gas.pressureKpa, temperatureK, totalMoles, composition };
}

function bisectRoot(evaluate: (fraction: number) => number, left: number, right: number): number {
  let lo = left;
  let hi = right;
  let fLo = evaluate(lo);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    if (Math.abs(hi - lo) <= ROOT_TOLERANCE) break;
    const mid = (lo + hi) / 2;
    const fMid = evaluate(mid);
    if (fMid === 0) return mid;
    if ((fLo < 0 && fMid < 0) || (fLo > 0 && fMid > 0)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return clampFraction((lo + hi) / 2);
}

/**
 * Pressure along one phase is smooth with at most one turning point: inventory drifts
 * monotonically with flow while temperature approaches its target exponentially. Knots are
 * nevertheless collected from derivative sign changes over a fine grid so that a transient
 * pressure dip or peak inside a long injection, withdrawal or heat-exchange phase cannot be
 * hidden when both step endpoints happen to be safe.
 */
function pressureKnots(pressureAt: (fraction: number) => number): number[] {
  const eps = Math.max(1e-9, ROOT_TOLERANCE);
  const knots = new Set<number>([0, 1]);
  const derivative = (fraction: number): number => {
    const lo = Math.max(0, fraction - eps);
    const hi = Math.min(1, fraction + eps);
    return hi === lo ? 0 : (pressureAt(hi) - pressureAt(lo)) / (hi - lo);
  };
  let previousFraction = 0;
  let previousDerivative = derivative(0);
  for (let index = 1; index <= PHASE_GRID_DIVISIONS; index += 1) {
    const fraction = index / PHASE_GRID_DIVISIONS;
    const currentDerivative = derivative(fraction);
    if (previousDerivative !== 0 && ((previousDerivative < 0 && currentDerivative > 0) || (previousDerivative > 0 && currentDerivative < 0))) {
      knots.add(clampFraction(bisectRoot(derivative, previousFraction, fraction)));
    }
    if (currentDerivative !== 0) {
      previousDerivative = currentDerivative;
      previousFraction = fraction;
    }
  }
  return [...knots].sort((a, b) => a - b);
}

function addPressureCrossing(events: Map<ViolationReason, number>, reason: ViolationReason, pressureAt: (fraction: number) => number, boundary: number, lo: number, hi: number, goAbove: boolean): void {
  const valueLo = pressureAt(lo);
  const valueHi = pressureAt(hi);
  if (goAbove) {
    if (valueLo > boundary || valueHi <= boundary) return;
    const fraction = valueLo === boundary ? lo : bisectRoot((f) => pressureAt(f) - boundary, lo, hi);
    events.set(reason, Math.min(events.get(reason) ?? 1, fraction));
  } else {
    if (valueLo < boundary || valueHi >= boundary) return;
    const fraction = valueLo === boundary ? lo : bisectRoot((f) => boundary - pressureAt(f), lo, hi);
    events.set(reason, Math.min(events.get(reason) ?? 1, fraction));
  }
}

/**
 * Returns the first onset fraction within the phase for every envelope constraint. A
 * constraint already violated at the phase start is reported at fraction 0; excursions that
 * begin and end inside the phase are caught via interior turning points.
 */
function collectPhaseCrossings(phase: PhaseContext, limits: PressureLimits): Map<ViolationReason, number> {
  const pressureAt = (fraction: number) => samplePhase(phase, fraction).pressureKpa;
  const events = new Map<ViolationReason, number>();

  // Inventory bounds are affine in flow time, giving exact crossing fractions.
  const endMoles = phaseMoles(phase, 1);
  if (limits.minMoles !== undefined) {
    if (phase.startMoles < limits.minMoles) events.set('minimum-inventory', 0);
    else if (endMoles < limits.minMoles) events.set('minimum-inventory', crossingFraction(phase.startMoles, endMoles, limits.minMoles));
  }
  if (limits.maxMoles !== undefined) {
    if (phase.startMoles > limits.maxMoles) events.set('maximum-inventory', 0);
    else if (endMoles > limits.maxMoles) events.set('maximum-inventory', crossingFraction(phase.startMoles, endMoles, limits.maxMoles));
  }

  // Pressure crossings are bisected with the EOS over every monotonic segment.
  const startPressure = pressureAt(0);
  if (startPressure < limits.minPressureKpa) events.set('minimum-pressure', 0);
  if (startPressure > limits.maxPressureKpa) events.set('maximum-pressure', 0);
  for (let index = 0, knots = pressureKnots(pressureAt); index + 1 < knots.length; index += 1) {
    addPressureCrossing(events, 'minimum-pressure', pressureAt, limits.minPressureKpa, knots[index], knots[index + 1], false);
    addPressureCrossing(events, 'maximum-pressure', pressureAt, limits.maxPressureKpa, knots[index], knots[index + 1], true);
  }
  return events;
}

function crossingPoint(phase: PhaseContext, fraction: number, reasons: ViolationReason[]): DispatchPoint {
  const sample = samplePhase(phase, fraction);
  return {
    hour: sample.hour,
    pressureKpa: sample.pressureKpa,
    temperatureK: sample.temperatureK,
    totalMoles: sample.totalMoles,
    composition: sample.composition,
    safe: false,
    violated: reasons,
  };
}

type Simulation = {
  totalMoles: number;
  temperatureK: number;
  composition: Composition;
  hour: number;
  activeReasons: Set<ViolationReason>;
  trajectory: DispatchPoint[];
  rawViolations: DispatchPoint[];
};

/** Advances one continuous phase (flowing interval or standstill gap) as fixed substeps. */
function advancePhase(simulation: Simulation, descriptor: Omit<PhaseContext, 'startMoles' | 'startTemperatureK' | 'startComposition'>, limits: DispatchLimits, maxStepHours: number): void {
  const subCount = Math.max(1, Math.ceil(descriptor.dtHours / maxStepHours));
  const nominalDt = descriptor.dtHours / subCount;
  for (let index = 0; index < subCount; index += 1) {
    const subStartHour = descriptor.startHour + index * nominalDt;
    // The last substep closes exactly on the phase boundary so the final state and the
    // stage switch land on startHour + durationHours without accumulated float drift.
    const subDt = index + 1 === subCount ? descriptor.startHour + descriptor.dtHours - subStartHour : nominalDt;
    const subPhase: PhaseContext = {
      ...descriptor,
      startHour: subStartHour,
      dtHours: subDt,
      startMoles: simulation.totalMoles,
      startTemperatureK: simulation.temperatureK,
      startComposition: simulation.composition,
    };
    const requestedMol = -subPhase.flowMolPerSecond * subDt * 3600;
    if (subPhase.flowMolPerSecond < 0 && simulation.totalMoles + subPhase.flowMolPerSecond * subDt * 3600 < -1e-8) {
      throw new DomainError('WITHDRAWAL_EXCEEDS_INVENTORY', 'Scheduled withdrawal exceeds available gas', 409, { hour: subPhase.startHour, availableMol: simulation.totalMoles, requestedMol });
    }

    const raw = collectPhaseCrossings(subPhase, limits);
    const onsets: Array<{ fraction: number; reasons: ViolationReason[] }> = [];
    for (const [reason, fraction] of raw) {
      // A fraction-0 onset is a new crossing only for a constraint that was safe at the
      // previous step end; a still-active violation must not re-alarm at the stage switch.
      if (fraction === 0 && simulation.activeReasons.has(reason)) continue;
      const group = onsets.find((item) => Math.abs(item.fraction - fraction) <= ROOT_TOLERANCE);
      if (group) group.reasons.push(reason);
      else onsets.push({ fraction, reasons: [reason] });
    }
    onsets.sort((a, b) => a.fraction - b.fraction);
    for (const onset of onsets) {
      onset.reasons.sort((a, b) => VIOLATION_REASON_ORDER.indexOf(a) - VIOLATION_REASON_ORDER.indexOf(b));
      simulation.rawViolations.push(crossingPoint(subPhase, onset.fraction, onset.reasons));
    }

    // State advances to the true substep end regardless of any earlier onset; the discrete
    // step-end result must never replace the interpolated crossing record.
    const endSample = samplePhase(subPhase, 1);
    const endStatus = evaluateLimits(endSample.pressureKpa, endSample.totalMoles, limits);
    simulation.totalMoles = endSample.totalMoles;
    simulation.temperatureK = endSample.temperatureK;
    simulation.composition = endSample.composition;
    simulation.hour = subStartHour + subDt;
    simulation.activeReasons = new Set(endStatus.violated);
    simulation.trajectory.push({
      hour: simulation.hour,
      pressureKpa: endSample.pressureKpa,
      temperatureK: endSample.temperatureK,
      totalMoles: endSample.totalMoles,
      composition: { ...endSample.composition },
      safe: endStatus.safe,
      violated: [...endStatus.violated],
    });
  }
}

/** Merge constraint onsets that occur at the same physical time into one trigger set. */
function mergeSimultaneous(points: DispatchPoint[]): DispatchPoint[] {
  const merged: DispatchPoint[] = [];
  for (const point of points) {
    const bucket = merged.find((item) => Math.abs(item.hour - point.hour) <= SIMULTANEOUS_HOUR_TOLERANCE);
    if (!bucket) {
      merged.push({ ...point, violated: [...point.violated], composition: { ...point.composition } });
      continue;
    }
    if (point.hour < bucket.hour) {
      bucket.hour = point.hour;
      bucket.pressureKpa = point.pressureKpa;
      bucket.temperatureK = point.temperatureK;
      bucket.totalMoles = point.totalMoles;
      bucket.composition = point.composition;
    }
    for (const reason of point.violated) if (!bucket.violated.includes(reason)) bucket.violated.push(reason);
  }
  for (const point of merged) {
    point.violated.sort((a, b) => VIOLATION_REASON_ORDER.indexOf(a) - VIOLATION_REASON_ORDER.indexOf(b));
    point.safe = false;
  }
  merged.sort((a, b) => (a.hour - b.hour) || VIOLATION_REASON_ORDER.indexOf(a.violated[0]) - VIOLATION_REASON_ORDER.indexOf(b.violated[0]));
  return merged;
}

export function simulateDispatch(initial: DispatchState, steps: ScheduleStep[], limits: DispatchLimits, maxStepHours = limits.maxStepHours ?? 0.25): DispatchResult {
  if (!(maxStepHours > 0) || !(limits.cavernVolumeM3 > 0) || !(limits.thermalRelaxationPerHour >= 0)) throw new DomainError('INVALID_DISPATCH_LIMITS', 'Step size, volume and thermal relaxation are invalid', 422);
  const timeline = normalizeTimeline(steps);
  const composition = initial.composition ?? { H2: 1, CH4: 0, N2: 0, CO2: 0 };
  const initialGas = solveGasState(initial.totalMoles, limits.cavernVolumeM3, initial.temperatureK, composition);
  const initialStatus = evaluateLimits(initialGas.pressureKpa, initial.totalMoles, limits);
  const initialPoint: DispatchPoint = { hour: 0, pressureKpa: initialGas.pressureKpa, temperatureK: initial.temperatureK, totalMoles: initial.totalMoles, composition: { ...composition }, safe: initialStatus.safe, violated: [...initialStatus.violated] };
  const simulation: Simulation = {
    totalMoles: initial.totalMoles,
    temperatureK: initial.temperatureK,
    composition,
    hour: 0,
    activeReasons: new Set(initialStatus.violated),
    trajectory: [initialPoint],
    rawViolations: initialStatus.safe ? [] : [{ ...initialPoint, composition: { ...composition } }],
  };

  for (const interval of timeline) {
    // Standstill heat exchange between scheduled intervals follows the same continuous
    // relaxation law and is searched for interior and start crossings like any other phase.
    if (interval.startHour > simulation.hour + 1e-10) {
      advancePhase(simulation, {
        startHour: simulation.hour,
        dtHours: interval.startHour - simulation.hour,
        targetTemperatureK: initial.temperatureK,
        flowMolPerSecond: 0,
        inletComposition: simulation.composition,
        relaxationPerHour: limits.thermalRelaxationPerHour,
        cavernVolumeM3: limits.cavernVolumeM3,
      }, limits, maxStepHours);
    }
    // Absorb sub-nanosecond scheduling drift so trajectory timestamps stay strictly ordered.
    simulation.hour = interval.startHour;

    const inlet = normalizeComposition(interval.inletComposition ?? simulation.composition);
    advancePhase(simulation, {
      startHour: interval.startHour,
      dtHours: interval.durationHours,
      targetTemperatureK: interval.inletTemperatureK,
      flowMolPerSecond: interval.flowMolPerSecond,
      inletComposition: inlet,
      relaxationPerHour: limits.thermalRelaxationPerHour,
      cavernVolumeM3: limits.cavernVolumeM3,
    }, limits, maxStepHours);
  }

  const violations = mergeSimultaneous(simulation.rawViolations);
  return {
    trajectory: simulation.trajectory,
    firstViolation: violations.length ? violations[0] : null,
    violations,
    completedHour: simulation.hour,
  };
}
