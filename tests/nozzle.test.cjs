const { test } = require('node:test');
const assert = require('node:assert/strict');
const nozzle = require('../nozzle.js'), thermo = require('../thermochemistry.js');
const { NTRSimulation } = require('../simulation.js'), { NTRChallenge } = require('../challenge.js');
const { NTRLeaderboard } = require('../leaderboard.js');
const reference = require('../benchmarks/nozzle-reference.json');
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} vs ${b}`);
const geometry = settings => nozzle.geometry(1.4, { ...nozzle.DEFAULTS, ...settings });
const plume = (settings = {}, mode = 'finite', flow = .441, oxygen = 0, temperature = 3094, pressure = .189) => thermo.exhaust(flow, oxygen, temperature, pressure, 562, 1, 'hydrogen', mode, .8, geometry(settings));

test('conical geometry has exact throat / exit areas and an attached extension with explicit mass', () => {
  const a = geometry(), b = geometry({ extension: 4 });
  near(a.exitArea / a.throatArea, a.expansionRatio); near(a.length, (a.exitRadius - a.throatRadius) / Math.tan(a.halfAngle * Math.PI / 180));
  near(b.length - a.length, 4); near(b.exitRadius - a.exitRadius, 4 * Math.tan(a.halfAngle * Math.PI / 180));
  assert.ok(b.expansion > a.expansion && b.mass > a.mass && b.surface > a.surface);
  near(b.mass, 1.15 * (b.baseMass + b.extensionMass));
  assert.equal(nozzle.valid({ ...nozzle.DEFAULTS, extension: -1 }), false);
  assert.throws(() => geometry({ halfAngle: 0 }));
});
test('a wider half-angle shortens and lightens the same exit while reducing axial momentum', () => {
  const a = geometry({ halfAngle: 8 }), b = geometry({ halfAngle: 30 });
  near(a.exitArea, b.exitArea); assert.ok(a.length > b.length && a.mass > b.mass);
  assert.ok(a.divergenceEfficiency > b.divergenceEfficiency);
});
test('throat area sets chamber pressure at the same feed and thermodynamic state', () => {
  const gas = thermo.atTemperature(2500, 4e6), p = nozzle.chamberPressure(10, gas, geometry());
  near(nozzle.chamberPressure(10, gas, geometry({ throatScale: 2 })), p / 2);
  assert.equal(nozzle.chamberPressure(0, gas, geometry()), 0);
});

test('changing throat area at fixed expansion scales the whole base cone; fixed exit instead changes expansion', () => {
  const base = geometry();
  for (const factor of [.25, .5, 1, 2, 4]) {
    const scaled = geometry({ throatScale: factor });
    near(scaled.throatArea, base.throatArea * factor); near(scaled.exitArea, base.exitArea * factor);
    near(scaled.throatRadius, base.throatRadius * Math.sqrt(factor)); near(scaled.length, base.length * Math.sqrt(factor));
    near(scaled.expansion, base.expansion); near(scaled.baseSurface, base.baseSurface * factor);
    if (factor >= .5) {
      const fixedExit = geometry({ throatScale: factor, expansionRatio: 240 / factor });
      near(fixedExit.exitArea, base.exitArea); near(fixedExit.expansion * factor, base.expansion);
    }
  }
  assert.equal(nozzle.valid({ ...nozzle.DEFAULTS, throatScale: .25, expansionRatio: 960 }), false);
});
test('NASA-mixture frozen entropy and expansion agree with independent Cantera SP references', () => {
  for (const c of reference.cases) {
    near(thermo.frozenEntropy(c.temperature, c.pressure, c.y), c.entropy, 1e-5);
    near(thermo.frozenProperties(c.temperature, c.y).h, c.h, .01);
    const f = thermo.frozenAtEntropy(c.entropy, c.frozenPressure, c.y);
    near(f.temperature, c.frozenTemperature, 1e-5); near(f.h, c.frozenH, .05);
    near(f.cp, c.frozenCp, 1e-4);
  }
});
test('equilibrium entropy lookup and chemical-time proxy track the independent offline source', () => {
  for (const c of reference.cases) {
    const s = thermo.fromEntropy(c.entropy, c.pressure, c.ratio);
    assert.ok(Math.abs(s.temperature - c.temperature) < 6);
    assert.ok(Math.abs(10 ** s.logReactionTime / c.reactionTime - 1) < .35);
  }
});
test('fixed-area finite expansion conserves mass, elements and the shared enthalpy budget', () => {
  const hydrogenFraction = [1, 1, 0, 0, 1.008 / 17.007, 2.016 / 18.015, 1.008 / 33.006, 2.016 / 34.014];
  for (const oxygen of [0, 3, 22, 60]) {
    const s = plume({ extension: 2 }, 'finite', 10, oxygen, 2600, 4);
    assert.equal(s.blocked, false);
    const density = s.exitPressure / (8314.462618 / s.molarMass * s.exitTemperature);
    near(density * s.jetVelocity * s.equivalentExitArea, s.flow, .0002);
    near(s.energy.input, s.energy.wall + s.energy.kinetic + s.energy.exhaust, 1e-6);
    near(s.kineticPower, s.flow * s.jetVelocity ** 2 / 2e6, 1e-6);
    near(s.velocity * s.flow, s.flow * s.axialVelocity + s.pressureThrust * 1000, 1e-6);
    near(s.pressureThrust * 1000, s.exitPressure * s.equivalentExitArea, 1e-6);
    near(Object.values(s.fractions).reduce((a, b) => a + b), 1);
    const h = Object.values(s.fractions).reduce((a, y, i) => a + y * hydrogenFraction[i], 0) * s.flow;
    near(h, 10, .00001); assert.ok(s.exitPressure !== 100);
  }
});
test('low-pressure atomic hydrogen survives finite freezing and changes performance consistently', () => {
  const finite = plume(), equilibrium = plume({}, 'equilibrium'), frozen = plume({}, 'frozen');
  assert.ok(finite.atomicHydrogen > .001); assert.ok(finite.freezePressure > finite.exitPressure);
  assert.ok(finite.atomicHydrogen > equilibrium.atomicHydrogen);
  assert.ok(finite.velocity <= equilibrium.velocity * 1.002);
  assert.ok(finite.velocity >= frozen.velocity * .995);
});
test('an extension enlarges the exit, lowers exit pressure and adds useful expansion with a mass cost', () => {
  const a = plume(), b = plume({ extension: 4 });
  assert.ok(b.exitPressure < a.exitPressure); assert.ok(b.geometry.mass > a.geometry.mass);
  assert.ok(b.velocity > a.velocity); assert.ok(b.residenceTime > a.residenceTime);
});
test('geometry-dependent residence changes the freeze state without a pressure threshold', () => {
  const a = plume({ halfAngle: 8 }, 'finite', 10.36, 0, 3094, 3.8), b = plume({ halfAngle: 30 }, 'finite', 10.36, 0, 3094, 3.8);
  assert.ok(a.atomicHydrogen < b.atomicHydrogen); assert.ok(a.velocity > b.velocity);
  const left = plume({}, 'finite', .441, 0, 3000, .49999), right = plume({}, 'finite', .441, 0, 3000, .50001);
  assert.ok(Math.abs(left.velocity - right.velocity) < 2); assert.ok(Math.abs(left.atomicHydrogen - right.atomicHydrogen) < .0001);
});
test('zero flow produces no thrust and water uses the same geometric expansion pipeline', () => {
  const empty = thermo.exhaust(0, 0, 293, 0, 293, 1, 'hydrogen', 'finite', 0, geometry()); near(empty.velocity, 0); near(empty.pressureThrust, 0);
  const water = thermo.exhaust(45, 0, 3000, 4, 650, 1, 'water', 'finite', 0, geometry());
  assert.ok(water.velocity > 0 && water.exitPressure > 0); near(Object.values(water.fractions).reduce((a, b) => a + b), 1);
  near(water.energy.residual, 0, 1e-6); near(water.chemicalPower, 0);
});
test('nozzle design updates dry mass and acceleration, locks after challenge ignition and replays exactly', () => {
  const e = new NTRSimulation(); e.reset(true); const original = e.dryMass;
  assert.ok(e.configureNozzle({ extension: 4 }).ok); assert.ok(e.dryMass > original);
  near(e.engineMass, e.baseEngineMass + e.nozzleMass);
  const m = new NTRChallenge(e, { type: 'precision', nozzle: { ...nozzle.DEFAULTS, extension: 4 }, fuelLoad: 1000 });
  near(m.mass, 5000 + e.baseEngineMass + e.nozzleMass + 1000);
  e.setSwitch('pump', true); e.setSwitch('cooling', true); e.setControl('valve', 70); e.setControl('demand', 60); m.startEngine();
  assert.equal(e.configureNozzle({ extension: 0 }).ok, false);
  const r = m.settle().result; assert.equal(r.nozzleExtension, 4);
  near(r.flightReport.initial.nozzle.mass, r.nozzleMass);
  const board = new NTRLeaderboard(); assert.ok(board.add(r)); near(board.get(r.id).nozzleExpansion, e.nozzle.expansion);
  assert.ok(r.flightReport.operations.some(o => o.action === 'nozzleConfigure'));
});
test('reactor storage exactly accounts for heat delivered to both nozzle flow and a leaking line', () => {
  for (const leak of [false, true]) {
    const e = new NTRSimulation(); if (leak) { e.autoProtection = false; e.injectFault('leak'); }
    for (let i = 0; i < 30; i++) {
      const before = e.coreTemperature; e.step(.05);
      near(e.coreStoredPower, (e.coreTemperature - before) * e.coreHeatCapacity / .05 / 1e6, 1e-6);
      near(e.power, e.coreHeatToPropellant + e.coreCoolingPower + e.coreStoredPower + e.coreOverflowPower, 1e-6);
      near(e.coreHeatToPropellant, e.nozzleEnergy.nuclearTransported + e.coreLeakHeat, 1e-6);
    }
  }
});
test('archives record geometry, all three H stations and the core heat balance as declared channels', () => {
  const e = new NTRSimulation(); e.tick(1); const r = e.flight.snapshot(e), row = r.telemetry.last120.at(-1), cols = r.telemetry.columns;
  for (const key of ['mixHMassFraction', 'exitHMassFraction', 'nozzleMass_kg', 'exitPressure_Pa', 'coreStored_MW']) assert.ok(cols.includes(key));
  near(row[cols.indexOf('nozzleMass_kg')], e.nozzleMass);
  near(row[cols.indexOf('exitH_kg_s')], e.products.atomicHydrogen);
  assert.equal(row.length, cols.length); assert.ok(row.every(Number.isFinite));
});
