const { test } = require('node:test');
const assert = require('node:assert/strict');
const reliability = require('../reliability.js'), thermo = require('../thermochemistry.js'), nozzle = require('../nozzle.js');
const { NTRSimulation, TELEMETRY_LIMITS } = require('../simulation.js');
const { soundState } = require('../audio.js');
const reference = require('../benchmarks/v0.11-lantr-heat-reference.json');
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} vs ${b}`);
const plume = (oxygen = 20, propellant = 'hydrogen', settings = {}) => thermo.exhaust(10, oxygen, 2800, 4, 650, 1, propellant, 'finite', 0, nozzle.geometry(1.4, { ...nozzle.DEFAULTS, ...settings }));

test('current geometric H2 / LANTR / water gas-side heat is exactly half the previous bounded transfer', () => {
  for (const [propellant, oxygen] of [['hydrogen', 0], ['hydrogen', 20], ['hydrogen', 79], ['water', 0]]) {
    const g = nozzle.geometry(1.4), s = plume(oxygen, propellant);
    const inlet = thermo.atTemperature(s.wallInletTemperature, s.pressure * 1e6, propellant === 'water' ? thermo.metadata.waterRatio : oxygen / 10);
    const old = thermo.wallTransfer(inlet, s.flow, 650, g.surface / nozzle.geometry(1.4).surface, propellant === 'water' ? 45 : 14.8) / 1e6;
    near(s.heatLoad, old / 2); near(s.wallHeatScale, .5); near(s.energy.residual, 0, 1e-6);
  }
  near(thermo.exhaust(10, 20, 2800, 4, 650).wallHeatScale, 1); // Archived reference calibration.
});

test('oxygen-to-water and O2 remaining are atom-mass fractions, distinct from net energy release', () => {
  for (const oxygen of [5, 20, 40, 10 * thermo.metadata.waterRatio]) {
    const s = plume(oxygen), b = s.combustion;
    near(b.oxygenToWater, Math.min(1, s.steam * thermo.metadata.waterRatio / (1 + thermo.metadata.waterRatio) / oxygen));
    near(b.oxygenRemaining, s.oxygen / oxygen);
    near(b.releasedFraction, s.chemicalPower / s.energy.idealChemical);
    near(s.energy.dissociation, s.energy.idealChemical - s.chemicalPower, 1e-6);
    near(b.mixedChemicalPower + b.recombinationPower, s.chemicalPower, 1e-6);
    assert.ok(b.oxygenToWater + b.oxygenRemaining <= 1 + 1e-6);
    near(s.kineticPower, .5 * s.flow * s.jetVelocity ** 2 / 1e6, 1e-6);
    near(s.energy.available, s.energy.kinetic + s.energy.wall + s.energy.exhaustThermal + s.energy.dissociation, 1e-6);
  }
  assert.ok(plume(20).combustion.releasedFraction > .999);
  assert.ok(plume(79.36).combustion.releasedFraction < .9);
  for (const s of [plume(0), plume(0, 'water'), thermo.exhaust(0, 0, 293, 0)]) {
    assert.equal(s.combustion.active, false); assert.ok(Object.values(s.combustion).filter(v => typeof v === 'number').every(Number.isFinite));
  }
});

test('3900 K is not a cap: mixture enthalpy and pressure determine the equilibrium temperature', () => {
  const g = nozzle.geometry(1.4), r = thermo.metadata.waterRatio;
  const low = thermo.exhaust(10, 10 * r, 2800, 4, 650, 1, 'hydrogen', 'finite', 0, g);
  const high = thermo.exhaust(10, 10 * r, 2800, 15, 650, 1, 'hydrogen', 'finite', 0, g);
  assert.ok(low.temperature < 3900 && high.temperature > 3900);
  assert.ok(high.mixDissociationPower > 0); near(high.energy.residual, 0, 1e-6);
});

test('mixed-gas HP lookup agrees with nine independent Cantera states including near-stoichiometric dissociation', () => {
  assert.equal(reference.cases.length, 9);
  for (const c of reference.cases) {
    const s = thermo.fromEnthalpy(c.enthalpy, c.pressurePa, c.ratio);
    assert.ok(Math.abs(s.temperature - c.canteraK) < 20);
    for (const [i, name] of thermo.metadata.species.entries()) assert.ok(Math.abs(s.y[i] - c.speciesY[name]) < .015);
  }
});

test('wall radiation uses emissivity, exposed area and fourth-power temperature independently of the heat reduction', () => {
  for (const extension of [0, 4]) {
    const e = new NTRSimulation(); e.reset(true); e.configureNozzle({ extension }); e.cooling = false; e.nozzleWallTemperature = 1200;
    const before = e.nozzleWallTemperature, g = e.nozzle; e.step(.05);
    const expected = .8 * 5.670374419e-8 * (.17 * g.baseSurface + g.extensionSurface) * (1200 ** 4 - 293 ** 4) / 1e6;
    near(e.nozzleRadiationPower, expected);
    near((e.nozzleWallTemperature - before) * e.wallHeatCapacity / .05 / 1e6, -e.nozzleCoolingPower - expected, 1e-6);
    assert.ok(e.nozzleWallTemperature < before);
  }
});

test('overpressure hazard starts at 15.5 MPa, grows smoothly, and damage bands widen with successful incidents', () => {
  assert.equal(TELEMETRY_LIMITS.pressure, 20); near(reliability.probability(15.49), 0); near(reliability.probability(15.5), .08);
  assert.ok(reliability.probability(16) < reliability.probability(20));
  assert.ok(reliability.probability(20) < 1);
  for (const [strike, low, high] of [[1, .005, .05], [2, .05, .25], [3, .2, .7], [10, .2, .7]]) {
    near(reliability.damage(strike, 0), low); near(reliability.damage(strike, 1), high);
  }
  near(reliability.damage(1, .5), .0275);
});

function rig() { const e = new NTRSimulation({ random: (() => { let i = 0; return () => [0, 0, .5][i++ % 3]; })() }); e.pressure = 20; e.flow = 10; return e; }
test('five simulated seconds trigger one draw; repeated damage progresses yellow, orange, red and disables the pump', () => {
  const e = rig(); e.checkPressureFaults(4.99); assert.equal(e.pressureFaultChecks, 0);
  e.checkPressureFaults(.01); assert.equal(e.pressureFaultChecks, 1); near(e.damageOf('pump'), .0275); assert.equal(e.faultLevel('pump'), 1);
  assert.ok(e.fuelPumpEfficiency > .97); e.checkPressureFaults(5); assert.equal(e.faultLevel('pump'), 2);
  e.checkPressureFaults(5); e.checkPressureFaults(5); assert.equal(e.faultLevel('pump'), 3); assert.equal(e.fuelPumpEfficiency, 0);
  const draws = e.flight.operations.filter(o => o.action === 'pressureCheck'); assert.equal(draws.length, 4);
  assert.equal(draws[0].value.key, 'pump'); near(draws[0].value.damage, .0275); assert.equal(draws[3].value.level, 3);
  assert.equal(e.lamps.find(l => l[0] === 'pumpFault')[3], 'red'); assert.equal(e.lamps.find(l => l[0] === 'pumpFault')[5], 3);
  e.repairAll(); near(e.damageOf('pump'), 0); assert.equal(e.pressureFailures, 4);
});

test('safe pressure resets continuous exposure; unsuccessful draws do not escalate damage bands', () => {
  const e = new NTRSimulation({ random: () => .999 }); e.flow = 10; e.pressure = 16;
  e.checkPressureFaults(3); e.pressure = 15; e.checkPressureFaults(1); near(e.pressureFaultTimer, 0);
  e.pressure = 16; e.checkPressureFaults(4); assert.equal(e.pressureFaultChecks, 0); e.checkPressureFaults(1);
  assert.equal(e.pressureFaultChecks, 1); assert.equal(e.pressureFailures, 0); assert.equal(e.faults.size, 0);
  assert.equal(e.flight.operations.find(o => o.action === 'pressureCheck').value.hit, false);
  e.pressure = 20; e.flow = 0; e.checkPressureFaults(5); assert.equal(e.pressureFaultChecks, 1);
});

test('reliability timing and damage are independent of simulation substep partition', () => {
  const a = rig(), b = rig(); for (let i = 0; i < 100; i++) a.checkPressureFaults(.05); for (let i = 0; i < 5; i++) b.checkPressureFaults(1);
  assert.equal(a.pressureFaultChecks, b.pressureFaultChecks); near(a.damageOf('pump'), b.damageOf('pump'));
});

test('a real small-throat startup can exceed 15.5 MPa; auto protection trips before the five-second hazard', () => {
  for (const auto of [true, false]) {
    const e = new NTRSimulation({ random: () => .01 }); e.reset(true); e.configureNozzle({ throatScale: .25 });
    e.valve = 100; e.demand = 90; e.autoProtection = auto; e.start();
    for (let i = 0; i < 600; i++) e.step(.05);
    if (auto) { assert.equal(e.mode, 'SCRAM'); assert.equal(e.pressureFaultChecks, 0); assert.ok(e.events.some(v => v.message.includes('腔室压力超限'))); }
    else { assert.ok(e.pressureFailures > 0); assert.ok(e.damageOf('pump') > 0); }
  }
});

test('partial cooling and LOX pump damage derate their functions and alert escalation re-arms ACK', () => {
  const e = new NTRSimulation(); e.reset(true); e.setLoadout(5000, 20000); e.oxygenPump = true; e.oxygenValve = 30; e.start();
  for (let i = 0; i < 600; i++) e.step(.05);
  e.faultDamage.cooling = .03; e.faults.add('cooling'); e.faultDamage.oxygenPump = .03; e.faults.add('oxygenPump');
  e.step(.05); assert.ok(e.regenerativePower > 0); near(e.commandedOxygenFlow, e.ratedOxygenFlow * .3 * .97);
  assert.equal(e.lamps.find(l => l[0] === 'thermalFault')[3], 'yellow'); e.acknowledge();
  e.faultDamage.oxygenPump = .2; e.refreshAlarms(); assert.equal(e.acknowledged, false); assert.equal(soundState(e).levels.pumpFault, 2);
  e.faultDamage.oxygenPump = .7; e.step(.05); near(e.oxygenFlow, 0); assert.match(e.oxygenInterlock, /失效/);
  assert.equal(e.lamps.find(l => l[0] === 'oxygenPump')[3], 'red');
});

test('flight archives include the heat budget, oxygen reaction diagnostics and component damage', () => {
  const e = new NTRSimulation(); e.tick(1); const r = e.flight.snapshot(e), row = r.telemetry.last120.at(-1), cols = r.telemetry.columns;
  for (const [key, value] of [['gasToWall_MW', e.nozzleHeatLoad], ['nozzleRadiation_MW', e.nozzleRadiationPower], ['jetVelocity_m_s', e.jetVelocity], ['pressureChecks', e.pressureFaultChecks]]) near(row[cols.indexOf(key)], value);
  near(r.final.wallHeatTransferScale, .5); assert.equal(row.length, cols.length); assert.ok(row.every(Number.isFinite));
  assert.ok(Object.isFrozen(r.final.faultDamage));
});
