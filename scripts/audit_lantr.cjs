/* Matched deterministic v0.6/v0.7 control runs plus frozen/equilibrium bounds.
   Run from the repository: node scripts/audit_lantr.cjs */
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const thermo = require('../thermochemistry.js');
const { NTRSimulation } = require('../simulation.js');
const old = vm.createContext({});
for (const file of ['systems.js', 'simulation.js']) vm.runInContext(execFileSync('git', ['show', 'v0.6:' + file], { encoding: 'utf8' }), old, { filename: 'v0.6/' + file });
const advance = (e, seconds) => { for (let i = 0; i < Math.round(seconds / .05); i++) e.tick(.05); };
function run(Engine, oxygenValve) {
  const e = new Engine(); e.reset(true); e.setLoadout(5000, 20000);
  e.demand = 60; e.valve = 70; e.start(); advance(e, 60);
  e.oxygenPump = oxygenValve > 0; e.oxygenValve = oxygenValve; advance(e, 20);
  const row = { mode: e.mode, powerMW: e.power, coreK: e.coreTemperature, gasK: e.coreTemperature - (e.gasFilmDrop ?? 180),
    mixK: e.nozzleTemperature, chamberMPa: e.pressure, hydrogenKgS: e.flow, oxygenKgS: e.oxygenFlow, ratio: e.mixtureRatio,
    thrustKN: e.thrust, effectiveVelocityMS: e.exhaustVelocity, ispS: e.isp, chemicalMW: e.afterburnerPower };
  if (e.thermoState) {
    const s = e.thermoState, frozen = thermo.exhaust(e.flow, e.oxygenFlow, row.gasK, e.pressure, e.nozzleWallTemperature, e.scale, e.propellant, 'frozen');
    Object.assign(row, { jetVelocityMS: e.jetVelocity, pressureThrustKN: e.pressureThrust, exitK: s.exitTemperature, wallK: e.nozzleWallTemperature,
      frozenIspS: frozen.velocity / 9.80665, mixFractions: s.mixFractions, exitFractions: s.fractions, energyMW: s.energy });
  }
  return row;
}
const controls = [0, 10, 30, 60, 100].map(oxygenValve => ({ oxygenValvePercent: oxygenValve,
  v06: run(old.NTRSimulation, oxygenValve), v07: run(NTRSimulation, oxygenValve) }));
const station = [0, 1, 3, thermo.metadata.waterRatio].map(ratio => {
  const s = thermo.exhaust(10, ratio * 10, 2500, 4, 650), f = thermo.exhaust(10, ratio * 10, 2500, 4, 650, 1, 'hydrogen', 'frozen');
  return { ratio, hydrogenKgS: 10, oxygenKgS: ratio * 10, mixK: s.temperature, mixPressureMPa: s.pressure,
    thrustKN: s.velocity * s.flow / 1000, ispS: s.velocity / 9.80665, frozenIspS: f.velocity / 9.80665,
    jetVelocityMS: s.jetVelocity, pressureThrustKN: s.pressureThrust, exitK: s.exitTemperature,
    mixFractions: s.mixFractions, exitFractions: s.fractions, energyMW: s.energy };
});
const oracle = require('../benchmarks/thermo-reference.json');
const errors = oracle.cases.reduce((max, c) => {
  const s = thermo.fromEnthalpy(c.h, c.pressure, c.ratio);
  max.temperatureK = Math.max(max.temperatureK, Math.abs(s.temperature - c.temperature));
  max.massFraction = Math.max(max.massFraction, ...s.y.map((y, i) => Math.abs(y - c.y[i])));
  max.frozenDropRelative = Math.max(max.frozenDropRelative, Math.abs(s.exitDrop - c.exitDrop) / c.exitDrop);
  max.equilibriumDropRelative = Math.max(max.equilibriumDropRelative, Math.abs(s.equilibriumExitDrop - c.equilibriumExitDrop) / c.equilibriumExitDrop);
  return max;
}, { temperatureK: 0, massFraction: 0, frozenDropRelative: 0, equilibriumDropRelative: 0 });
const report = { baseline: 'v0.6', current: 'v0.7', description: 'Identical 1.4 m, 60% power, 70% main valve, 5000 kg LH2 + 20000 kg LOX, cold start 60 s then selected LOX valve for 20 s; dt .05 s. Station sweep fixes pre-expansion hot hydrogen at 2500 K and 4 MPa. Vacuum, equivalent exit pressure 2 kPa. Default equilibrium expansion is an idealized upper-performance model; frozen is a comparison bound.',
  controls, station, sampledInterpolationErrors: errors };
fs.writeFileSync('benchmarks/lantr-audit.json', JSON.stringify(report, null, 2) + '\n');
console.table(controls.map(c => ({ oxygenValve: c.oxygenValvePercent, ratio: c.v07.ratio.toFixed(3),
  oldCoreK: c.v06.coreK.toFixed(0), newCoreK: c.v07.coreK.toFixed(0), oldMixK: c.v06.mixK.toFixed(0), newMixK: c.v07.mixK.toFixed(0),
  oldIspS: c.v06.ispS.toFixed(1), newIspS: c.v07.ispS.toFixed(1), frozenIspS: c.v07.frozenIspS.toFixed(1),
  oldThrustKN: c.v06.thrustKN.toFixed(1), newThrustKN: c.v07.thrustKN.toFixed(1) })));
console.log('Sampled interpolation errors:', errors);
