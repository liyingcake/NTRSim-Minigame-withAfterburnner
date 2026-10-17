/* DOM integration harness only: no browser, rendering benchmark or FPS loop. */
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { parseHTML } = require('linkedom');
class Clock {
  constructor() { this.time = 0; this.id = 0; this.tasks = new Map(); }
  setTimeout(fn, delay = 0) { const id = ++this.id; this.tasks.set(id, { fn, at: this.time + delay }); return id; }
  clearTimeout(id) { this.tasks.delete(id); }
  advance(ms) {
    const target = this.time + ms; let count = 0;
    while (true) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at).find(([, t]) => t.at <= target);
      if (!next) break;
      if (++count > 10000) throw Error('Unexpected timer loop');
      this.time = next[1].at; this.tasks.delete(next[0]); next[1].fn();
    }
    this.time = target;
  }
}
function dom(html = '<html><head></head><body></body></html>') {
  const { window, document } = parseHTML(html);
  window.innerWidth = 1280; window.innerHeight = 900;
  let active = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => active, configurable: true });
  window.HTMLElement.prototype.focus = function () { active = this; this.dispatchEvent(new window.Event('focusin', { bubbles: true })); };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 100, top: 100, right: 220, bottom: 140, width: 120, height: 40 }; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.setCustomValidity = function (value) { this.validationMessage = value; };
  Object.defineProperty(window.HTMLElement.prototype, 'open', { get() { return this.hasAttribute('open'); }, set(value) { this.toggleAttribute('open', value); }, configurable: true });
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  Object.defineProperty(window.HTMLInputElement.prototype, 'valueAsNumber', { get() { return this.value === '' ? NaN : Number(this.value); }, configurable: true });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    get() { const options = [...this.querySelectorAll('option')]; return (options.find(o => o.hasAttribute('selected')) || options[0])?.getAttribute('value') || ''; },
    set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.getAttribute('value') === String(value)); }, configurable: true
  });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 1280, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 900, configurable: true });
  return { window, document };
}
function boot(saved = null) {
  const base = path.join(__dirname, '..'), html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  const { window, document } = dom(html), clock = new Clock(), data = new Map(saved ? [['nerva.preferences.v1', JSON.stringify(saved)]] : []);
  const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  window.localStorage = storage; window.indexedDB = undefined; window.location = { search: '', href: 'file:///D:/Ai/workspace/codex/NTRSim/NERVA.html' };
  window.setTimeout = clock.setTimeout.bind(clock); window.clearTimeout = clock.clearTimeout.bind(clock);
  window.performance = { now: () => 0 };
  const drawn = [], gradient = { addColorStop() {} };
  const context2d = new Proxy({ measureText: s => ({ width: String(s).length * 6 }), fillText: s => drawn.push(String(s)), createLinearGradient: () => gradient, createRadialGradient: () => gradient }, { get: (target, key) => target[key] || (() => {}) });
  window.HTMLCanvasElement.prototype.getContext = () => context2d;
  class ResizeObserver { constructor(fn) { this.fn = fn; } observe() { this.fn([{ contentRect: { width: 680, height: 420 } }]); } }
  class IntersectionObserver { constructor(fn) { this.fn = fn; } observe() { this.fn([{ isIntersecting: true }]); } }
  const globals = { window, document, console, atob, btoa, TextDecoder, TextEncoder, URL, URLSearchParams, Blob, location: window.location,
    performance: window.performance, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, devicePixelRatio: 1,
    ResizeObserver, IntersectionObserver, matchMedia: () => ({ matches: false }) };
  const context = vm.createContext(globals);
  for (const match of html.matchAll(/<script src="([^"]+)" defer><\/script>/g)) {
    new vm.Script(fs.readFileSync(path.join(base, match[1]), 'utf8'), { filename: match[1] }).runInContext(context);
    for (const key of Object.keys(window)) if (key.startsWith('NTR')) globals[key] = window[key];
  }
  return { window, document, clock, storage, drawn, run: source => vm.runInContext(source, context), destroy: () => vm.runInContext('help.destroy(); i18n.destroy()', context) };
}
async function flush() { await new Promise(setImmediate); }
module.exports = { Clock, dom, boot, flush };
