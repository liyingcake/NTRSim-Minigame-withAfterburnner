/* Delayed interactive help, with a bounded chain of nested concept cards.
   Delegated events also cover controls created inside dialogs and reports. */
(function (root) {
  'use strict';
  const content = typeof module !== 'undefined' && module.exports ? require('./help-content.js') : root.NTR_HELP_CONTENT;
  const SELECTOR = 'button,input[type="range"],input[type="number"],input[type="checkbox"],select,summary';
  const MAX_DEPTH = 4;
  function place(anchor, size, viewport, nested = false) {
    const margin = 8, gap = 9, width = Math.min(size.width, Math.max(1, viewport.width - margin * 2)), height = Math.min(size.height, Math.max(1, viewport.height - margin * 2));
    let x = nested ? anchor.right + gap : anchor.left, y = nested ? anchor.top : anchor.bottom + gap;
    if (nested && x + width > viewport.width - margin) x = anchor.left - width - gap;
    if (!nested && y + height > viewport.height - margin) y = anchor.top - height - gap;
    return { x: Math.max(margin, Math.min(x, viewport.width - width - margin)), y: Math.max(margin, Math.min(y, viewport.height - height - margin)) };
  }
  class TooltipController {
    constructor({ document = root.document, i18n, getDelay = () => 1000, getShortcut = () => '', getContext = () => ({}), clock = root } = {}) {
      this.document = document; this.view = document.defaultView; this.i18n = i18n; this.getDelay = getDelay; this.getShortcut = getShortcut; this.getContext = getContext;
      this.clock = clock; this.cards = []; this.owner = null; this.serial = 0; this.handlers = [];
      this.on('pointerover', e => this.over(e)); this.on('pointerout', e => this.out(e));
      this.on('focusin', e => { if (!this.suppressFocus) this.over(e); }); this.on('focusout', e => this.out(e));
      this.on('pointerdown', e => { if (!e.target.closest?.('[data-tooltip-card]')) this.closeAll(); }, true);
      this.on('click', e => this.click(e)); this.on('keydown', e => this.key(e), true);
      this.on('close', e => { if (e.target.tagName === 'DIALOG') this.closeAll(); }, true);
      this.on('scroll', () => this.positionAll(), { capture: true, passive: true });
      this.resize = () => this.positionAll(); this.view.addEventListener('resize', this.resize);
      this.unsubscribe = i18n.subscribe(() => this.closeAll());
      this.harvest(document.documentElement);
      const Observer = this.view.MutationObserver;
      if (Observer) {
        this.observer = new Observer(records => {
          for (const r of records) if (r.type === 'attributes') {
            if (r.attributeName === 'open' && r.target.tagName === 'DIALOG' && !r.target.open) this.closeAll();
            else if (r.attributeName === 'title') this.harvest(r.target);
          } else for (const n of r.addedNodes) if (n.nodeType === 1) this.harvest(n);
          if (this.owner && !this.owner.isConnected) this.closeAll();
        });
        this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'open'] });
      }
    }
    on(type, handler, options = false) { this.document.addEventListener(type, handler, options); this.handlers.push([type, handler, options]); }
    clear(name) { if (this[name] !== undefined) this.clock.clearTimeout(this[name]); this[name] = undefined; }
    harvest(node) {
      // Suppress native tooltips so the configured delay remains authoritative.
      const elements = [node, ...node.querySelectorAll?.(SELECTOR) || []];
      for (const el of elements) if (el.matches?.(SELECTOR) && el.hasAttribute('title')) { el.dataset.helpNativeTitle = el.getAttribute('title'); el.removeAttribute('title'); }
    }
    visible(el) { const dialog = el.closest('dialog'); return el.isConnected && !el.closest('[hidden]') && (!dialog || dialog.open); }
    over(event) {
      const target = event.target;
      if (!target.closest) return;
      this.clear('closeTimer');
      const term = target.closest('[data-help-term]'), card = target.closest('[data-tooltip-card]');
      if (term && card) { this.queueTerm(term); return; }
      if (card) return;
      const owner = target.closest(SELECTOR);
      if (owner) this.enter(owner);
    }
    out(event) {
      const next = event.relatedTarget;
      if (next && (this.owner?.contains(next) || next.closest?.('[data-tooltip-card]'))) {
        if (!next.closest?.('[data-help-term]')) this.clear('termTimer');
        return;
      }
      this.clear('rootTimer'); this.clear('termTimer'); this.clear('closeTimer');
      this.closeTimer = this.clock.setTimeout(() => this.closeAll(), 280);
    }
    enter(owner) {
      if (this.owner === owner && (this.cards.length || this.rootTimer !== undefined)) return;
      this.closeAll(); this.owner = owner; this.harvest(owner);
      this.rootTimer = this.clock.setTimeout(() => {
        this.rootTimer = undefined;
        if (this.owner === owner && this.visible(owner)) this.open(content.describe(owner), owner, 0);
      }, Math.max(0, this.getDelay()));
    }
    delayChanged() { const owner = this.owner; if (owner && !this.cards.length) { this.closeAll(); this.enter(owner); } }
    queueTerm(term) {
      const index = Number(term.closest('[data-tooltip-card]').dataset.tooltipCard) + 1;
      if (index >= MAX_DEPTH || this.cards[index]?.anchor === term) return;
      this.clear('termTimer');
      this.termTimer = this.clock.setTimeout(() => { this.termTimer = undefined; if (term.isConnected) this.openConcept(term, index); }, Math.min(600, Math.max(0, this.getDelay())));
    }
    openConcept(term, index) { const item = content.concepts[term.dataset.helpTerm]; if (item && index < MAX_DEPTH) this.open(item, term, index); }
    click(event) {
      const close = event.target.closest?.('[data-help-close]'), term = event.target.closest?.('[data-help-term]');
      if (close) { event.preventDefault(); event.stopPropagation(); this.closeFrom(Number(close.dataset.helpClose), event.detail === 0); }
      else if (term) { event.preventDefault(); event.stopPropagation(); this.clear('termTimer'); this.openConcept(term, Number(term.closest('[data-tooltip-card]').dataset.tooltipCard) + 1); }
    }
    key(event) {
      if (!this.cards.length) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.closeFrom(this.cards.length - 1, true); }
      else if (event.key === 'Tab' && !event.shiftKey) {
        const card = this.cards.find(record => record.anchor === this.document.activeElement);
        if (card) { event.preventDefault(); event.stopImmediatePropagation(); (card.node.querySelector('[data-help-term]') || card.node.querySelector('[data-help-close]')).focus(); }
      }
    }
    body(parent, source) {
      const text = this.i18n.pair(source), regex = /\[\[([a-zA-Z]+)\]\]/g; let position = 0, match;
      while ((match = regex.exec(text))) {
        parent.append(this.document.createTextNode(text.slice(position, match.index)));
        const concept = content.concepts[match[1]];
        if (concept) {
          const link = this.document.createElement('button'); link.type = 'button'; link.className = 'help-concept'; link.dataset.helpTerm = match[1];
          link.textContent = this.i18n.pair(concept.title); link.setAttribute('aria-haspopup', 'dialog'); link.setAttribute('aria-expanded', 'false'); parent.append(link);
        }
        position = regex.lastIndex;
      }
      parent.append(this.document.createTextNode(text.slice(position)));
    }
    open(item, anchor, index) {
      if (index >= MAX_DEPTH || !anchor.isConnected) return;
      this.closeFrom(index); if (index === 0) this.owner = anchor;
      const card = this.document.createElement('div'), id = 'ntr-help-' + (++this.serial);
      card.id = id; card.className = 'help-card'; card.dataset.tooltipCard = index; card.dataset.i18nSkip = ''; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'false'); card.setAttribute('aria-labelledby', id + '-title'); card.setAttribute('popover', 'manual');
      const top = this.document.createElement('div'); top.className = 'help-heading';
      const title = this.document.createElement('strong'); title.id = id + '-title'; title.textContent = this.i18n.pair(item.title); top.append(title);
      const close = this.document.createElement('button'); close.type = 'button'; close.className = 'help-close'; close.dataset.helpClose = index; close.textContent = '×'; close.setAttribute('aria-label', this.i18n.pair(['关闭这层说明', 'Close this help layer'])); top.append(close); card.append(top);
      const paragraph = this.document.createElement('p'); this.body(paragraph, item.body); card.append(paragraph);
      if (index === 0 && anchor.disabled) {
        const status = this.document.createElement('p'); status.className = 'help-unavailable';
        status.textContent = this.i18n.pair(this.getContext().complete ? ['本局已结算；请重试或开始新挑战。', 'This flight is settled. Retry or start a new challenge.'] : ['当前不可用；请检查该项的配置或运行联锁。', 'Currently unavailable. Check this control’s configuration or operating interlocks.']); card.append(status);
      }
      const footer = this.document.createElement('div'); footer.className = 'help-footer';
      const shortcut = index === 0 ? this.getShortcut(anchor) : '';
      footer.textContent = (shortcut ? this.i18n.pair(['快捷键 ', 'Shortcut ']) + shortcut + ' · ' : '') + this.i18n.pair(index === MAX_DEPTH - 1 ? ['Esc 返回上一层', 'Esc: previous layer'] : ['高亮词可展开 · Tab 进入 · Esc 关闭', 'Explore terms · Tab to enter · Esc to close']); card.append(footer);
      if (index === MAX_DEPTH - 1) for (const link of card.querySelectorAll('[data-help-term]')) { const span = this.document.createElement('span'); span.className = 'help-concept-limit'; span.textContent = link.textContent; link.replaceWith(span); }
      const host = anchor.closest('dialog[open]') || this.document.body; host.append(card);
      const previousDescription = anchor.getAttribute('aria-describedby'); anchor.setAttribute('aria-describedby', [previousDescription, id].filter(Boolean).join(' '));
      if (anchor.dataset.helpTerm) anchor.setAttribute('aria-expanded', 'true');
      this.cards.push({ node: card, anchor, previousDescription });
      if (typeof card.showPopover === 'function') { try { card.showPopover(); } catch { card.removeAttribute('popover'); } } else card.removeAttribute('popover');
      this.positionAll();
    }
    positionAll() {
      const viewport = { width: this.view.innerWidth || this.document.documentElement.clientWidth || 1024, height: this.view.innerHeight || this.document.documentElement.clientHeight || 768 };
      for (const [index, record] of this.cards.entries()) {
        if (!record.anchor.isConnected) { this.closeFrom(index); break; }
        record.node.style.maxWidth = Math.max(120, viewport.width - 16) + 'px'; record.node.style.maxHeight = Math.max(80, viewport.height - 16) + 'px';
        const box = record.node.getBoundingClientRect(), anchor = index ? this.cards[index - 1].node.getBoundingClientRect() : record.anchor.getBoundingClientRect();
        const point = place(anchor, { width: box.width || 340, height: box.height || 240 }, viewport, index > 0);
        record.node.style.left = point.x + 'px'; record.node.style.top = point.y + 'px';
      }
    }
    closeFrom(index, restoreFocus = false) {
      this.clear('termTimer');
      const anchor = this.cards[index]?.anchor;
      for (const record of this.cards.splice(index)) {
        if (record.previousDescription === null) record.anchor.removeAttribute('aria-describedby'); else record.anchor.setAttribute('aria-describedby', record.previousDescription);
        if (record.anchor.dataset.helpTerm) record.anchor.setAttribute('aria-expanded', 'false');
        record.node.remove();
      }
      if (index === 0) { this.clear('rootTimer'); this.clear('closeTimer'); this.owner = null; }
      if (restoreFocus && anchor?.isConnected) { this.suppressFocus = true; anchor.focus?.({ preventScroll: true }); this.suppressFocus = false; }
    }
    closeAll() { this.clear('rootTimer'); this.clear('termTimer'); this.clear('closeTimer'); this.closeFrom(0); }
    destroy() { this.closeAll(); this.observer?.disconnect(); this.unsubscribe(); for (const [type, handler, options] of this.handlers) this.document.removeEventListener(type, handler, options); this.view.removeEventListener('resize', this.resize); }
  }
  const api = { TooltipController, SELECTOR, MAX_DEPTH, place };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_TOOLTIPS = api;
})(typeof window !== 'undefined' ? window : globalThis);
