const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRSimulation, TELEMETRY_LIMITS } = require('../simulation.js');
function advance(sim, seconds) { for (let t = 0; t < seconds; t += .1) sim.tick(.1); }

test('nominal operation conserves propellant and computes thrust from flow', () => {
  const sim = new NTRSimulation(); const initial = sim.fuel;
  advance(sim, 40);
  assert.equal(sim.mode, 'RUNNING'); assert.equal(sim.integrity, 100);
  assert.ok(sim.coreTemperature > 2200 && sim.coreTemperature < 3100);
  assert.ok(sim.isp > 700 && sim.isp < 1000);
  assert.ok(Math.abs(sim.thrust - sim.flow * sim.exhaustVelocity / 1000) < 1e-9);
  assert.ok(Math.abs(initial - sim.fuel - sim.consumed) < 1e-6);
  assert.ok(sim.totalImpulse > 0);
});
test('increased power raises temperature after a thermal delay', () => {
  const sim = new NTRSimulation(); const initial = sim.coreTemperature;
  sim.demand = 68; advance(sim, .1);
  assert.ok(sim.coreTemperature - initial < 5);
  advance(sim, 20); assert.ok(sim.coreTemperature > initial + 150);
});
test('configuration is interlocked while operating and allowed after shutdown', () => {
  const sim = new NTRSimulation();
  assert.equal(sim.configure('water', 1.8).ok, false);
  assert.equal(sim.propellant, 'hydrogen');
  sim.shutdown(); advance(sim, 25);
  assert.ok(sim.power < 5); assert.ok(sim.coreTemperature > 293);
  assert.equal(sim.configure('water', 1.8).ok, true);
  assert.equal(sim.propellant, 'water'); assert.equal(sim.fuel, 14000);
  assert.ok(sim.ratedPower > 600); assert.ok(sim.engineMass > 3800);
});
test('cold startup respects pump, cooling and valve interlocks', () => {
  const sim = new NTRSimulation(); sim.reset(true);
  sim.pump = false; assert.equal(sim.start().ok, false);
  sim.pump = true; sim.cooling = false; assert.equal(sim.start().ok, false);
  sim.cooling = true; sim.valve = 0; assert.equal(sim.start().ok, false);
  sim.valve = 70; assert.equal(sim.start().ok, true);
  advance(sim, 35); assert.equal(sim.mode, 'RUNNING'); assert.ok(sim.thrust > 50);
});
test('water mode produces lower exhaust velocity and higher flow than hydrogen', () => {
  const h = new NTRSimulation(); const w = new NTRSimulation();
  w.reset(true); w.configure('water', 1.4); w.start(); advance(w, 60);
  assert.equal(w.mode, 'RUNNING'); assert.ok(w.exhaustVelocity < h.exhaustVelocity * .5);
  assert.ok(w.flow > h.flow * 2); assert.ok(w.thrust > 0);
});
test('pump failure triggers automatic shutdown and can be repaired', () => {
  const sim = new NTRSimulation(); sim.injectFault('pump'); advance(sim, 35);
  assert.equal(sim.mode, 'SCRAM'); assert.ok(sim.power < 10);
  assert.equal(sim.start().ok, false); assert.equal(sim.repairAll(), true);
  assert.equal(sim.faults.size, 0); assert.equal(sim.start().ok, true);
});
test('sensor drift changes the measurement without changing the physical core', () => {
  const sim = new NTRSimulation(); const actual = sim.coreTemperature;
  sim.injectFault('sensor'); assert.equal(sim.coreTemperature, actual);
  assert.equal(sim.measuredTemperature, actual + 280);
  advance(sim, 15); assert.equal(sim.mode, 'RUNNING');
  sim.acknowledge(); assert.equal(sim.acknowledged, true);
  sim.repairFault('sensor'); assert.equal(sim.measuredTemperature, sim.coreTemperature);
});
test('leak loses propellant before the nozzle and repair restores flow', () => {
  const sim = new NTRSimulation(); sim.autoProtection = false;
  sim.injectFault('leak'); advance(sim, 2);
  assert.ok(Math.abs(sim.flow / sim.feedFlow - .57) < 1e-9);
  sim.repairAll(); advance(sim, 2);
  assert.ok(Math.abs(sim.flow - sim.feedFlow) < 1e-9);
});
test('disabled protection allows thermal damage, reset recovers cold standby', () => {
  const sim = new NTRSimulation(); sim.autoProtection = false;
  sim.injectFault('pump'); sim.injectFault('cooling'); advance(sim, 150);
  assert.equal(sim.mode, 'DAMAGED'); assert.equal(sim.integrity, 0);
  assert.equal(sim.start().ok, false); sim.reset(true);
  assert.equal(sim.mode, 'STANDBY'); assert.equal(sim.integrity, 100);
  assert.equal(sim.faults.size, 0); assert.equal(sim.time, 0);
});
test('scram removes power rapidly while preserving decay heat', () => {
  const sim = new NTRSimulation(); sim.scram(); advance(sim, 2);
  assert.ok(sim.power < 15); assert.ok(sim.decayPower > 0);
  assert.ok(sim.coreTemperature > 1000); assert.equal(sim.pump, true);
});
test('empty tank trips protection and all exposed performance values remain finite', () => {
  const sim = new NTRSimulation(); sim.fuel = .01; advance(sim, 5);
  assert.equal(sim.fuel, 0); assert.equal(sim.mode, 'SCRAM');
  for (const key of ['power', 'pressure', 'flow', 'coreTemperature', 'thrust', 'isp', 'exhaustVelocity']) assert.ok(Number.isFinite(sim[key]), key);
});
test('telemetry history stays bounded and ignores invalid delta times', () => {
  const sim = new NTRSimulation(); sim.tick(NaN); sim.tick(-1); assert.equal(sim.time, 0);
  advance(sim, 140); assert.ok(sim.history.length <= 240); assert.ok(sim.history.length > 200);
  assert.equal(sim.lamps.length, 16);
});
test('a cold unpowered core does not generate heat when coolant is switched off', () => {
  const sim = new NTRSimulation(); sim.reset(true); sim.cooling = false;
  advance(sim, 30); assert.equal(sim.power, 0); assert.equal(sim.coreTemperature, 293);
});
test('telemetry records real specific impulse with a separate 1000-second chart limit', () => {
  const sim = new NTRSimulation();
  assert.equal(TELEMETRY_LIMITS.isp, 1000);
  assert.equal(sim.history[0].isp, sim.isp);
  advance(sim, 1); assert.ok(sim.history.every(sample => Number.isFinite(sample.isp)));
  sim.coreTemperature = 4900; sim.updatePerformance(); sim.recordSample();
  assert.ok(sim.isp > TELEMETRY_LIMITS.isp);
  assert.equal(sim.history.at(-1).isp, sim.isp);
  assert.ok(Math.abs(sim.history.at(-1).isp - sim.exhaustVelocity / 9.80665) < 1e-9);
  sim.reset(true); assert.equal(sim.history[0].isp, 0);
});
test('engine model identifiers describe configured size and propellant', () => {
  const sim = new NTRSimulation(); assert.equal(sim.engineModel, 'NTR-II-140H');
  sim.reset(true); sim.configure('water', 1.85); assert.equal(sim.engineModel, 'NTR-II-185W');
});
