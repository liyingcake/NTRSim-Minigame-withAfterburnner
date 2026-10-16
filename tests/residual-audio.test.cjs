const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RESIDUAL, residualSupply } = require('../systems.js');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge } = require('../challenge.js');
const { soundState, ALARMS } = require('../audio.js');
const near = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
function run(sim, seconds) { for (let i = 0; i < seconds * 20; i++) sim.tick(.05); }

test('residual supply begins below 2%, reaches zero at 0.5%, and is monotonic', () => {
  assert.equal(RESIDUAL.fadeStart, .02); assert.equal(RESIDUAL.cutoff, .005);
  for (const initial of [100, 1000, 10000, 150000]) {
    near(residualSupply(initial, initial), 1); near(residualSupply(initial * .02, initial), 1);
    near(residualSupply(initial * .0125, initial), Math.sqrt(.5));
    near(residualSupply(initial * .005, initial), 0); near(residualSupply(0, initial), 0);
    let previous = 0;
    for (let step = 0; step <= 100; step++) {
      const factor = residualSupply(initial * step / 1000, initial);
      assert.ok(factor >= previous && factor >= 0 && factor <= 1); previous = factor;
    }
  }
  assert.equal(residualSupply(0, 0), 0);
});

test('main pump scales from custom initial loads, in both propellants, and combines with faults', () => {
  for (const type of ['hydrogen', 'water']) {
    const e = new NTRSimulation(); e.reset(true); e.configure(type, 1.4); e.setLoadout(2000);
    e.fuel = 25; e.mode = 'RUNNING'; e.autoProtection = false;
    near(e.fuelPercent, 1.25); near(e.fuelPumpEfficiency, Math.sqrt(.5));
    e.tick(.05); near(e.commandedFlow, e.ratedFlow * .7 * Math.sqrt(.5));
    e.fuel = 25; e.injectFault('pump'); near(e.fuelPumpEfficiency, Math.sqrt(.5) * .23);
    e.pump = false; assert.equal(e.fuelPumpEfficiency, 0);
    e.pump = true; e.repairAll(); e.fuel = e.fuelReserve + .01; e.feedNominal = e.ratedFlow;
    const before = e.fuel; e.tick(.05); near(e.fuel, e.fuelReserve); near(before - e.fuel, e.feedFlow * .05);
    e.tick(.05); near(e.flow, 0); near(e.thrust, 0); near(e.fuel, e.fuelReserve);
    assert.equal(e.start().ok, false); // Already running, and reserve has no usable fuel.
    e.scram(); assert.equal(e.start().ok, false);
  }
});

test('oxygen has an independent initial percentage and reserve; it cannot consume the last 0.5%', () => {
  const e = new NTRSimulation(); e.reset(true); e.setLoadout(5000, 1000); e.start(); run(e, 30);
  e.oxygen = 12.5; e.oxygenPump = true; e.oxygenValve = 50;
  near(e.oxygenPercent, 1.25); near(e.oxygenSupplyFactor, Math.sqrt(.5)); assert.equal(e.fuelSupplyFactor, 1);
  e.tick(.05); near(e.commandedOxygenFlow, e.ratedOxygenFlow * .5 * Math.sqrt(.5)); assert.ok(e.afterburnerPower > 0);
  e.oxygen = e.oxygenReserve + .01; e.oxygenFeedFlow = 100; e.tick(.05);
  near(e.oxygen, e.oxygenReserve); e.tick(.05); near(e.oxygenFlow, 0); near(e.afterburnerPower, 0);
  assert.match(e.oxygenInterlock, /残留/); assert.ok(e.thrust > 0); assert.ok(e.isActive);
});

test('a full burn reaches the finite reserve and auto-settles while preserving its mass and refund', () => {
  const e = new NTRSimulation(), m = new NTRChallenge(e, { type: 'precision', fuelLoad: 500 });
  Object.assign(e, { demand: 20, valve: 70, pump: true, cooling: true, autoProtection: false });
  assert.ok(m.startEngine().ok); run(m, 200);
  assert.ok(m.complete); near(m.result.fuel, 2.5); near(m.result.fuelPoints, 2.5);
  near(m.result.finalMass, 10002.5); near(e.consumed + e.fuel, 500); assert.match(m.result.reason, /残气/);
});

test('ACK silences current alarms and a newly appearing warning re-arms them', () => {
  const e = new NTRSimulation(); e.injectFault('pump'); e.refreshAlarms(); e.acknowledge();
  assert.ok(e.acknowledged); e.refreshAlarms(); assert.ok(e.acknowledged);
  e.pressure = 7; e.refreshAlarms(); assert.equal(e.acknowledged, false);
  e.acknowledge(); e.fuel = e.fuelCapacity * .01; e.refreshAlarms(); assert.equal(e.acknowledged, false);
  assert.ok(e.alarms.includes('fuelResidual')); e.acknowledge(); e.refreshAlarms(); assert.ok(e.acknowledged);
});

test('sound follows actual H2, LANTR and steam flow, with separate alarm patterns and pause state', () => {
  const e = new NTRSimulation(); assert.equal(soundState(e).mode, 'hydrogen');
  e.oxygenFlow = 10; assert.equal(soundState(e).mode, 'lantr');
  e.propellant = 'water'; assert.equal(soundState(e).mode, 'water');
  e.injectFault('pump'); e.scram(); const state = soundState(e);
  assert.equal(state.alarms[0], 'scram'); assert.ok(state.alarms.includes('pumpFault'));
  const quiet = soundState(e, true); assert.deepEqual(quiet.alarms, []); assert.equal(quiet.flow, 0); assert.equal(quiet.oxygen, 0);
  const signatures = Object.values(ALARMS).map(a => a.type + a.tones.join(',') + a.length);
  assert.equal(new Set(signatures).size, signatures.length);
  e.acknowledge(); assert.ok(soundState(e).acknowledged);
});
