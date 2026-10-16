/* Shared vacuum flight integration and bounded flight-data recorder.
   Sampling is 2 Hz in simulated time, independent of rendering / time warp. */
(function (root) {
  'use strict';
  const BASE_DRY_MASS = 5000, G0 = 9.80665;
  const engineMass = diameter => 1000 + 9000 * (Math.max(.8, Math.min(2.4, diameter)) ** 2 - .8 ** 2) / (2.4 ** 2 - .8 ** 2);
  const COLUMNS = Object.freeze(['time_s', 'thrust_kN', 'power_MW', 'pressure_MPa', 'core_K', 'mix_K', 'wall_K', 'mainFlow_kg_s', 'oxygenFlow_kg_s',
    'isp_s', 'effectiveVelocity_m_s', 'acceleration_m_s2', 'deltaV_m_s', 'mass_kg', 'mainRemaining_kg', 'oxygenRemaining_kg',
    'powerCommand_pct', 'mainValve_pct', 'oxygenValve_pct', 'mainPump', 'oxygenPump', 'cooling', 'autoProtection', 'integrity_pct',
    'regenerative_MW', 'pressureThrust_kN', 'hMassFraction', 'mainFlowCommand_kg_s', 'oxygenFlowCommand_kg_s', 'powerCommand_MW',
    'mixHMassFraction', 'exitHMassFraction', 'primaryH_kg_s', 'mixH_kg_s', 'exitH_kg_s', 'primaryGas_K', 'exit_K', 'exitPressure_Pa',
    'throatArea_m2', 'exitArea_m2', 'expansionRatio', 'halfAngle_deg', 'extension_m', 'nozzleMass_kg', 'residence_ms', 'freezePressure_Pa',
    'coreHeatToPropellant_MW', 'coreCooling_MW', 'coreStored_MW', 'coreHeatResidual_MW']);
  let sequence = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  function configuration(e) {
    return { engineModel: e.engineModel, diameter: e.diameter, ratedPower: e.ratedPower, propellant: e.propellant,
      baseDryMass: BASE_DRY_MASS, engineMass: e.engineMass, baseEngineMass: e.baseEngineMass, nozzleMass: e.nozzleMass, nozzle: { ...e.nozzle }, payload: e.payload, dryMass: e.dryMass, mass: e.mass,
      mainPropellant: e.fuel, oxygen: e.oxygen, mainTankInitial: e.fuelCapacity, oxygenTankInitial: e.initialOxygen,
      tankVolume: e.tankState.usedVolume, demand: e.demand, mainValve: e.valve, oxygenValve: e.oxygenValve,
      mainPump: e.pump, oxygenPump: e.oxygenPump, cooling: e.cooling, autoProtection: e.autoProtection,
      integrity: e.integrity, mode: e.mode, consumedFuel: e.consumed, consumedOxygen: e.oxygenConsumed };
  }
  class FlightRecorder {
    constructor() {
      this.id = 'flight-' + Date.now().toString(36) + '-' + (++sequence); this.started = false; this.finished = false;
      this.elapsed = this.deltaV = this.distance = this.peakAcceleration = this.impulse = this.nozzleMass = this.burnTime = this.peakThrust = 0;
      this.peakShipThrustWeight = this.peakEngineThrustWeight = 0; this.first = []; this.last = []; this.operations = []; this.droppedOperations = 0; this.nextSample = .5;
    }
    begin(engine) {
      if (this.started) return;
      this.started = true; this.initial = configuration(engine); this.capture(engine);
    }
    operation(action, value, source = 'operator', detail = '') {
      if (this.finished) return;
      if (this.operations.length >= 10000) { this.operations.shift(); this.droppedOperations++; }
      this.operations.push({ time: this.elapsed, wallTime: Date.now(), phase: this.started ? 'FLIGHT' : 'PREPARING', action, value, source, detail });
    }
    capture(e) {
      const row = [this.elapsed, e.thrust, e.power, e.pressure, e.measuredTemperature, e.nozzleTemperature, e.nozzleWallTemperature,
        e.flow, e.oxygenFlow, e.isp, e.exhaustVelocity, e.thrust * 1000 / e.mass, this.deltaV, e.mass, e.fuel, e.oxygen,
        e.demand, e.valve, e.oxygenValve, +e.pump, +e.oxygenPump, +e.cooling, +e.autoProtection, e.integrity,
        e.regenerativePower, e.pressureThrust, e.thermoState?.primaryFractions?.H || 0, e.commandedFlow, e.commandedOxygenFlow, e.ratedPower * e.demand / 100,
        e.thermoState?.mixFractions?.H || 0, e.thermoState?.fractions?.H || 0, (e.thermoState?.primaryFractions?.H || 0) * e.flow,
        (e.thermoState?.mixFractions?.H || 0) * e.totalFlow, e.products.atomicHydrogen, e.thermoState?.primaryTemperature || 20,
        e.thermoState?.exitTemperature || 20, e.thermoState?.exitPressure || 0, e.nozzle.throatArea, e.nozzle.exitArea, e.nozzle.expansion,
        e.nozzle.halfAngle, e.nozzle.extension, e.nozzleMass, (e.thermoState?.residenceTime || 0) * 1000, e.thermoState?.freezePressure || 0,
        e.coreHeatToPropellant, e.coreCoolingPower, e.coreStoredPower, e.coreOverflowPower];
      if (this.elapsed <= 60 + 1e-8 && this.first.at(-1)?.[0] !== this.elapsed) this.first.push(row);
      if (this.last.at(-1)?.[0] !== this.elapsed) this.last.push(row);
      while (this.last.length && this.last[0][0] < this.elapsed - 120 - 1e-8) this.last.shift();
    }
    step(e, beforeMass, dt) {
      if (!this.started || this.finished) return;
      const previous = this.deltaV, acceleration = e.stepThrust * 1000 / ((beforeMass + e.mass) / 2);
      this.deltaV += acceleration * dt; this.distance += (previous + this.deltaV) * .5 * dt; this.elapsed += dt;
      this.impulse += e.stepThrust * dt; this.nozzleMass += e.stepTotalFlow * dt;
      if (e.stepThrust > .001) this.burnTime += dt;
      this.peakAcceleration = Math.max(this.peakAcceleration, acceleration); this.peakThrust = Math.max(this.peakThrust, e.stepThrust);
      this.peakShipThrustWeight = Math.max(this.peakShipThrustWeight, acceleration / G0);
      this.peakEngineThrustWeight = Math.max(this.peakEngineThrustWeight, e.stepThrust * 1000 / (e.engineMass * G0));
      if (this.elapsed + 1e-8 >= this.nextSample) { this.capture(e); this.nextSample += .5; }
    }
    snapshot(engine, meta = {}) {
      // Include the exact report instant even when it falls between samples.
      const first = this.first.map(row => [...row]), last = this.last.filter(row => row[0] >= this.elapsed - 120 - 1e-8).map(row => [...row]);
      const savedFirst = this.first, savedLast = this.last; this.first = first; this.last = last; this.capture(engine); this.first = savedFirst; this.last = savedLast;
      return freeze({ formatVersion: 1, id: this.id, ...meta, createdAt: Date.now(), initial: clone(this.initial || configuration(engine)), final: configuration(engine),
        stats: { elapsed: this.elapsed, deltaV: this.deltaV, distance: this.distance, totalImpulse: this.impulse, peakThrust: this.peakThrust,
          meanThrust: this.elapsed > 0 ? this.impulse / this.elapsed : 0, burnMeanThrust: this.burnTime > 0 ? this.impulse / this.burnTime : 0,
          burnTime: this.burnTime, nozzleMass: this.nozzleMass, effectiveIsp: this.nozzleMass > 0 ? this.impulse * 1000 / (this.nozzleMass * G0) : 0,
          peakAcceleration: this.peakAcceleration, peakShipThrustWeight: this.peakShipThrustWeight, peakEngineThrustWeight: this.peakEngineThrustWeight,
          finalThrust: engine.thrust, finalAcceleration: engine.thrust * 1000 / engine.mass },
        telemetry: { columns: COLUMNS, interval: .5, first60: first, last120: last }, operations: clone(this.operations), droppedOperations: this.droppedOperations });
    }
  }
  const api = { BASE_DRY_MASS, engineMass, FlightRecorder, COLUMNS, freeze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_FLIGHT = api;
})(typeof window !== 'undefined' ? window : globalThis);
