/* Browser-local preferences shared by every release. Physical key codes keep
   controls stable across input languages. No keyboard polling. */
(function (root) {
  'use strict';
  const KEY = 'nerva.preferences.v1';
  const ACTIONS = Object.freeze({
    pump: ['推进剂泵', 'KeyQ', 'pumpToggle'], cooling: ['冷却回路', 'KeyW', 'coolingToggle'],
    protection: ['自动保护', 'KeyE', 'autoToggle'], oxygenPump: ['液氧泵', 'KeyR', 'oxygenPumpToggle'],
    acknowledge: ['确认告警 ACK', 'KeyA', 'ackButton'], ignition: ['启动 / 正常停机', 'KeyS', 'runButton'],
    scram: ['紧急停堆', 'KeyX', 'scramButton'], pause: ['暂停 / 继续', 'Space', 'pauseButton'],
    speed: ['切换模拟速度', 'KeyT', 'speedButton'], settings: ['打开设置', 'KeyK', 'settingsButton'],
    manual: ['操作手册', 'Slash', 'manualButton'],
    overview: ['MFD · 系统总览', 'Digit1'], thermal: ['MFD · 热力回路', 'Digit2'], propulsion: ['MFD · 推进性能', 'Digit3'],
    trend: ['MFD · 遥测趋势', 'Digit4'], diagnostics: ['MFD · 故障诊断', 'Digit5'], lantr: ['MFD · 补燃储罐', 'Digit6']
  });
  const DEFAULT_BINDINGS = Object.freeze(Object.fromEntries(Object.entries(ACTIONS).map(([id, a]) => [id, a[1]])));
  const allowed = code => /^(Key[A-Z]|Digit[0-9]|F(?:[7-9]|1[0-2])|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(code);
  const keyLabel = code => code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5)
    : ({ Space: '空格', Minus: '−', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' }[code] || code);
  const clampVolume = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  class NTRSettings {
    constructor(storage) {
      this.storage = storage; this.persistent = Boolean(storage);
      this.environmentVolume = .35; this.alarmVolume = .55; this.bindings = { ...DEFAULT_BINDINGS };
      this.language = 'zh'; this.tooltipDelay = 1000;
      try {
        const saved = JSON.parse(storage?.getItem(KEY) || 'null');
        if (saved) {
          this.environmentVolume = clampVolume(saved.environmentVolume, .35); this.alarmVolume = clampVolume(saved.alarmVolume, .55);
          if (['zh', 'en'].includes(saved.language)) this.language = saved.language;
          if (Number.isFinite(saved.tooltipDelay)) this.tooltipDelay = Math.round(Math.max(0, Math.min(10000, saved.tooltipDelay)));
          if (saved.bindings && Object.keys(ACTIONS).every(id => allowed(saved.bindings[id])) && new Set(Object.values(saved.bindings)).size === Object.keys(ACTIONS).length) this.bindings = Object.fromEntries(Object.keys(ACTIONS).map(id => [id, saved.bindings[id]]));
        }
      } catch { this.persistent = false; }
    }
    save() {
      try { this.storage?.setItem(KEY, JSON.stringify({ environmentVolume: this.environmentVolume, alarmVolume: this.alarmVolume, bindings: this.bindings, language: this.language, tooltipDelay: this.tooltipDelay })); }
      catch { this.persistent = false; }
    }
    setVolume(channel, value) {
      if (!['environment', 'alarm'].includes(channel) || !Number.isFinite(value)) return;
      this[channel + 'Volume'] = clampVolume(value, this[channel + 'Volume']); this.save();
    }
    setLanguage(language) { if (!['zh', 'en'].includes(language)) return false; this.language = language; this.save(); return true; }
    setTooltipDelay(value) { if (!Number.isFinite(value)) return; this.tooltipDelay = Math.round(Math.max(0, Math.min(10000, value))); this.save(); }
    bind(action, code) {
      if (!ACTIONS[action] || !allowed(code)) return { ok: false, message: '请选择字母、数字、空格或符号键；F1–F6 保留切换 MFD。' };
      const duplicate = Object.keys(this.bindings).find(id => id !== action && this.bindings[id] === code);
      if (duplicate) return { ok: false, message: keyLabel(code) + ' 已用于「' + ACTIONS[duplicate][0] + '」，请换一个键。' };
      this.bindings[action] = code; this.save(); return { ok: true, message: ACTIONS[action][0] + ' → ' + keyLabel(code) };
    }
    resetBindings() { this.bindings = { ...DEFAULT_BINDINGS }; this.save(); }
    actionFor(event) {
      if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
      const target = event.target;
      if (target?.closest?.('[data-tooltip-card]')) return null;
      if (target?.isContentEditable || /TEXTAREA|SELECT/.test(target?.tagName || '') || target?.tagName === 'INPUT' && target.type !== 'range') return null;
      if (event.code === 'Space' && target?.closest?.('button')) return null;
      return Object.keys(this.bindings).find(id => this.bindings[id] === event.code) || null;
    }
  }
  const api = { NTRSettings, ACTIONS, DEFAULT_BINDINGS, keyLabel, allowed, KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_PREFERENCES = api;
})(typeof window !== 'undefined' ? window : globalThis);
