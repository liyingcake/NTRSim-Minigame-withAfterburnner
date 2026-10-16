/* Functional physics audit only: no browser frame-rate or CPU profiling. */
const fs = require('node:fs');
const { NTRSimulation } = require('../simulation.js');
const nozzle = require('../nozzle.js'), thermo = require('../thermochemistry.js');
const hardware = [];
for (const extension of [0, 4, 10]) for (const oxygenValve of [0, 30, 100]) {
  const e = new NTRSimulation(); e.reset(true); e.configureNozzle({ extension }); e.setLoadout(5000, 20000);
  e.setControl('demand', 60); e.setControl('valve', 70); e.setSwitch('oxygenPump', oxygenValve > 0); e.setControl('oxygenValve', oxygenValve); e.start();
  for (let i = 0; i < 1200; i++) e.step(.05);
  hardware.push({ extension, oxygenValve, geometry: e.nozzle, engineMass: e.engineMass, dryMass: e.dryMass,
    mode: e.mode, power: e.power, coreTemperature: e.coreTemperature, pressureMPa: e.pressure, flow: e.totalFlow,
    thrust: e.thrust, isp: e.isp, acceleration: e.acceleration, wallTemperature: e.nozzleWallTemperature,
    exitPressure: e.thermoState.exitPressure, primaryH: e.thermoState.primaryFractions.H, exitH: e.thermoState.fractions.H,
    coreResidualMW: e.coreOverflowPower, nozzleResidualMW: e.nozzleEnergy.residual, cycleResidualMW: e.nozzleEnergy.cycleResidual });
}
const sample50 = [];
for (const extension of [0, 4]) for (const expansion of ['finite', 'equilibrium', 'frozen']) {
  const g = nozzle.geometry(1.4, { ...nozzle.DEFAULTS, extension });
  const s = thermo.exhaust(.4413877182848804, 0, 3273.985585321252 - 180, .18869439144500846, 562.5208004728102, 1, 'hydrogen', expansion, .8002440103741059, g);
  sample50.push({ extension, expansion, nozzleMass: g.mass, expansionRatio: g.expansion, isp: s.velocity / 9.80665,
    exitPressure: s.exitPressure, exitH: s.fractions.H, exitHFlow: s.atomicHydrogen, freezePressure: s.freezePressure, residence: s.residenceTime, energy: s.energy });
}
const report = { version: require('../version.js').version, method: 'Engine scenarios use 60 s cold startup, D1.4, demand60, main70, 5000kgH2+20000kgO2. Sample50 comparisons preserve the previous supplied inlet state, not a full flight replay.', hardware, sample50 };
fs.writeFileSync('benchmarks/v0.10-nozzle-audit.json', JSON.stringify(report, null, 2) + '\n');
console.table(hardware.map(r => ({ extension: r.extension, oxygenValve: r.oxygenValve, mass: r.geometry.mass.toFixed(1), expansion: r.geometry.expansion.toFixed(1), mode: r.mode, isp: r.isp.toFixed(1), thrust: r.thrust.toFixed(1), wall: r.wallTemperature.toFixed(0) })));
console.table(sample50.map(r => ({ extension: r.extension, mode: r.expansion, isp: r.isp.toFixed(2), H_g_s: (r.exitHFlow * 1000).toFixed(3), Pe: r.exitPressure.toFixed(2) })));
