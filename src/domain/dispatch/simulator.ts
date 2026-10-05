import { DomainError } from '../errors.ts';
import { normalizeComposition } from '../inventory/composition.ts';
import { normalizeTimeline } from './timeline.ts';
import { solveGasState } from './eos.ts';
import { evaluateLimits, firstContinuousCrossing, type PressureLimits } from './limits.ts';
import { COMPONENTS, type Composition, type ScheduleStep } from '../types.ts';
export type DispatchState = { pressureKpa: number; temperatureK: number; totalMoles: number; composition?: Composition };
export type DispatchLimits = PressureLimits & { cavernVolumeM3: number; thermalRelaxationPerHour: number; maxStepHours?: number };
export type DispatchPoint = { hour: number; pressureKpa: number; temperatureK: number; totalMoles: number; composition: Composition; safe: boolean; violated: string[] };
export type DispatchResult = { trajectory: DispatchPoint[]; firstViolation: DispatchPoint | null; completedHour: number };

type AdvanceSample = { pressureKpa: number; temperatureK: number; totalMoles: number; composition: Composition };

function mixComposition(base: Composition, baseMoles: number, incoming: Composition, incomingMoles: number): Composition {
  const total = baseMoles + incomingMoles;
  if (total <= 0) return base;
  return Object.fromEntries((['H2', 'CH4', 'N2', 'CO2'] as const).map((key) => [key, (base[key] * baseMoles + incoming[key] * incomingMoles) / total])) as Composition;
}

export function simulateDispatch(initial: DispatchState, steps: ScheduleStep[], limits: DispatchLimits, maxStepHours = limits.maxStepHours ?? 0.25): DispatchResult {
  if (!(maxStepHours > 0) || !(limits.cavernVolumeM3 > 0) || !(limits.thermalRelaxationPerHour >= 0)) throw new DomainError('INVALID_DISPATCH_LIMITS', 'Step size, volume and thermal relaxation are invalid', 422);
  const timeline = normalizeTimeline(steps);
  let state = structuredClone(initial);
  let hour = 0;
  let composition = state.composition ?? { H2: 1, CH4: 0, N2: 0, CO2: 0 };
  const first = solveGasState(state.totalMoles, limits.cavernVolumeM3, state.temperatureK, composition);
  state.pressureKpa = first.pressureKpa;
  const initialLimits = evaluateLimits(state.pressureKpa, state.totalMoles, limits);
  const trajectory: DispatchPoint[] = [{ hour, ...state, composition: { ...composition }, safe: initialLimits.safe, violated: initialLimits.violated }];
  let firstViolation = initialLimits.safe ? null : trajectory[0];
  const relaxation = limits.thermalRelaxationPerHour;
  const locateCrossing = (sample: (elapsedHours: number) => AdvanceSample, spanHours: number, startHour: number, monotone: boolean, slopeEpsilonHours?: number): void => {
    const crossing = firstContinuousCrossing((elapsedHours) => {
      const point = sample(elapsedHours);
      return { pressureKpa: point.pressureKpa, totalMoles: point.totalMoles };
    }, spanHours, limits, { monotone, slopeEpsilonHours });
    if (!crossing) return;
    const at = sample(crossing.elapsedHours);
    firstViolation = { hour: startHour + crossing.elapsedHours, pressureKpa: at.pressureKpa, temperatureK: at.temperatureK, totalMoles: at.totalMoles, composition: { ...at.composition }, safe: false, violated: crossing.violated };
  };
  for (const interval of timeline) {
    if (interval.startHour > hour) {
      const gap = interval.startHour - hour;
      const gapMoles = state.totalMoles;
      const gapStartTemperature = state.temperatureK;
      const gapComposition = composition;
      const gapSample = (elapsedHours: number): AdvanceSample => {
        const temperatureK = initial.temperatureK + (gapStartTemperature - initial.temperatureK) * Math.exp(-relaxation * elapsedHours);
        return { pressureKpa: solveGasState(gapMoles, limits.cavernVolumeM3, temperatureK, gapComposition).pressureKpa, temperatureK, totalMoles: gapMoles, composition: gapComposition };
      };
      const gapEnd = gapSample(gap);
      const gapStatus = evaluateLimits(gapEnd.pressureKpa, gapMoles, limits);
      if (!gapStatus.safe && !firstViolation) locateCrossing(gapSample, gap, hour, true);
      state = { pressureKpa: gapEnd.pressureKpa, temperatureK: gapEnd.temperatureK, totalMoles: gapMoles };
      hour = interval.startHour;
      trajectory.push({ hour, ...state, composition: { ...composition }, safe: gapStatus.safe, violated: gapStatus.violated });
    }
    const inlet = normalizeComposition(interval.inletComposition ?? composition);
    const count = Math.max(1, Math.ceil(interval.durationHours / maxStepHours));
    const dt = interval.durationHours / count;
    const moleRatePerHour = interval.flowMolPerSecond * 3600;
    for (let index = 0; index < count; index += 1) {
      const startHour = hour;
      const startMoles = state.totalMoles;
      const startTemperature = state.temperatureK;
      const startComposition = composition;
      const deltaMoles = moleRatePerHour * dt;
      const nextMoles = startMoles + deltaMoles;
      if (nextMoles < -1e-8) throw new DomainError('WITHDRAWAL_EXCEEDS_INVENTORY', 'Scheduled withdrawal exceeds available gas', 409, { hour, availableMol: state.totalMoles, requestedMol: -deltaMoles });
      const added = Math.max(0, deltaMoles);
      const mixed = interval.flowMolPerSecond >= 0 ? mixComposition(startComposition, startMoles, inlet, added) : startComposition;
      const nextTemperature = startTemperature + (interval.inletTemperatureK - startTemperature) * (1 - Math.exp(-relaxation * dt));
      const gas = solveGasState(Math.max(0, nextMoles), limits.cavernVolumeM3, nextTemperature, mixed);
      const nextHour = index + 1 === count ? interval.endHour : startHour + dt;
      const status = evaluateLimits(gas.pressureKpa, Math.max(0, nextMoles), limits);
      const point: DispatchPoint = { hour: nextHour, pressureKpa: gas.pressureKpa, temperatureK: nextTemperature, totalMoles: Math.max(0, nextMoles), composition: mixed, safe: status.safe, violated: status.violated };
      if (!firstViolation) {
        const temperatureActive = relaxation > 0 && interval.inletTemperatureK !== startTemperature;
        const compositionActive = interval.flowMolPerSecond > 0 && COMPONENTS.some((key) => Math.abs(inlet[key] - startComposition[key]) > 1e-12);
        const monotone = !(temperatureActive && interval.flowMolPerSecond !== 0) && !compositionActive;
        if (!status.safe || !monotone) {
          const dynamicScales = [dt];
          if (relaxation > 0) dynamicScales.push(1 / relaxation);
          if (interval.flowMolPerSecond !== 0 && startMoles > 0) dynamicScales.push(startMoles / Math.abs(moleRatePerHour));
          const slopeEpsilonHours = Math.min(...dynamicScales) * 1e-6;
          const stepSample = (elapsedHours: number): AdvanceSample => {
            const moles = Math.max(0, startMoles + moleRatePerHour * elapsedHours);
            const temperatureK = interval.inletTemperatureK + (startTemperature - interval.inletTemperatureK) * Math.exp(-relaxation * elapsedHours);
            const stepComposition = interval.flowMolPerSecond > 0 ? mixComposition(startComposition, startMoles, inlet, moleRatePerHour * elapsedHours) : startComposition;
            return { pressureKpa: solveGasState(moles, limits.cavernVolumeM3, temperatureK, stepComposition).pressureKpa, temperatureK, totalMoles: moles, composition: stepComposition };
          };
          locateCrossing(stepSample, dt, startHour, monotone, slopeEpsilonHours);
        }
      }
      state = { pressureKpa: gas.pressureKpa, temperatureK: nextTemperature, totalMoles: Math.max(0, nextMoles) };
      composition = mixed;
      hour = nextHour;
      trajectory.push(point);
    }
  }
  return { trajectory, firstViolation, completedHour: hour };
}
