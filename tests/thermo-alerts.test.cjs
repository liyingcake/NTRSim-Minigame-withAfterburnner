const { test } = require('node:test');
const assert = require('node:assert/strict');
const thermo = require('../thermochemistry.js');
const oracle = require('../benchmarks/thermo-reference.json');
const { NTRSimulation } = require('../simulation.js');
const { soundState } = require('../audio.js');
const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const lamp = (sim, id) => sim.lamps.find(l => l[0] === id);

test('offline table agrees with 132 independent Cantera states, including dissociation and expansion', () => {
  assert.equal(oracle.cases.length, 132);
  for (const c of oracle.cases) {
    const state = thermo.fromEnthalpy(c.h, c.pressure, c.ratio);
    assert.ok(Math.abs(state.temperature - c.temperature) < 40);
    assert.ok(Math.abs(state.exitDrop - c.exitDrop) / c.exitDrop < .025);
    assert.ok(Math.abs(state.equilibriumExitDrop - c.equilibriumExitDrop) / c.equilibriumExitDrop < .025);
    state.y.forEach((y, i) => assert.ok(Math.abs(y - c.y[i]) < .012));
    near(state.h, c.h, 1e-6);
  }
});

test('interpolated exhaust conserves total mass, hydrogen, oxygen and the same enthalpy budget', () => {
  const hydrogenFraction = [1, 1, 0, 0, 1.008 / 17.007, 2.016 / 18.015, 1.008 / 33.006, 2.016 / 34.014];
  for (const ratio of [0, .01, .7, 2.3, 5.5, 7.936011904761905, 8]) {
    for (const temperature of [800, 2500, 4500, 5500]) {
      const state = thermo.exhaust(10, ratio * 10, temperature, 4, 900);
      near(Object.values(state.fractions).reduce((a, b) => a + b), 1);
      const hydrogen = Object.values(state.fractions).reduce((sum, fraction, i) => sum + fraction * hydrogenFraction[i], 0) * state.flow;
      near(hydrogen, 10, 2e-6); near(state.flow - hydrogen, ratio * 10, 2e-6);
      near(state.energy.input, state.energy.kinetic + state.energy.wall + state.energy.exhaust, 1e-6);
      near(state.kineticPower, .5 * state.flow * state.jetVelocity ** 2 / 1e6);
      near(state.velocity, state.jetVelocity + state.pressureThrust * 1000 / state.flow);
      near(state.energy.available, state.energy.wall + state.energy.kinetic + state.energy.exhaustThermal + state.energy.dissociation, 1e-6);
      near(state.energy.available, state.energy.nuclearTransported + state.energy.idealChemical - state.energy.feedConditioning, 1e-6);
      assert.ok(state.heatLoad >= 0 && state.velocity >= 0);
    }
  }
});

test('equilibrium expansion recovers recombination energy; pressure thrust is separate from jet kinetic power', () => {
  const equilibrium = thermo.exhaust(10, 30, 2500, 4, 650), frozen = thermo.exhaust(10, 30, 2500, 4, 650, 1, 'hydrogen', 'frozen');
  near(equilibrium.temperature, frozen.temperature); near(equilibrium.energy.input, frozen.energy.input);
  assert.ok(equilibrium.velocity > frozen.velocity); assert.ok(equilibrium.dissociationPower < frozen.dissociationPower);
  assert.ok(equilibrium.pressureThrust > 0 && equilibrium.velocity > equilibrium.jetVelocity);
  assert.ok(equilibrium.fractions.H2O > frozen.fractions.H2O);
  assert.ok(equilibrium.energy.kinetic < .5 * equilibrium.flow * equilibrium.velocity ** 2 / 1e6);
  const idle = thermo.exhaust(0, 0, 293, 0); near(idle.velocity, 0); near(idle.pressureThrust, 0);
});

test('complete LANTR pipeline agrees with independent Cantera HP/SP calculations', () => {
  assert.equal(oracle.lantr.length, 4);
  for (const c of oracle.lantr) {
    const s = thermo.exhaust(10, 10 * c.ratio, 2500, 4, 650);
    assert.ok(Math.abs(s.temperature - c.mixK) < 15);
    assert.ok(Math.abs(s.velocity / 9.80665 / c.ispS - 1) < .005);
    Object.values(s.fractions).forEach((y, i) => assert.ok(Math.abs(y - c.exitY[i]) < .003));
  }
});

test('water has the correct elemental ratio and real high-temperature dissociation products', () => {
  const water = thermo.exhaust(45, 0, 3200, 4, 650, 1, 'water');
  assert.ok(water.radicals > 0 && water.hydrogen > 0 && water.oxygen > 0);
  assert.ok(water.steam < 45); near(water.flow, 45); near(water.chemicalPower, 0);
  const cool = thermo.atTemperature(1500, 4e6, thermo.metadata.waterRatio), hot = thermo.atTemperature(4000, 4e6, thermo.metadata.waterRatio);
  assert.ok(hot.y[5] < cool.y[5]); assert.ok(hot.y[4] > cool.y[4]);
});

test('oxygen valve closing has no temperature or velocity discontinuity', () => {
  const zero = thermo.exhaust(10, 0, 2500, 4), tiny = thermo.exhaust(10, 1e-8, 2500, 4);
  near(zero.temperature, tiny.temperature, 1e-4); near(zero.velocity, tiny.velocity, 1e-4);
});

test('temperature has no 4800 K ceiling; boundary continuation is explicitly marked', () => {
  for (const temperature of [4799, 4800, 4801, 5000, 5500]) {
    const direct = thermo.atTemperature(temperature, 1e6, 2), inverse = thermo.fromEnthalpy(direct.h, 1e6, 2);
    near(inverse.temperature, temperature, 1e-6); assert.equal(inverse.outside, false);
  }
  const high = thermo.atTemperature(6500, 1e6, 2);
  assert.equal(high.temperature, 6500); assert.ok(high.outside); assert.ok(Number.isFinite(high.exitDrop));
});

test('smooth wall heat transfer stays bounded, vanishes with flow and cools the gas', () => {
  const s = thermo.atTemperature(3500, 1e6, 2);
  near(thermo.wallTransfer(s, 0, 500, 1, 16), 0);
  const heat = thermo.wallTransfer(s, 30, 500, 1, 16);
  assert.ok(heat > 0 && heat < 30 * s.cp * 3000 * .08);
  const insulated = thermo.exhaust(10, 20, 2500, 4, 6000), cooled = thermo.exhaust(10, 20, 2500, 4, 500);
  assert.ok(cooled.temperature < insulated.temperature); assert.ok(cooled.velocity < insulated.velocity);
});

test('nozzle wall temperature integrates the heat balance and cools after the gas stops', () => {
  const e = new NTRSimulation(), before = e.nozzleWallTemperature, dt = .05;
  e.tick(dt);
  near((e.nozzleWallTemperature - before) * e.wallHeatCapacity / dt / 1e6, e.wallEnergyRate, 1e-7);
  near(e.wallEnergyRate, e.nozzleHeatLoad - e.nozzleCoolingPower - e.nozzleRadiationPower);
  e.scram(); e.valve = 0; for (let i = 0; i < 2400; i++) e.tick(.05);
  assert.ok(e.nozzleWallTemperature < before); assert.ok(e.nozzleRadiationPower >= 0);
});

test('temperature and pressure annunciators use yellow, orange and exact red thresholds', () => {
  const e = new NTRSimulation();
  for (const [temperature, color, level] of [[3049, 'green', 0], [3050, 'yellow', 1], [3150, 'orange', 2], [3250, 'red', 3]]) {
    e.coreTemperature = temperature; assert.equal(lamp(e, 'tempHigh')[3], color); assert.equal(lamp(e, 'tempHigh')[5], level);
  }
  for (const [pressure, color] of [[6.5, 'yellow'], [7, 'orange'], [7.5, 'red']]) { e.pressure = pressure; assert.equal(lamp(e, 'pressureHigh')[3], color); }
});

test('healthy monitors are green, sensor drift yellow, failed cooling red, required OFF systems amber', () => {
  const e = new NTRSimulation(); assert.equal(lamp(e, 'thermalFault')[3], 'green'); assert.ok(lamp(e, 'thermalFault')[4]);
  e.injectFault('sensor'); assert.equal(lamp(e, 'thermalFault')[3], 'yellow'); e.injectFault('cooling'); assert.equal(lamp(e, 'thermalFault')[3], 'red');
  e.repairAll(); e.pump = e.cooling = e.autoProtection = false;
  for (const id of ['pump', 'cooling', 'auto']) { assert.equal(lamp(e, id)[3], 'amber'); assert.equal(lamp(e, id)[5], 1); }
  for (const id of ['pumpOff', 'coolingOff', 'protectionOff']) assert.ok(e.alarms.includes(id));
  e.reset(true); e.pump = e.cooling = false; assert.equal(lamp(e, 'pump')[5], 0); assert.equal(lamp(e, 'cooling')[5], 0);
});

test('ACK re-arms when an existing warning escalates, and sound state carries urgency', () => {
  const e = new NTRSimulation(); e.coreTemperature = 3050; e.refreshAlarms(); e.acknowledge();
  e.coreTemperature = 3150; e.refreshAlarms(); assert.equal(e.acknowledged, false); e.acknowledge();
  e.coreTemperature = 3250; e.refreshAlarms(); assert.equal(e.acknowledged, false);
  assert.equal(soundState(e).levels.tempHigh, 3); e.acknowledge(); e.coreTemperature = 3200; e.refreshAlarms(); assert.ok(e.acknowledged);
});
