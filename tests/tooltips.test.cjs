const { test } = require('node:test'), assert = require('node:assert/strict');
const { Localizer } = require('../localization.js'), { TooltipController, place, MAX_DEPTH } = require('../tooltips.js');
const { concepts, controls } = require('../help-content.js');
const { Clock, dom, boot, flush } = require('./ui-harness.cjs');
function setup(html = '<html><body><button id="pumpToggle" title="旧提示">泵</button><button id="other">其他</button></body></html>') {
  const { window, document } = dom(html), clock = new Clock(), i18n = new Localizer({ document }); i18n.mount(); let delay = 3000;
  const help = new TooltipController({ document, i18n, clock, getDelay: () => delay, getShortcut: () => 'Z' });
  return { window, document, clock, i18n, help, setDelay: value => delay = value, destroy: () => { help.destroy(); i18n.destroy(); } };
}
function event(env, element, type, values = {}) {
  const e = new env.window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, values); element.dispatchEvent(e); return e;
}
test('root help waits exactly the configured time and suppresses native title tooltips', () => {
  const env = setup(), owner = env.document.querySelector('#pumpToggle');
  assert.equal(owner.hasAttribute('title'), false); event(env, owner, 'pointerover'); env.clock.advance(2999); assert.equal(env.help.cards.length, 0);
  env.clock.advance(1); assert.equal(env.help.cards.length, 1); assert.match(owner.getAttribute('aria-describedby'), /^ntr-help-/);
  assert.match(env.help.cards[0].node.textContent, /Z/); event(env, owner, 'pointerover'); assert.equal(env.help.cards.length, 1); env.destroy();
});
test('leaving before delay cancels help; moving into a card retains it through the pointer gap', () => {
  const env = setup(), owner = env.document.querySelector('#pumpToggle'); env.help.enter(owner); env.clock.advance(2000);
  event(env, owner, 'pointerout', { relatedTarget: env.document.body }); env.clock.advance(1500); assert.equal(env.help.cards.length, 0);
  env.help.enter(owner); env.clock.advance(3000); const card = env.help.cards[0].node;
  event(env, owner, 'pointerout', { relatedTarget: env.document.body }); env.clock.advance(100); event(env, card, 'pointerover'); env.clock.advance(500); assert.equal(env.help.cards.length, 1);
  event(env, card, 'pointerout', { relatedTarget: env.document.body }); env.clock.advance(280); assert.equal(env.help.cards.length, 0); assert.equal(owner.hasAttribute('aria-describedby'), false); env.destroy();
});
test('highlighted concepts open nested cards on hover or click; Escape closes one layer', () => {
  const env = setup(); env.help.enter(env.document.querySelector('#pumpToggle')); env.clock.advance(3000);
  const flow = env.help.cards[0].node.querySelector('[data-help-term="flow"]'); event(env, flow, 'pointerover'); env.clock.advance(599); assert.equal(env.help.cards.length, 1);
  env.clock.advance(1); assert.equal(env.help.cards.length, 2); assert.equal(flow.getAttribute('aria-expanded'), 'true');
  const throat = env.help.cards[1].node.querySelector('[data-help-term="throat"]'); throat.click(); assert.equal(env.help.cards.length, 3);
  const expansion = env.help.cards[2].node.querySelector('[data-help-term="expansion"]'); expansion.click(); assert.equal(env.help.cards.length, MAX_DEPTH);
  assert.equal(env.help.cards.at(-1).node.querySelectorAll('[data-help-term]').length, 0);
  event(env, expansion, 'keydown', { key: 'Escape' }); assert.equal(env.help.cards.length, 3); assert.equal(expansion.getAttribute('aria-expanded'), 'false');
  env.help.closeAll(); env.clock.advance(10000); assert.equal(env.help.cards.length, 0); env.destroy();
});
test('focus opens help, Tab enters concepts, and Escape restores focus without reopening', () => {
  const env = setup(), owner = env.document.querySelector('#pumpToggle'); owner.focus(); env.clock.advance(3000);
  const tab = event(env, owner, 'keydown', { key: 'Tab', shiftKey: false }); assert.ok(tab.defaultPrevented); assert.ok(env.document.activeElement.hasAttribute('data-help-term'));
  event(env, env.document.activeElement, 'keydown', { key: 'Escape' }); assert.equal(env.help.cards.length, 0); assert.equal(env.document.activeElement, owner);
  env.clock.advance(5000); assert.equal(env.help.cards.length, 0); env.destroy();
});
test('delay changes, zero delay, language switch and disabled controls behave consistently', () => {
  const env = setup(), owner = env.document.querySelector('#pumpToggle'); env.setDelay(0); owner.disabled = true; env.help.enter(owner); env.clock.advance(0);
  assert.equal(env.help.cards.length, 1); assert.match(env.help.cards[0].node.textContent, /当前不可用/);
  env.i18n.setLanguage('en'); assert.equal(env.help.cards.length, 0); env.help.enter(owner); env.clock.advance(0);
  assert.match(env.help.cards[0].node.textContent, /Currently unavailable/); assert.ok(!/[\u3400-\u9fff]/.test(env.help.cards[0].node.textContent)); env.destroy();
});
test('changing the delay restarts a pending hover with the new value', () => {
  const env = setup(); env.help.enter(env.document.querySelector('#pumpToggle')); env.clock.advance(1000);
  env.setDelay(500); env.help.delayChanged(); env.clock.advance(499); assert.equal(env.help.cards.length, 0);
  env.clock.advance(1); assert.equal(env.help.cards.length, 1); env.destroy();
});
test('modal controls host their help inside the dialog and closing it clears the chain', async () => {
  const env = setup('<html><body><dialog open id="d"><button id="settingsButton">设置</button></dialog></body></html>');
  env.help.enter(env.document.querySelector('button')); env.clock.advance(3000); assert.equal(env.help.cards[0].node.parentElement.id, 'd');
  env.document.querySelector('dialog').close(); await flush(); assert.equal(env.help.cards.length, 0); env.destroy();
});
test('placement flips nested cards and clamps every edge to the viewport', () => {
  const p = place({ left: 800, right: 950, top: 700, bottom: 730 }, { width: 340, height: 240 }, { width: 1000, height: 800 }, true);
  assert.ok(p.x < 800 && p.y + 240 <= 792);
  const narrow = place({ left: 100, right: 220, top: 150, bottom: 190 }, { width: 340, height: 240 }, { width: 280, height: 300 });
  assert.equal(narrow.x, 8); assert.ok(narrow.y >= 8 && narrow.y + 240 <= 292);
});
test('all bilingual concept links resolve and English explanations contain no untranslated Chinese', () => {
  for (const item of [...Object.values(controls), ...Object.values(concepts)]) for (const text of item.body) {
    for (const m of text.matchAll(/\[\[([a-zA-Z]+)\]\]/g)) assert.ok(concepts[m[1]], m[1]);
  }
  for (const item of [...Object.values(controls), ...Object.values(concepts)]) assert.ok(!/[\u3400-\u9fff]/.test(item.body[1] + item.title[1]));
});
test('nested help never dispatches engine shortcuts or steals the first Escape from a modal', async () => {
  const app = boot(); app.run('help.enter(document.querySelector("#pumpToggle"))'); app.clock.advance(3000);
  let card = app.document.querySelector('[data-tooltip-card]'); const before = app.window.nerva.sim.pump;
  event(app, card.querySelector('button'), 'keydown', { key: 'q', code: 'KeyQ' }); assert.equal(app.window.nerva.sim.pump, before);
  event(app, card.querySelector('button'), 'keydown', { key: 'Escape', code: 'Escape' });
  app.document.querySelector('#settingsButton').click(); app.run('help.enter(document.querySelector("#tooltipDelaySlider"))'); app.clock.advance(3000);
  card = app.document.querySelector('[data-tooltip-card]');
  assert.ok(event(app, card.querySelector('button'), 'keydown', { key: 'Escape', code: 'Escape' }).defaultPrevented); await flush();
  assert.equal(app.document.querySelectorAll('[data-tooltip-card]').length, 0); assert.ok(app.document.querySelector('#settingsDialog').open); app.destroy();
});
