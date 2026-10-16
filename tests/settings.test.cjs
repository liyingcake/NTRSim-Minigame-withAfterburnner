const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NTRSettings, DEFAULT_BINDINGS, keyLabel } = require('../settings.js');
const storage = () => { const m = new Map(); return { getItem: key => m.get(key) || null, setItem: (key, value) => m.set(key, value) }; };
test('QWER switches, actions and independent audio levels have persistent defaults', () => {
  const s = new NTRSettings(storage());
  assert.deepEqual([s.bindings.pump, s.bindings.cooling, s.bindings.protection, s.bindings.oxygenPump], ['KeyQ', 'KeyW', 'KeyE', 'KeyR']);
  assert.equal(s.environmentVolume, .35); assert.equal(s.alarmVolume, .55); assert.equal(keyLabel('Space'), '空格');
});
test('rebinding rejects conflicts and browser navigation keys without changing the old binding', () => {
  const s = new NTRSettings(storage());
  for (const code of ['KeyW', 'F1', 'Escape', 'Tab', 'Enter', 'ArrowUp']) assert.equal(s.bind('pump', code).ok, false);
  assert.equal(s.bindings.pump, 'KeyQ'); assert.equal(s.bind('pump', 'KeyZ').ok, true);
  assert.equal(s.actionFor({ code: 'KeyZ' }), 'pump'); assert.equal(s.actionFor({ code: 'KeyQ' }), null);
});
test('custom controls and both volumes survive reload, reset only restores bindings', () => {
  const db = storage(), s = new NTRSettings(db);
  s.bind('pump', 'KeyZ'); s.setVolume('environment', 0); s.setVolume('alarm', .8);
  const restored = new NTRSettings(db); assert.equal(restored.bindings.pump, 'KeyZ');
  assert.equal(restored.environmentVolume, 0); assert.equal(restored.alarmVolume, .8);
  restored.resetBindings(); assert.deepEqual(restored.bindings, DEFAULT_BINDINGS); assert.equal(restored.alarmVolume, .8);
});
test('text editing, IME, held keys and browser modifier chords cannot trigger engine controls', () => {
  const s = new NTRSettings(storage());
  for (const event of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { target: { tagName: 'INPUT', type: 'number' } }, { target: { tagName: 'TEXTAREA' } }, { target: { isContentEditable: true } }]) assert.equal(s.actionFor({ code: 'KeyQ', ...event }), null);
  assert.equal(s.actionFor({ code: 'KeyQ', target: { tagName: 'INPUT', type: 'range' } }), 'pump');
  assert.equal(s.actionFor({ code: 'Space', target: { closest: () => ({ tagName: 'BUTTON' }) } }), null);
});
test('corrupt storage and duplicate saved bindings fall back safely; unavailable storage stays usable', () => {
  for (const value of ['{', JSON.stringify({ bindings: { ...DEFAULT_BINDINGS, pump: 'KeyW' } }), JSON.stringify({ bindings: { ...DEFAULT_BINDINGS, pump: 'Escape' } })]) {
    const s = new NTRSettings({ getItem: () => value, setItem: () => {} }); assert.deepEqual(s.bindings, DEFAULT_BINDINGS);
  }
  const s = new NTRSettings({ getItem: () => null, setItem: () => { throw Error('disabled'); } });
  s.bind('pump', 'KeyZ'); assert.equal(s.persistent, false); assert.equal(s.bindings.pump, 'KeyZ');
});
