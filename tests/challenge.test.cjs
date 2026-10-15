const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge, calculateScore, formatPoints } = require('../challenge.js');
const release = require('../version.js');
const advance = (mission, seconds) => { for (let i = 0; i < seconds; i++) mission.tick(1); };
function make(options = {}) { const engine = new NTRSimulation(); return new NTRChallenge(engine, options); }
function ignite(mission, demand = 60, valve = 70) {
  Object.assign(mission.engine, { pump: true, cooling: true, demand, valve });
  assert.equal(mission.startEngine().ok, true);
}

test('challenge starts cold with exact fuel loads and a fixed 10-tonne dry spacecraft', () => {
  for (const [propellant, fuel] of [['hydrogen', 10000], ['water', 30000]]) {
    const m = make({ propellant });
    assert.equal(m.mass, 10000 + fuel); assert.equal(m.engine.fuelCapacity, fuel);
    assert.equal(m.engine.fuelPercent, 100); assert.equal(m.engine.coreTemperature, 293);
    for (const key of ['power', 'flow', 'pressure', 'thrust', 'exhaustVelocity']) assert.equal(m.engine[key], 0, key);
    assert.equal(m.engine.demand, 0); assert.equal(m.engine.valve, 0);
    assert.equal(m.engine.pump, false); assert.equal(m.engine.cooling, false);
    advance(m, 100); assert.equal(m.elapsed, 0); assert.equal(m.deltaV, 0);
  }
});
test('challenge locks propellant for the whole run and size after the first ignition', () => {
  const m = make(); const e = m.engine;
  assert.equal(e.configure('water', 1.4).ok, false); assert.equal(e.fuel, 10000);
  assert.equal(e.configure('hydrogen', 1.8).ok, true);
  ignite(m); e.shutdown(); advance(m, 60);
  assert.ok(e.power < 5); assert.equal(e.configure('hydrogen', 2).ok, false);
  assert.equal(e.configure('water', 1.8).ok, false); assert.equal(e.diameter, 1.8);
});
test('precision target is fixed at 325 m/s in every run and propellant mode', () => {
  for (const propellant of ['hydrogen', 'water']) {
    const m = make({ type: 'precision', propellant });
    assert.equal(m.target, 325); advance(m, 20); assert.equal(m.target, 325);
  }
});
test('endurance scoring applies 1% per 100 seconds and 5% per 10% durability lost', () => {
  const score = calculateScore({ type: 'endurance', deltaV: 1000, fuel: 500, elapsed: 200, integrity: 80 });
  assert.equal(score.base, 10000); assert.equal(score.timePenalty, .02);
  assert.equal(score.durabilityPenalty, .1); assert.equal(score.total, 8820);
  assert.ok(Math.abs(score.timeDeduction - 200) < 1e-8);
  assert.ok(Math.abs(score.durabilityDeduction - 980) < 1e-8);
});
test('precision hydrogen cost and remaining-fuel refund precede all performance penalties', () => {
  const score = calculateScore({ type: 'precision', propellant: 'hydrogen', initialFuel: 2000, deltaV: 327, target: 325, fuel: 1200, elapsed: 100, integrity: 90 });
  assert.equal(score.basePoints, 100000); assert.equal(score.loadingCost, 20000);
  assert.equal(score.base, 81200); assert.equal(score.dvPoints, 0); assert.equal(score.fuelPoints, 1200);
  assert.equal(score.errorPenalty, .02); assert.equal(score.timePenalty, .01);
  assert.equal(score.durabilityPenalty, .05);
  assert.equal(score.total, Math.floor(81200 * .98 * .99 * .95));
});
test('water costs two points per loaded kilogram and refunds one per remaining kilogram', () => {
  const score = calculateScore({ type: 'precision', propellant: 'water', initialFuel: 3000, deltaV: 325, target: 325, fuel: 1000, elapsed: 0, integrity: 100 });
  assert.equal(score.fuelUnitCost, 2); assert.equal(score.loadingCost, 6000);
  assert.equal(score.fuelPoints, 1000); assert.equal(score.total, 95000);
});
test('unused hydrogen returns only one point per kilogram rather than its ten-point purchase cost', () => {
  const score = calculateScore({ type: 'precision', propellant: 'hydrogen', initialFuel: 1000, deltaV: 325, target: 325, fuel: 1000, elapsed: 0, integrity: 100 });
  assert.equal(score.total, 91000);
});
test('custom precision loads update the actual tank, starting mass, and cold-start consumption', () => {
  for (const [propellant, fuelLoad] of [['hydrogen', 777], ['water', 2345]]) {
    const m = make({ type: 'precision', propellant, fuelLoad });
    assert.equal(m.initialFuel, fuelLoad); assert.equal(m.mass, 10000 + fuelLoad);
    assert.equal(m.engine.fuel, fuelLoad); assert.equal(m.engine.fuelPercent, 100);
    ignite(m); advance(m, 5); assert.ok(m.engine.fuel < fuelLoad);
    assert.ok(Math.abs(m.engine.fuel + m.engine.consumed - fuelLoad) < 1e-8);
    assert.equal(m.engine.configure(propellant === 'water' ? 'hydrogen' : 'water', 1.4).ok, false);
  }
});
test('precision defaults are quick-run loads while endurance keeps its original full tanks', () => {
  assert.equal(make({ type: 'precision' }).initialFuel, 1000);
  assert.equal(make({ type: 'precision', propellant: 'water' }).initialFuel, 3000);
  assert.equal(make().initialFuel, 10000);
  assert.equal(make({ propellant: 'water' }).initialFuel, 30000);
});
test('invalid or out-of-capacity loads cannot start or yield a scoring refund', () => {
  for (const fuelLoad of [0, 9, -10, 10.5, NaN, Infinity, 10621]) assert.throws(() => make({ type: 'precision', fuelLoad }), TypeError);
  assert.equal(make({ fuelLoad: 500 }).initialFuel, 500);
  assert.throws(() => make({ type: 'precision', propellant: 'water', fuelLoad: 150001 }), TypeError);
  const args = { type: 'precision', propellant: 'hydrogen', initialFuel: 1000, fuel: 1001, deltaV: 325, target: 325, elapsed: 0, integrity: 100 };
  assert.throws(() => calculateScore(args), TypeError);
});
test('all score magnitudes use comma grouping with consistent fractional precision', () => {
  assert.equal(formatPoints(100000), '100,000'); assert.equal(formatPoints(999), '999');
  assert.equal(formatPoints(95123.456, 2), '95,123.46');
  assert.equal(formatPoints(-5000.5, 2), '-5,000.50');
});
test('fractional penalties are continuous, symmetric, and never generate negative scores', () => {
  const base = { type: 'precision', propellant: 'hydrogen', initialFuel: 6000, target: 325, fuel: 5000, elapsed: 50, integrity: 95 };
  const under = calculateScore({ ...base, deltaV: 324.5 });
  const over = calculateScore({ ...base, deltaV: 325.5 });
  assert.equal(under.total, over.total); assert.equal(under.errorPenalty, .005);
  assert.equal(under.timePenalty, .005); assert.equal(under.durabilityPenalty, .025);
  assert.equal(calculateScore({ ...base, deltaV: 225 }).total, 0);
  assert.equal(calculateScore({ ...base, deltaV: 325, elapsed: 20000 }).total, 0);
  assert.throws(() => calculateScore({ ...base, deltaV: NaN }), TypeError);
});
test('flight acceleration uses total spacecraft mass and integrates delta-v and distance', () => {
  const m = make(); ignite(m); advance(m, 25);
  assert.ok(m.engine.thrust > 50); assert.ok(m.deltaV > 50); assert.ok(m.distance > 100);
  assert.ok(m.mass < 20000 && m.mass > 19000);
  assert.ok(Math.abs(m.acceleration - m.engine.thrust * 1000 / m.mass) < 1e-10);
  assert.ok(Math.abs(m.engine.consumed + m.engine.fuel - m.initialFuel) < 1e-6);
});
test('coasting preserves delta-v, accumulates distance, and remains part of mission time', () => {
  const m = make(); ignite(m); advance(m, 25); m.engine.shutdown(); m.engine.valve = 0;
  advance(m, 80); const velocity = m.deltaV, distance = m.distance, elapsed = m.elapsed;
  advance(m, 10);
  assert.ok(Math.abs(m.deltaV - velocity) < 1e-6);
  assert.ok(Math.abs(m.distance - distance - velocity * 10) < .01);
  assert.ok(Math.abs(m.elapsed - elapsed - 10) < 1e-7);
});
test('manual settlement is interlocked at 800 K and freezes an immutable final result', () => {
  const m = make(); assert.equal(m.settle().ok, false); ignite(m); advance(m, 30);
  assert.ok(m.engine.coreTemperature > 800); assert.equal(m.settle().ok, false);
  m.engine.shutdown(); m.engine.valve = 0; advance(m, 80);
  assert.ok(m.engine.coreTemperature < 800); assert.equal(m.settle().ok, true);
  assert.equal(m.state, 'COMPLETE'); assert.ok(Object.isFrozen(m.result));
  assert.equal(m.result.version, release.version); assert.equal(m.result.scoreSchema, release.scoreSchema);
  assert.equal(typeof m.result.id, 'string');
  const result = m.result, deltaV = m.deltaV, fuel = m.engine.fuel, time = m.elapsed;
  advance(m, 100); assert.equal(m.result, result); assert.equal(m.deltaV, deltaV);
  assert.equal(m.engine.fuel, fuel); assert.equal(m.elapsed, time);
  assert.equal(m.engine.start().ok, false); assert.equal(m.engine.configure('water', 2).ok, false);
});
test('last usable fuel can produce only its own impulse; reserve cannot produce phantom thrust', () => {
  const e = new NTRSimulation(); e.fuel = e.fuelReserve + .01; e.tick(.05);
  assert.ok(e.feedFlow <= .2 + 1e-10); assert.equal(e.fuel, e.fuelReserve);
  e.tick(.05); assert.equal(e.feedFlow, 0); assert.equal(e.flow, 0); assert.equal(e.thrust, 0);
});
test('fuel exhaustion shuts down even without auto protection and settles after cooling', () => {
  const m = make(); ignite(m); advance(m, 25); m.engine.autoProtection = false; m.engine.fuel = m.engine.fuelReserve;
  m.tick(.05); assert.equal(m.state, 'COOLING'); assert.equal(m.engine.mode, 'SCRAM');
  assert.equal(m.complete, false); assert.ok(m.engine.coreTemperature > 800);
  assert.equal(m.startEngine().ok, false); advance(m, 100);
  assert.equal(m.complete, true); assert.equal(m.result.fuel, m.engine.fuelReserve);
  assert.ok(m.result.temperature < 800); assert.match(m.result.reason, /自动结算/);
  assert.ok(m.result.elapsed > 25); assert.ok(m.result.total > 0);
});
test('both full-propellant challenges can reach an automatic end with zero mass leakage', () => {
  for (const propellant of ['hydrogen', 'water']) {
    const m = make({ propellant, diameter: 2.4 }); ignite(m);
    for (let i = 0; i < 700 && !m.complete; i++) m.tick(1);
    assert.equal(m.complete, true, propellant); assert.equal(m.engine.fuel, m.initialFuel * .005);
    assert.equal(m.mass, 10000 + m.engine.fuel); assert.ok(m.result.deltaV > 2800);
    assert.ok(Math.abs(m.engine.consumed + m.engine.fuel - m.initialFuel) < 1e-5);
  }
});
test('a new mission resets durable damage, counters, fuel, and all configuration locks', () => {
  const m = make(); ignite(m); advance(m, 2); m.engine.integrity = 50;
  const fresh = new NTRChallenge(m.engine, { propellant: 'water', type: 'precision', diameter: 1.1, fuelLoad: 4000 });
  assert.equal(fresh.engine.integrity, 100); assert.equal(fresh.deltaV, 0); assert.equal(fresh.elapsed, 0);
  assert.equal(fresh.engine.fuel, 4000); assert.equal(fresh.engine.diameterLocked, false);
  assert.equal(fresh.engine.propellantLocked, true); assert.equal(fresh.engine.controlsLocked, false);
});
test('settlement captures launch settings and lifetime peaks without changing score precision', () => {
  const m = make({ type: 'precision', diameter: 1.8, fuelLoad: 2000 });
  ignite(m, 40, 60); advance(m, 5); const firstPower = m.engine.power;
  m.engine.demand = 65; m.engine.valve = 75; advance(m, 5); const secondPower = m.engine.power;
  m.engine.shutdown(); m.engine.valve = 0; advance(m, 90); assert.equal(m.settle().ok, true);
  const r = m.result;
  assert.equal(r.launchDemand, 40); assert.equal(r.launchValve, 60);
  assert.equal(r.engineModel, 'NTR-II-180H'); assert.equal(r.diameter, 1.8);
  assert.ok(r.peakPower >= Math.max(firstPower, secondPower));
  assert.ok(r.peakIsp > 0 && r.peakTemperature > r.temperature);
  assert.ok(Math.abs(r.initialMass - r.finalMass - r.consumedFuel) < 1e-7);
  assert.equal(r.total, calculateScore(r).total);
  const original = r.engineModel; m.engine.reset(true); assert.equal(r.engineModel, original);
});
