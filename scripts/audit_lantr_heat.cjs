/* Functional physics comparisons, with fixed boundary states. No browser,
   frame-rate measurements or performance profiling. */
const fs = require('node:fs');
const thermo = require('../thermochemistry.js'), nozzle = require('../nozzle.js');
const { NTRSimulation } = require('../simulation.js'), reliability = require('../reliability.js');
const release = require('../version.js');
const fixed = { hydrogenKgS: 10, gasK: 2800, pressureMPa: 4, wallK: 650, diameter: 1.4, regenerativeMW: 0 };
function run(settings = {}, ratio = 2, gasK = fixed.gasK, pressure = fixed.pressureMPa) {
  const g = nozzle.geometry(1.4, { ...nozzle.DEFAULTS, ...settings });
  const s = thermo.exhaust(10, 10 * ratio, gasK, pressure, 650, 1, 'hydrogen', 'finite', 0, g);
  return { ratio, gasK, pressureMPa: pressure, geometry: g, mixK: s.temperature, beforeWallK: s.wallInletTemperature,
    mixPressurePa: s.pressure * 1e6, mixEnthalpy: thermo.atTemperature(s.temperature, s.pressure * 1e6, ratio).h,
    ispS: s.velocity / 9.80665, jetVelocity: s.jetVelocity, effectiveVelocity: s.velocity, thrustKN: s.flow * s.velocity / 1000,
    acceleration: s.flow * s.velocity / (5000 + 3320.3125 + g.mass + 5000 + 20000), // Same tank masses, different nozzle mass.
    exitPressure: s.exitPressure, heatMW: s.heatLoad, combustion: s.combustion, chemicalMW: s.chemicalPower,
    exitSpeciesKgS: Object.fromEntries(Object.entries(s.fractions).map(([k, y]) => [k, y * s.flow])),
    kineticConversion: s.energy.kinetic / s.energy.available, energy: s.energy, mixFractions: s.mixFractions };
}
const mixtures = [0, .5, 2, 4, thermo.metadata.waterRatio].map(r => run({}, r));
const expansion = [20, 50, 100, 240, 500].map(expansionRatio => run({ expansionRatio }));
const angle = [8, 12, 20, 35].map(halfAngle => run({ halfAngle }));
const temperatures = [.5, 4, 10, 15].map(p => run({}, thermo.metadata.waterRatio, 2800, p));
function engineRun(settings = {}, oxygenValve = 30) {
  const e = new NTRSimulation(); e.reset(true); e.configureNozzle(settings); e.setLoadout(5000, 20000); e.oxygenPump = oxygenValve > 0; e.oxygenValve = oxygenValve; e.start();
  for (let i = 0; i < 1200; i++) e.step(.05);
  return { oxygenValve, time: e.time, mode: e.mode, coreK: e.coreTemperature, gasK: e.thermoState.primaryTemperature,
    pressureMPa: e.pressure, hydrogenKgS: e.flow, oxygenKgS: e.oxygenFlow, ratio: e.mixtureRatio,
    mixK: e.nozzleTemperature, wallK: e.nozzleWallTemperature, ispS: e.isp, thrustKN: e.thrust,
    heatMW: e.nozzleHeatLoad, coolingMW: e.nozzleCoolingPower, radiationMW: e.nozzleRadiationPower,
    regenerativeMW: e.regenerativePower, combustion: e.thermoState.combustion, chemicalMW: e.afterburnerPower,
    kineticMW: e.kineticPower, energy: e.nozzleEnergy, geometry: e.nozzle, mass: e.mass, acceleration: e.acceleration, deltaV: e.flight.deltaV };
}
const hardware = [0, 30, 100].map(oxygenValve => engineRun({}, oxygenValve));
const controlledExpansion = [20, 50, 100, 240, 500].map(expansionRatio => engineRun({ expansionRatio }));
const controlledAngle = [8, 12, 20, 35].map(halfAngle => engineRun({ halfAngle }));
const report = { version: release.version, fixed, method: 'Finite freezing, fixed hydrogen inlet T/P/flow and wall T. Only the indicated geometric input or mixture ratio varies. Geometry changes wall area and residence as well as expansion and mass. Hardware and controlled sweeps separately use 60s cold startup, demand60/main70, 5000kgH2+20000kgO2; sweeps use oxygenValve30 and otherwise default settings. These are game-model results, not validated engine data.', mixtures, expansion, angle, temperatures, hardware, controlledExpansion, controlledAngle,
  pressureProbabilities: [15, 15.5, 16, 17, 20, 25].map(p => ({ pressureMPa: p, probabilityPer5s: reliability.probability(p) })), damageBands: reliability.DAMAGE_BANDS };
const file = `benchmarks/${release.label}-lantr-heat-audit.json`;
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.table(mixtures.map(s => ({ ratio: s.ratio.toFixed(3), mixK: s.mixK.toFixed(1), oxygenInWaterPct: (s.combustion.oxygenToWater * 100).toFixed(2), energyReleasedPct: (s.combustion.releasedFraction * 100).toFixed(2), jetMW: s.energy.kinetic.toFixed(2), conversionPct: (100 * s.kineticConversion).toFixed(2), isp: s.ispS.toFixed(2) })));
console.table(expansion.map(s => ({ expansion: s.geometry.expansion.toFixed(1), mass: s.geometry.mass.toFixed(1), isp: s.ispS.toFixed(2), acceleration: s.acceleration.toFixed(3), heatMW: s.heatMW.toFixed(2) })));
console.table(angle.map(s => ({ angle: s.geometry.halfAngle, mass: s.geometry.mass.toFixed(1), isp: s.ispS.toFixed(2), axial: s.geometry.divergenceEfficiency.toFixed(5) })));
console.table(hardware.map(s => ({ oxygenValve: s.oxygenValve, mode: s.mode, isp: s.ispS.toFixed(2), mixK: s.mixK.toFixed(0), wallK: s.wallK.toFixed(0), heatMW: s.heatMW.toFixed(2), radiationMW: s.radiationMW.toFixed(3) })));
console.table(controlledExpansion.map(s => ({ expansion: s.geometry.expansionRatio, isp: s.ispS.toFixed(2), mass: s.geometry.mass.toFixed(1), acceleration: s.acceleration.toFixed(3), deltaV: s.deltaV.toFixed(2), mode: s.mode })));
console.table(controlledAngle.map(s => ({ angle: s.geometry.halfAngle, isp: s.ispS.toFixed(2), mass: s.geometry.mass.toFixed(1), acceleration: s.acceleration.toFixed(3), deltaV: s.deltaV.toFixed(2), mode: s.mode })));
console.log(file);
