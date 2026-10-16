const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRLeaderboard, LEADERBOARD_KEY } = require('../leaderboard.js');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge } = require('../challenge.js');
const release = require('../version.js');
const manifest = require('../package.json');
const fixtureEngine = new NTRSimulation();
const fixtureFlight = new NTRChallenge(fixtureEngine, { type: 'precision' });
Object.assign(fixtureEngine, { pump: true, cooling: true, demand: 60, valve: 70 });
fixtureFlight.startEngine();
const fixture = fixtureFlight.settle().result;
const record = (id, overrides = {}) => {
  const r = { ...fixture, id, total: 90000, deltaV: 325, elapsed: 70, initialFuel: 1000, fuel: 300, ...overrides };
  return { ...r, engineModel: overrides.engineModel ?? ('NTR-II-' + Math.round(r.diameter * 100) + (r.propellant === 'water' ? 'W' : 'H')), finalMass: r.dryMass + r.fuel, consumedFuel: r.initialFuel - r.fuel };
};
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; };

test('release watermark, scoring schema and runtime version have one package source', () => {
  assert.equal(release.version, manifest.version); assert.equal(release.label, 'v' + manifest.version.replace(/\.0$/, ''));
  assert.equal(release.scoreSchema, manifest.nerva.scoreSchema); assert.ok(LEADERBOARD_KEY.includes(release.version));
});
test('records persist across sessions, reject duplicates and sort scores with time as tie-breaker', () => {
  const db = storage(), board = new NTRLeaderboard(db);
  board.add(record('a', { total: 80000 })); board.add(record('b')); board.add(record('c', { elapsed: 50 }));
  assert.equal(board.add(record('c')), false);
  const restored = new NTRLeaderboard(db);
  assert.deepEqual(restored.top('precision').map(r => r.id), ['c', 'b', 'a']);
  assert.equal(restored.persistent, true);
});
test('modes, propellants and versions stay separate', () => {
  const board = new NTRLeaderboard(storage());
  board.add(record('h')); board.add(record('w', { propellant: 'water' })); board.add(record('e', { type: 'endurance' }));
  assert.equal(board.add(record('old', { version: '0.2.0' })), false);
  assert.equal(board.add(record('old-schema', { scoreSchema: 2 })), false);
  assert.equal(board.top('precision').length, 2); assert.equal(board.top('endurance').length, 1);
  assert.deepEqual(board.top('precision', 'water').map(r => r.id), ['w']);
});
test('later low scores cannot evict an earlier high score', () => {
  const board = new NTRLeaderboard(storage()); board.add(record('best', { total: 99999 }));
  for (let i = 0; i < 240; i++) board.add(record('run-' + i, { total: i }));
  assert.equal(board.top('precision')[0].id, 'best'); assert.ok(board.records.length <= 200);
  assert.equal(board.top('precision').length, 10);
});
test('corrupt, invalid or unavailable browser storage cannot break game completion', () => {
  const broken = { getItem: () => 'not json', setItem: () => { throw new Error('blocked'); } };
  const board = new NTRLeaderboard(broken);
  assert.equal(board.add(record('local')), true); assert.equal(board.persistent, false);
  assert.equal(board.top('precision')[0].id, 'local');
  assert.equal(board.add(record('bad', { total: Infinity })), false);
  assert.equal(board.add(record('bad2', { fuel: 5000 })), false);
  assert.equal(new NTRLeaderboard().add(record('memory')), true);
});
test('complete flight configuration and scoring details survive reload and later engine changes', () => {
  const engine = new NTRSimulation();
  const flight = new NTRChallenge(engine, { type: 'precision', diameter: 2.4, fuelLoad: 595 });
  Object.assign(engine, { pump: true, cooling: true, demand: 60, valve: 70 }); flight.startEngine();
  for (let i = 0; i < 100 && !flight.complete; i++) flight.tick(1);
  assert.equal(flight.complete, true);
  const db = storage(), board = new NTRLeaderboard(db); assert.equal(board.add(flight.result), true);
  new NTRChallenge(engine, { propellant: 'water', diameter: .8 });
  const archived = new NTRLeaderboard(db).get(flight.result.id);
  assert.equal(archived.engineModel, 'NTR-II-240H'); assert.equal(archived.diameter, 2.4);
  assert.equal(archived.initialFuel, 595); assert.equal(archived.initialMass, 15595);
  assert.equal(archived.finalMass, archived.dryMass + 595 * .005); assert.equal(archived.consumedFuel, 595 * .995);
  assert.equal(archived.launchDemand, 60); assert.equal(archived.launchValve, 70);
  assert.ok(archived.peakThrust > 0 && archived.peakIsp > 0);
  assert.equal(archived.loadingCost, 5950); assert.equal(archived.base, flight.result.base);
  assert.equal(archived.total, flight.result.total); assert.ok(Object.isFrozen(archived));
  assert.equal(board.add(flight.result), false); assert.equal(board.get('missing'), null);
});
test('incomplete configuration records are rejected rather than showing invented details', () => {
  const board = new NTRLeaderboard(storage()), missing = record('missing'); delete missing.engineModel;
  assert.equal(board.add(missing), false);
  assert.equal(board.add(record('bad-diameter', { diameter: 9 })), false);
  assert.equal(board.add(record('bad-model', { engineModel: '<img>' })), false);
});
