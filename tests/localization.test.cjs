const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), acorn = require('acorn');
const { Localizer, hasHan } = require('../localization.js');
const { NTRSettings } = require('../settings.js');
const { dom, boot, flush } = require('./ui-harness.cjs');
const { describe } = require('../help-content.js');
const { SELECTOR } = require('../tooltips.js');
function remaining(document) {
  const found = [], walker = document.createTreeWalker(document.documentElement, 4); let node;
  while ((node = walker.nextNode())) if (!node.parentElement?.closest('script,style,[data-i18n-skip]') && hasHan(node.nodeValue)) found.push(node.nodeValue.trim());
  for (const el of document.querySelectorAll('[aria-label],[aria-description],[placeholder],meta[name="description"]'))
    for (const a of ['aria-label', 'aria-description', 'placeholder', 'content']) if (hasHan(el.getAttribute(a) || '')) found.push(el.getAttribute(a));
  return [...new Set(found)];
}
test('language and tooltip delay migrate old preferences and persist independently of key resets', () => {
  const data = new Map(), db = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }, p = new NTRSettings(db);
  assert.equal(p.language, 'zh'); assert.equal(p.tooltipDelay, 1000);
  p.setLanguage('en'); p.setTooltipDelay(1750); p.bind('pump', 'KeyZ'); p.resetBindings();
  const restored = new NTRSettings(db); assert.equal(restored.language, 'en'); assert.equal(restored.tooltipDelay, 1750);
  restored.setTooltipDelay(-1); assert.equal(restored.tooltipDelay, 0); restored.setTooltipDelay(12000); assert.equal(restored.tooltipDelay, 10000);
  restored.setTooltipDelay(NaN); assert.equal(restored.tooltipDelay, 10000); assert.equal(restored.setLanguage('xx'), false);
  const invalid = new NTRSettings({ getItem: () => '{"language":"xx","tooltipDelay":"bad"}', setItem() {} });
  assert.equal(invalid.language, 'zh'); assert.equal(invalid.tooltipDelay, 1000);
});
test('localization preserves whitespace, numbers and units and restores original Chinese exactly', () => {
  const { document } = dom('<html><body><p id="v">干重 12.50 t</p><button data-close="x" aria-label="关闭">×</button></body></html>');
  const l = new Localizer({ document }); l.mount(); l.setLanguage('en');
  assert.match(document.querySelector('#v').textContent, /12\.50 t/); assert.ok(!hasHan(document.querySelector('#v').textContent));
  assert.equal(document.querySelector('button').getAttribute('aria-label'), 'Close');
  l.setLanguage('zh'); assert.equal(document.querySelector('#v').textContent, '干重 12.50 t'); assert.equal(document.querySelector('button').getAttribute('aria-label'), '关闭');
  l.writeText(document.querySelector('#v'), '干重 98.25 t'); l.setLanguage('en'); l.setLanguage('zh'); assert.equal(document.querySelector('#v').textContent, '干重 98.25 t'); l.destroy();
});
test('source copy and static control help have catalog coverage', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'), { document } = dom(html), l = new Localizer({ document, language: 'en' });
  l.mount(); assert.deepEqual(remaining(document), []);
  for (const control of document.querySelectorAll(SELECTOR)) assert.equal(describe(control).known, true, control.outerHTML);
  const files = ['app.js', 'settings.js', 'simulation.js', 'challenge.js', 'systems.js', 'reliability.js', 'audio.js', 'flight-view.js', 'flight-archive.js'];
  const unresolved = [];
  function walk(node) {
    if (node.type === 'Literal' && typeof node.value === 'string' && hasHan(node.value) && hasHan(l.t(node.value))) unresolved.push(node.value);
    if (node.type === 'TemplateElement' && hasHan(node.value.cooked || '') && hasHan(l.t(node.value.cooked))) unresolved.push(node.value.cooked);
    for (const [key, child] of Object.entries(node)) if (key !== 'value' && child && typeof child === 'object') {
      if (Array.isArray(child)) { for (const n of child) if (n?.type) walk(n); }
      else if (child.type) walk(child);
    }
  }
  for (const f of files) walk(acorn.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { ecmaVersion: 'latest' }));
  assert.deepEqual([...new Set(unresolved)], []); l.destroy();
});
test('changing UI language translates live state and all MFD pages without changing the flight', async () => {
  const app = boot(), state = () => app.run('JSON.stringify([sim.time,sim.mode,sim.power,sim.coreTemperature,sim.fuel,sim.flow,sim.demand,sim.valve,sim.flight.id])');
  const before = state(); app.document.querySelector('#languageButton').click(); await flush();
  assert.equal(app.window.nerva.language, 'en'); assert.equal(app.document.documentElement.lang, 'en'); assert.deepEqual(remaining(app.document), []); assert.equal(state(), before);
  for (const [i, button] of [...app.document.querySelectorAll('[data-page]')].entries()) { button.click(); app.run(`drawMFD(${1000 + i * 200})`); }
  assert.ok(app.drawn.length > 0); assert.ok(app.drawn.every(s => !hasHan(s)));
  app.document.querySelector('#languageButton').click(); await flush(); assert.equal(app.document.querySelector('#runState').textContent, '稳定运行'); assert.equal(state(), before); app.destroy();
});
test('settings can switch language while open and save the delay for the next load', async () => {
  const app = boot(); app.document.querySelector('#settingsButton').click(); const dialog = app.document.querySelector('#settingsDialog');
  assert.ok(dialog.open); app.document.querySelector('#settingsLanguageButton').click();
  const range = app.document.querySelector('#tooltipDelaySlider'); range.value = '1.25'; range.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush();
  assert.ok(dialog.open); assert.equal(app.window.nerva.language, 'en'); assert.equal(app.window.nerva.tooltipDelay, 1250); assert.deepEqual(remaining(app.document), []);
  const saved = JSON.parse(app.storage.getItem('nerva.preferences.v1')); app.destroy(); const restored = boot(saved);
  assert.equal(restored.window.nerva.language, 'en'); assert.equal(restored.window.nerva.tooltipDelay, 1250); assert.equal(restored.document.querySelector('#languageButton').textContent, '🇬🇧 EN'); restored.destroy();
});
test('English challenge setup, faults, results and record views translate newly generated content', async () => {
  const app = boot({ language: 'en', tooltipDelay: 3000 });
  app.document.querySelector('#challengeModeButton').click(); await flush(); assert.deepEqual(remaining(app.document), []);
  app.document.querySelector('[data-challenge="precision"]').click(); app.document.querySelector('#beginChallengeButton').click();
  app.document.querySelector('#pumpToggle').click(); app.document.querySelector('#coolingToggle').click();
  for (const [id, value] of [['valveSlider', '70'], ['powerSlider', '30']]) { const el = app.document.querySelector('#' + id); el.value = value; el.dispatchEvent(new app.window.Event('input', { bubbles: true })); }
  app.document.querySelector('#runButton').click(); assert.ok(app.window.nerva.mission.started);
  app.document.querySelector('#settleButton').click(); await flush(); assert.ok(app.window.nerva.mission.complete); assert.deepEqual(remaining(app.document), []);
  app.document.querySelector('#resultFullRecordButton').click(); await flush(); assert.deepEqual(remaining(app.document), []);
  app.document.querySelector('[data-flight-tab="operations"]').click(); await flush(); assert.deepEqual(remaining(app.document), []);
  app.document.querySelector('#flightRecordDialog').close(); app.document.querySelector('#faultButton').click(); await flush(); assert.deepEqual(remaining(app.document), []);
  app.destroy();
});
