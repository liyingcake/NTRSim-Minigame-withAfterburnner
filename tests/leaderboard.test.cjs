const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRLeaderboard, LEADERBOARD_KEY } = require('../leaderboard.js');
const release = require('../version.js');
const manifest = require('../package.json');
const record = (id, overrides = {}) => ({ id, version: release.version, scoreSchema: release.scoreSchema, type: 'precision', propellant: 'hydrogen', total: 90000, deltaV: 325, elapsed: 70, initialFuel: 1000, fuel: 300, ...overrides });
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
