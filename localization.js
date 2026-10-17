/* Presentation-only localization. Raw physics values, record IDs, commands,
   telemetry channel names and stored flight reports never get translated. */
(function (root) {
  'use strict';
  const catalog = typeof module !== 'undefined' && module.exports ? require('./locale-en.js') : root.NTR_LOCALE_EN;
  const extra = {
    '切换语言': 'Switch language', '切换到英文': 'Switch to English', '切换到中文': 'Switch to Chinese',
    '02 / 工具提示': '02 / Tooltips', '03 / 快捷键': '03 / Keyboard shortcuts', '悬停延迟': 'Hover delay', '工具提示延迟': 'Tooltip delay',
    '01 / 语言与音量': '01 / Language and audio', '界面语言': 'Interface language', '界面语言设置': 'Interface language preference', '工具提示延迟设置': 'Tooltip delay preference',
    '指向按钮或滑条，等待设定时间显示说明。高亮概念词可悬停或点击展开次级说明，Esc 关闭。': 'Hover over a button or slider to see its help after this delay. Hover or click highlighted terms to open another explanation. Press Esc to close.',
    '语言、提示、快捷键与音量自动保存在此浏览器。': 'Language, tooltips, shortcuts and volume are saved in this browser.'
  };
  const ATTRIBUTES = ['aria-label', 'aria-description', 'placeholder', 'alt', 'content'];
  const hasHan = value => /[\u3400-\u9fff]/.test(value);
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  class Localizer {
    constructor({ language = 'zh', document = root.document, entries = catalog } = {}) {
      this.document = document; this.language = language === 'en' ? 'en' : 'zh';
      this.entries = { ...entries, ...extra }; this.cache = new Map(); this.nodes = new WeakMap(); this.attributes = new WeakMap(); this.listeners = new Set();
      const keys = Object.keys(this.entries).filter(hasHan).sort((a, b) => b.length - a.length);
      this.pattern = keys.length ? new RegExp(keys.map(escapeRegex).join('|'), 'g') : null;
    }
    pair(value) { return Array.isArray(value) ? value[this.language === 'en' ? 1 : 0] : this.t(value); }
    t(value) {
      const source = String(value ?? '');
      if (this.language === 'zh' || !hasHan(source)) return source;
      if (this.cache.has(source)) return this.cache.get(source);
      const trimmed = source.trim();
      let result = Object.hasOwn(this.entries, source) ? this.entries[source] : Object.hasOwn(this.entries, trimmed)
        ? source.replace(trimmed, this.entries[trimmed]) : this.pattern ? source.replace(this.pattern, key => this.entries[key]) : source;
      result = result.replace(/（/g, ' (').replace(/）/g, ')').replace(/[「」]/g, '"').replace(/：/g, ': ').replace(/；/g, '; ').replace(/，/g, ', ').replace(/。/g, '.').replace(/、/g, ', ');
      if (this.cache.size >= 2048) this.cache.clear(); this.cache.set(source, result); return result;
    }
    skipped(node) { return Boolean(node.parentElement?.closest('script,style,[data-i18n-skip]')); }
    textNode(node) {
      if (node.nodeType !== 3 || this.skipped(node)) return;
      const previous = this.nodes.get(node), source = previous && node.nodeValue === previous.last ? previous.source : node.nodeValue;
      const last = this.t(source); this.nodes.set(node, { source, last }); if (node.nodeValue !== last) node.nodeValue = last;
    }
    attr(element, name, source) {
      if (!ATTRIBUTES.includes(name)) { if (element.getAttribute(name) !== String(source)) element.setAttribute(name, String(source)); return; }
      let records = this.attributes.get(element); if (!records) this.attributes.set(element, records = {});
      if (source === undefined) { const actual = element.getAttribute(name); if (actual === null) return; const old = records[name]; source = old && actual === old.last ? old.source : actual; }
      const last = name === 'aria-label' && element.hasAttribute('data-close') && source === '关闭' && this.language === 'en' ? 'Close' : this.t(source);
      records[name] = { source: String(source), last }; if (element.getAttribute(name) !== last) element.setAttribute(name, last);
    }
    apply(node = this.document?.documentElement) {
      if (!node || node.nodeType === 1 && node.closest('[data-i18n-skip]')) return;
      if (node.nodeType === 3) { this.textNode(node); return; }
      const walker = this.document.createTreeWalker(node, 4); let text;
      while ((text = walker.nextNode())) this.textNode(text);
      const elements = [node, ...node.querySelectorAll?.(ATTRIBUTES.map(a => '[' + a + ']').join(',')) || []];
      for (const element of elements) if (element.nodeType === 1 && !element.closest('[data-i18n-skip]')) for (const name of ATTRIBUTES) if (element.hasAttribute(name)) this.attr(element, name);
    }
    writeText(element, source) {
      source = String(source ?? ''); const translated = this.t(source);
      if (element.textContent !== translated) element.textContent = translated;
      if (element.firstChild?.nodeType === 3) this.nodes.set(element.firstChild, { source, last: translated });
    }
    writeHTML(element, source) { element.innerHTML = source; this.apply(element); }
    mount() {
      if (!this.document) return;
      this.document.documentElement.lang = this.language === 'en' ? 'en' : 'zh-CN'; this.apply();
      const Observer = this.document.defaultView?.MutationObserver;
      if (Observer) {
        this.observer = new Observer(records => {
          for (const record of records) {
            if (record.type === 'characterData') this.textNode(record.target);
            else if (record.type === 'attributes' && !record.target.closest('[data-i18n-skip]')) this.attr(record.target, record.attributeName);
            else if (record.type === 'childList') for (const node of record.addedNodes) this.apply(node);
          }
        });
        this.observer.observe(this.document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
      }
    }
    setLanguage(language) {
      if (!['zh', 'en'].includes(language) || this.language === language) return false;
      this.language = language; this.cache.clear();
      if (this.document) { this.document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'; this.apply(); }
      for (const listener of this.listeners) listener(language); return true;
    }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    destroy() { this.observer?.disconnect(); this.listeners.clear(); }
  }
  const api = { Localizer, hasHan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_LOCALIZATION = api;
})(typeof window !== 'undefined' ? window : globalThis);
