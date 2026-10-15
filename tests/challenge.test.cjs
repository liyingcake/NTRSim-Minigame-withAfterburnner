const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge, calculateScore } = require('../challenge.js');
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
test('precision target is sampled once as an integer in the full 2750–2850 range', () => {
  for (const [random, expected] of [[0, 2750], [.5, 2800], [.999999999, 2850]]) {
    const m = make({ type: 'precision', random: () => random });
    assert.equal(m.target, expected); advance(m, 20); assert.equal(m.target, expected);
  }
});
test('endurance scoring applies 1% per 100 seconds and 5% per 10% durability lost', () => {
  const score = calculateScore({ type: 'endurance', deltaV: 1000, fuel: 500, elapsed: 200, integrity: 80 });
  assert.equal(score.base, 10000); assert.equal(score.timePenalty, .02);
  assert.equal(score.durabilityPenalty, .1); assert.equal(score.total, 8820);
  assert.ok(Math.abs(score.timeDeduction - 200) < 1e-8);
  assert.ok(Math.abs(score.durabilityDeduction - 980) < 1e-8);
});
test('precision score rewards remaining fuel without adding any delta-v points', () => {
  const score = calculateScore({ type: 'precision', deltaV: 2802, target: 2800, fuel: 1200, elapsed: 100, integrity: 90 });
  assert.equal(score.base, 11200); assert.equal(score.dvPoints, 0); assert.equal(score.fuelPoints, 1200);
  assert.equal(score.errorPenalty, .02); assert.equal(score.timePenalty, .01);
  assert.equal(score.durabilityPenalty, .05);
  assert.equal(score.total, Math.floor(11200 * .98 * .99 * .95));
});
test('fractional penalties are continuous, symmetric, and never generate negative scores', () => {
  const base = { type: 'precision', target: 2800, fuel: 5000, elapsed: 50, integrity: 95 };
  const under = calculateScore({ ...base, deltaV: 2799.5 });
  const over = calculateScore({ ...base, deltaV: 2800.5 });
  assert.equal(under.total, over.total); assert.equal(under.errorPenalty, .005);
  assert.equal(under.timePenalty, .005); assert.equal(under.durabilityPenalty, .025);
  assert.equal(calculateScore({ ...base, deltaV: 2700 }).total, 0);
  assert.equal(calculateScore({ ...base, deltaV: 2800, elapsed: 20000 }).total, 0);
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
  const result = m.result, deltaV = m.deltaV, fuel = m.engine.fuel, time = m.elapsed;
  advance(m, 100); assert.equal(m.result, result); assert.equal(m.deltaV, deltaV);
  assert.equal(m.engine.fuel, fuel); assert.equal(m.elapsed, time);
  assert.equal(m.engine.start().ok, false); assert.equal(m.engine.configure('water', 2).ok, false);
});
test('last fuel can produce only its own impulse; an empty tank cannot produce phantom thrust', () => {
  const e = new NTRSimulation(); e.fuel = .01; e.tick(.05);
  assert.ok(e.feedFlow <= .2 + 1e-10); assert.equal(e.fuel, 0);
  e.tick(.05); assert.equal(e.feedFlow, 0); assert.equal(e.flow, 0); assert.equal(e.thrust, 0);
});
test('fuel exhaustion shuts down even without auto protection and settles after cooling', () => {
  const m = make(); ignite(m); advance(m, 25); m.engine.autoProtection = false; m.engine.fuel = .01;
  m.tick(.05); assert.equal(m.state, 'COOLING'); assert.equal(m.engine.mode, 'SCRAM');
  assert.equal(m.complete, false); assert.ok(m.engine.coreTemperature > 800);
  assert.equal(m.startEngine().ok, false); advance(m, 100);
  assert.equal(m.complete, true); assert.equal(m.result.fuel, 0);
  assert.ok(m.result.temperature < 800); assert.match(m.result.reason, /自动结算/);
  assert.ok(m.result.elapsed > 25); assert.ok(m.result.total > 0);
});
test('both full-propellant challenges can reach an automatic end with zero mass leakage', () => {
  for (const propellant of ['hydrogen', 'water']) {
    const m = make({ propellant, diameter: 2.4 }); ignite(m);
    for (let i = 0; i < 700 && !m.complete; i++) m.tick(1);
    assert.equal(m.complete, true, propellant); assert.equal(m.engine.fuel, 0);
    assert.equal(m.mass, 10000); assert.ok(m.result.deltaV > 2800);
    assert.ok(Math.abs(m.engine.consumed - m.initialFuel) < 1e-5);
  }
});
test('a new mission resets durable damage, counters, fuel, and all configuration locks', () => {
  const m = make(); ignite(m); advance(m, 2); m.engine.integrity = 50;
  const fresh = new NTRChallenge(m.engine, { propellant: 'water', type: 'precision', diameter: 1.1 });
  assert.equal(fresh.engine.integrity, 100); assert.equal(fresh.deltaV, 0); assert.equal(fresh.elapsed, 0);
  assert.equal(fresh.engine.fuel, 30000); assert.equal(fresh.engine.diameterLocked, false);
  assert.equal(fresh.engine.propellantLocked, true); assert.equal(fresh.engine.controlsLocked, false);
});
