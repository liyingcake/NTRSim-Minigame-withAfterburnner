const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TANK, PUMP_WAVE, loadout, pumpRipple, mixExhaust } = require('../systems.js');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge, calculateScore } = require('../challenge.js');
const { NTRLeaderboard } = require('../leaderboard.js');
const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const advance = (e, seconds) => { for (let i = 0; i < seconds * 20; i++) e.tick(.05); };
function lantr() {
  const e = new NTRSimulation(); e.reset(true); assert.equal(e.setLoadout(5000, 20000).ok, true);
  e.start(); advance(e, 40); return e;
}
test('150 m³ tank uses density and charges a persistent ten-m³ divider for dual tanks', () => {
  const h = loadout('hydrogen', 10000); assert.ok(h.valid); near(h.fuelVolume, 10000 / 70.8);
  assert.ok(h.freeVolume > 8 && h.freeVolume < 9);
  assert.equal(loadout('hydrogen', 10000, 1).valid, false);
  const dual = loadout('hydrogen', 5000, 20000); assert.ok(dual.valid);
  near(dual.usedVolume, 5000 / 70.8 + 20000 / 1138 + 10);
  assert.equal(loadout('hydrogen', 5000, 0, true).dividerVolume, 10);
  assert.equal(loadout('water', 150000).usedVolume, 150); assert.equal(loadout('water', 150001).valid, false);
  assert.equal(loadout('water', 1000, 1).valid, false); assert.equal(loadout('hydrogen', Infinity, 0).valid, false);
  assert.ok(loadout('hydrogen', 5000, dual.maxOxygen).valid);
  assert.equal(loadout('hydrogen', 5000, dual.maxOxygen + 1).valid, false);
});
test('hydrogen oxygen products conserve mass, release heat, raise thrust and reduce Isp', () => {
  const pure = mixExhaust(10, 0, 2500, 4), mixed = mixExhaust(10, 20, 2500, 4);
  near(mixed.steam + mixed.hydrogen + mixed.oxygen + mixed.radicals, 30);
  assert.ok(mixed.steam > 0 && mixed.steam < 30); assert.ok(mixed.hydrogen > 0 && mixed.radicals > 0);
  assert.ok(mixed.chemicalPower > 0 && mixed.chemicalPower < 20 / 7.936 * 120);
  assert.equal(mixed.mixtureRatio, 2); assert.ok(mixed.temperature > 2500);
  assert.ok(mixed.velocity < pure.velocity); assert.ok(mixed.velocity * mixed.flow > pure.velocity * pure.flow);
  const rich = mixExhaust(10, 100, 2500, 4); assert.ok(rich.oxygen > 0); near(rich.steam + rich.hydrogen + rich.oxygen + rich.radicals, 110);
  near(mixed.kineticPower, .5 * mixed.flow * mixed.jetVelocity ** 2 / 1e6);
  near(mixed.energy.input, mixed.energy.kinetic + mixed.energy.wall + mixed.energy.exhaust);
});
test('pump ripple is deterministic, has both signs and remains within ±0.100 kg/s per ten', () => {
  assert.equal(PUMP_WAVE.interval, 1); assert.equal(PUMP_WAVE.amplitude, .01);
  for (const command of [0, 10, 50, 200]) {
    let min = 0, max = 0, sum = 0;
    for (let i = 0; i < 20000; i++) { const t = i * .01, n = pumpRipple(command, t); near(n, pumpRipple(command, t)); assert.ok(Math.abs(n) <= command * .01 + 1e-10); min = Math.min(min, n); max = Math.max(max, n); sum += n; }
    if (command) { assert.ok(min < 0 && max > 0); assert.ok(Math.abs(sum / 20000) < command * .0002); }
  }
});
test('one-second pump target transitions remain smooth through boundaries and simulation substeps', () => {
  for (const phase of [0, 2.3]) {
    for (let second = 1; second <= 100; second++) {
      const before = pumpRipple(100, second - .0001, phase), at = pumpRipple(100, second, phase), after = pumpRipple(100, second + .0001, phase);
      near(before, at, 1e-8); near(after, at, 1e-8);
    }
    for (let step = 1; step < 2000; step++) {
      assert.ok(Math.abs(pumpRipple(100, step * .05, phase) - pumpRipple(100, (step - 1) * .05, phase)) < .2);
    }
  }
  assert.notEqual(pumpRipple(100, 2.5), pumpRipple(100, 2.5, 2.3));
});
test('LANTR consumes oxygen independently, conserves both tanks and leaves the reactor heat unchanged', () => {
  const e = lantr(), pureCore = e.coreTemperature, pureThrust = e.thrust, pureIsp = e.isp;
  e.oxygenPump = true; e.oxygenValve = 30; advance(e, 3);
  assert.ok(e.afterburnerPower > 0 && e.oxygenFlow > 0); assert.ok(e.thrust > pureThrust);
  assert.ok(e.isp < pureIsp); near(e.totalPower, e.power + e.afterburnerPower);
  assert.ok(Math.abs(e.coreTemperature - pureCore) < 30);
  near(e.fuel + e.consumed, 5000); near(e.oxygen + e.oxygenConsumed, 20000);
  near(e.thrust, e.totalFlow * e.exhaustVelocity / 1000);
  near(e.products.steam + e.products.hydrogen + e.products.oxygen + e.products.radicals, e.totalFlow);
  assert.ok(e.mixtureRatio <= 8); assert.equal(e.engineModel, 'LANTR-140H');
});
test('cold flow, shutdown, main depletion and empty oxygen tanks cannot burn phantom oxygen', () => {
  const cold = new NTRSimulation(); cold.reset(true); cold.setLoadout(1000, 1000);
  cold.oxygenPump = true; cold.oxygenValve = 100; advance(cold, 2); near(cold.oxygenFlow, 0); near(cold.oxygen, 1000);
  const e = lantr(); e.oxygenPump = true; e.oxygenValve = 100; advance(e, 2); assert.ok(e.afterburnerPower > 0);
  e.shutdown(); near(e.oxygenFlow, 0); near(e.afterburnerPower, 0); const remaining = e.oxygen; advance(e, 2); near(e.oxygen, remaining);
  const empty = lantr(); empty.oxygen = .001; empty.oxygenPump = true; empty.oxygenValve = 100;
  empty.tick(.05); near(empty.oxygen, .001); empty.tick(.05); near(empty.oxygenFlow, 0); assert.ok(empty.thrust > 0); assert.ok(empty.isActive);
  const noHydrogen = lantr(); noHydrogen.fuel = 0; noHydrogen.oxygenPump = true; noHydrogen.oxygenValve = 100;
  noHydrogen.tick(.05); near(noHydrogen.oxygenFlow, 0);
});
test('payload, oxygen and main propellant all affect flight mass and are locked after loading', () => {
  const e = new NTRSimulation(), m = new NTRChallenge(e, { type: 'lunar', fuelLoad: 5000, oxygenLoad: 20000, payload: 50000 });
  assert.equal(m.target, 2000); assert.equal(m.dryMass, 60000); assert.equal(m.mass, 85000);
  assert.equal(e.setLoadout(5000, 0).ok, false);
  Object.assign(e, { pump: true, cooling: true, demand: 60, valve: 70, oxygenPump: true, oxygenValve: 30 });
  m.startEngine(); advance(m, 30); assert.ok(e.oxygenConsumed > 0);
  near(m.mass, 85000 - e.consumed - e.oxygenConsumed);
  near(m.acceleration, e.thrust * 1000 / m.mass); assert.ok(m.deltaV > 0);
  e.shutdown(); e.valve = 0; advance(m, 100); assert.equal(m.settle().ok, true);
  const r = m.result; assert.equal(r.payload, 50000); assert.equal(r.launchOxygenValve, 30);
  assert.equal(r.payloadPoints, 500000); assert.equal(r.initialOxygen, 20000);
  near(r.initialMass - r.finalMass, r.consumedFuel + r.consumedOxygen);
  const board = new NTRLeaderboard(); assert.ok(board.add(r)); assert.equal(board.get(r.id).peakAfterburnerPower, r.peakAfterburnerPower);
});
test('new price and payload rewards apply before symmetric error, time and integrity factors', () => {
  const args = { type: 'precision', propellant: 'hydrogen', initialFuel: 1000, fuel: 400, initialOxygen: 2000, oxygen: 500, payload: 40000, target: 325, deltaV: 326, elapsed: 100, integrity: 80 };
  const score = calculateScore(args);
  assert.equal(score.loadingCost, 16000); assert.equal(score.payloadPoints, 80000); assert.equal(score.fuelPoints, 900);
  assert.equal(score.base, 164900); assert.equal(score.total, Math.floor(164900 * .99 * .99 * .9));
  const lunar = calculateScore({ ...args, type: 'lunar', payload: 100000, target: 2000, deltaV: 2000, elapsed: 0, integrity: 100 });
  assert.equal(lunar.payloadPoints, 1000000); assert.equal(lunar.total, 1084900);
  for (const [type, payload] of [['precision', 40001], ['precision', -1], ['lunar', 4999], ['lunar', 100001]]) assert.throws(() => new NTRChallenge(new NTRSimulation(), { type, payload }), TypeError);
  assert.throws(() => new NTRChallenge(new NTRSimulation(), { type: 'precision', fuelLoad: 10000, oxygenLoad: 1 }), TypeError);
});
test('the depletion trip preserves chemical impulse already delivered in the final substep', () => {
  const e = new NTRSimulation(), m = new NTRChallenge(e, { type: 'precision', fuelLoad: 2000, oxygenLoad: 2000 });
  Object.assign(e, { pump: true, cooling: true, demand: 60, valve: 70, oxygenPump: true, oxygenValve: 30 });
  m.startEngine(); advance(m, 30); assert.ok(e.afterburnerPower > 0);
  e.fuel = e.fuelReserve + .4;
  const beforeMass = m.mass, beforeVelocity = m.deltaV, beforeImpulse = e.totalImpulse;
  m.tick(.05);
  assert.equal(e.mode, 'SCRAM'); assert.equal(e.oxygenFlow, 0);
  assert.ok(e.totalImpulse > beforeImpulse);
  near((m.deltaV - beforeVelocity) * (beforeMass + m.mass) / 2, (e.totalImpulse - beforeImpulse) * 1000, 1e-5);
});
