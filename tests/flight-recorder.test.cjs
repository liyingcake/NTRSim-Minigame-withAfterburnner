const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge } = require('../challenge.js');
const { engineMass } = require('../flight-recorder.js');
const { FlightArchive, telemetryCSV } = require('../flight-archive.js');
const near = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
function prepare(fuelLoad = 1000) {
  const e = new NTRSimulation(), m = new NTRChallenge(e, { type: 'precision', fuelLoad, oxygenLoad: 2000, payload: 1234 });
  e.setSwitch('pump', true, 'keyboard'); e.setSwitch('cooling', true); e.setControl('demand', 60); e.setControl('valve', 70);
  e.setSwitch('oxygenPump', true); e.setControl('oxygenValve', 30); return { e, m };
}
test('engine base spans 1–10 tonnes, with physical nozzle and cargo added separately', () => {
  near(engineMass(.8), 1000); near(engineMass(2.4), 10000); near(engineMass(1.4), 3320.3125);
  for (const diameter of [.8, 1.4, 2.4]) {
    const e = new NTRSimulation(); e.reset(true); e.configure('hydrogen', diameter);
    assert.equal(e.baseDryMass, 5000); near(e.dryMass, 5000 + engineMass(diameter) + e.nozzleMass);
    near(e.mass, e.dryMass + e.fuel);
    const m = new NTRChallenge(e, { type: 'lunar', diameter, payload: 20000, fuelLoad: 5000, oxygenLoad: 2000 });
    near(m.dryMass, 25000 + engineMass(diameter) + e.nozzleMass); near(m.mass, m.dryMass + 7000);
  }
});
test('sandbox acceleration and recorder integrate the same thrust and changing total mass as challenges', () => {
  const { e, m } = prepare(); m.startEngine();
  for (let i = 0; i < 420; i++) m.tick(1 / 60);
  near(e.flight.deltaV, m.deltaV); near(e.flight.distance, m.distance); near(e.flight.elapsed, m.elapsed);
  near(e.acceleration, m.acceleration); near(e.flight.impulse, e.totalImpulse);
  const sandbox = new NTRSimulation(); sandbox.tick(5);
  near(sandbox.acceleration, sandbox.thrust * 1000 / (5000 + sandbox.engineMass + sandbox.fuel));
  assert.ok(sandbox.flight.deltaV > 0); assert.equal(sandbox.payload, 0);
  near(sandbox.flight.first[0][27], sandbox.ratedFlow * .7);
});
test('recording starts with ignition, captures executed commands, and freezes launch configuration', () => {
  const { e, m } = prepare();
  assert.equal(e.flight.elapsed, 0); assert.equal(e.flight.first.length, 0);
  m.startEngine(); e.setControl('demand', 45); e.setControl('oxygenValve', 10); m.tick(1);
  const report = e.flight.snapshot(e);
  assert.equal(report.initial.demand, 60); assert.equal(report.final.demand, 45);
  assert.equal(report.initial.mainTankInitial, 1000); assert.equal(report.initial.oxygenTankInitial, 2000);
  assert.equal(report.initial.payload, 1234);
  const setup = report.operations.find(o => o.action === 'missionSetup');
  assert.equal(setup.value.cooling, false); assert.equal(setup.value.power, 0); assert.equal(setup.value.initialFuel, 1000);
  const terminal = report.telemetry.last120.at(-1);
  near(terminal[27], e.commandedFlow); near(terminal[28], e.commandedOxygenFlow); near(terminal[29], e.ratedPower * .45);
  assert.ok(report.operations.some(o => o.action === 'pump' && o.phase === 'PREPARING' && o.source === 'keyboard'));
  assert.ok(report.operations.some(o => o.action === 'demand' && o.value === 45 && o.phase === 'FLIGHT'));
  assert.ok(Object.isFrozen(report.telemetry.first60[0])); assert.ok(Object.isFrozen(report.initial));
  e.setControl('demand', 80); assert.equal(report.final.demand, 45);
});
test('long flights retain the first 60 seconds and the rolling final 120 seconds at 2 Hz', () => {
  const e = new NTRSimulation(); e.reset(true); e.setControl('demand', 20); e.setControl('valve', 100); e.start();
  for (let i = 0; i < 6017; i++) e.step(.05);
  const r = e.flight.snapshot(e), first = r.telemetry.first60, last = r.telemetry.last120;
  near(r.stats.elapsed, 300.85, 1e-6); assert.equal(first.length, 121); assert.ok(last.length <= 242);
  near(first[0][0], 0); near(first.at(-1)[0], 60, 1e-6);
  assert.ok(last[0][0] >= 180.85 - 1e-6); near(last.at(-1)[0], r.stats.elapsed);
  assert.ok(e.flight.last.length <= 241); assert.ok(e.flight.first.length <= 121);
  for (let i = 1; i < first.length; i++) near(first[i][0] - first[i - 1][0], .5, 1e-6);
});
test('settlement preserves delivered impulse, complete mass details, statistics and an immutable final log', () => {
  const { e, m } = prepare(200); m.startEngine();
  for (let i = 0; i < 200 && !m.complete; i++) m.tick(1);
  assert.ok(m.complete); const r = m.result, data = r.flightReport;
  near(data.stats.deltaV, r.deltaV); near(data.stats.elapsed, r.elapsed); near(data.stats.totalImpulse, e.totalImpulse);
  assert.equal(r.flightId, data.id); near(r.initialMass, 5000 + e.engineMass + 1234 + 2200);
  near(r.meanThrust, r.totalImpulse / r.elapsed); assert.ok(r.burnMeanThrust >= r.meanThrust);
  assert.ok(r.effectiveIsp > 0); assert.ok(data.operations.some(o => o.action === 'settle'));
  assert.ok(data.operations.some(o => o.action === 'event' && String(o.value).includes('挑战完成')));
  const count = data.operations.length; e.tick(5); e.acknowledge();
  assert.equal(data.operations.length, count); near(e.flight.elapsed, r.elapsed); assert.ok(e.flight.finished);
});
test('CSV joins overlapping windows exactly once and includes terminal samples with declared columns', () => {
  const { e, m } = prepare(); m.startEngine(); m.tick(1); m.tick(.23);
  const report = e.flight.snapshot(e), lines = telemetryCSV(report).trim().split('\r\n');
  assert.equal(lines.length, 5); assert.equal(lines[0].replace(/^\uFEFF/, ''), report.telemetry.columns.join(','));
  const times = lines.slice(1).map(l => +l.split(',')[0]); near(times.at(-1), 1.23);
  assert.equal(new Set(times).size, times.length);
  for (const line of lines.slice(1)) { assert.equal(line.split(',').length, report.telemetry.columns.length); assert.ok(line.split(',').every(c => Number.isFinite(+c))); }
});
test('unavailable persistent storage keeps complete reports usable and JSON export lossless', async () => {
  const { e, m } = prepare(); m.startEngine(); m.tick(2); const report = e.flight.snapshot(e);
  const archive = new FlightArchive(null); assert.equal(await archive.save(report), false);
  assert.equal(await archive.get(report.id), report); assert.deepEqual(await archive.list(), [report]);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report); assert.equal(await archive.get('missing'), null);
});
