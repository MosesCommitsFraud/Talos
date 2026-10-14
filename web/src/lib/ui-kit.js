// Talos UI kit for inline interactive answers (render_ui). Injected verbatim
// into the opaque frame before the model's own js; never runs in the app.
//
// window.talos.fmt    – locale-aware number formatting
// window.talos.chart  – bar / line / donut charts in the Talos look, drawn as
//                       SVG (no library, works offline, follows the theme live)
// window.talos.kit    – small DOM helpers (range fill, segmented controls)
//
// Every chart returns a handle with update(options), so a slider can redraw
// with new numbers without rebuilding the page. Series colours come from the
// --talos-chart-N tokens in fixed order and are never cycled.
(() => {
  const talos = (window.talos = window.talos || {});
  const NS = 'http://www.w3.org/2000/svg';
  const locale = (() => {
    try { return navigator.language || 'de-DE'; } catch (e) { return 'de-DE'; }
  })();

  // ── formatting ──
  const finite = (v) => typeof v === 'number' && isFinite(v);
  const nf = (opts) => { try { return new Intl.NumberFormat(locale, opts); } catch (e) { return new Intl.NumberFormat('de-DE', opts); } };
  const fmt = {
    number(v, digits) {
      if (!finite(v)) return '–';
      const d = digits == null ? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2) : digits;
      return nf({ maximumFractionDigits: d, minimumFractionDigits: 0 }).format(v);
    },
    compact(v) { return finite(v) ? nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v) : '–'; },
    currency(v, currency, digits) {
      return finite(v) ? nf({ style: 'currency', currency: currency || 'EUR', maximumFractionDigits: digits == null ? (Math.abs(v) >= 1000 ? 0 : 2) : digits }).format(v) : '–';
    },
    /** `v` is a fraction: 0.25 → "25 %". */
    percent(v, digits) { return finite(v) ? nf({ style: 'percent', maximumFractionDigits: digits == null ? 1 : digits }).format(v) : '–'; },
    unit(v, unit, digits) { return finite(v) ? fmt.number(v, digits) + (unit ? ' ' + unit : '') : '–'; },
  };
  talos.fmt = fmt;

  // ── DOM helpers ──
  const $ = (target) => (typeof target === 'string' ? document.querySelector(target) : target);
  const svgEl = (name, attrs, parent) => {
    const el = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const color = (i, opts) => (opts.colors && opts.colors[i]) || `var(--talos-chart-${(i % 8) + 1})`;
  const measure = () => { if (window.__talosMeasure) window.__talosMeasure(); };

  // Keep range inputs' fill (and bubble / step segments) in step with their
  // value. The invisible 2px knob travels a track 2px shorter than the
  // input, hence the ±1px offset.
  function fillRange(input) {
    const min = +input.min || 0, max = input.max === '' ? 100 : +input.max, v = +input.value;
    const ratio = max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    input.style.setProperty('--t-fill', `${ratio * 100}%`);
    input.style.setProperty('--t-fill-offset', `${1 - ratio * 2}px`);
    const wrap = input.parentElement;
    if (wrap && wrap.classList.contains('t-range')) {
      wrap.style.setProperty('--t-pos', `${ratio * 100}%`);
      // Write only on change: the observer below reacts to DOM changes, and
      // an unconditional write would feed it forever.
      const bubble = wrap.querySelector(':scope > .t-range-bubble');
      const label = bubble && rangeLabel(input);
      if (bubble && bubble.textContent !== label) bubble.textContent = label;
      const segs = wrap.querySelector(':scope > .t-steps-track');
      if (segs) {
        const k = Math.round(ratio * (segs.children.length - 1));
        [...segs.children].forEach((el, i) => { const c = i < k ? 'on' : i === k ? 'cur' : ''; if (el.className !== c) el.className = c; });
      }
    }
  }
  // The bubble shows what the UI shows next to the slider (its <output>), else
  // the value with data-unit.
  function rangeLabel(input) {
    const field = input.closest('.t-field');
    const out = field && field.querySelector('output, .t-value');
    if (out && out.textContent.trim()) return out.textContent.trim();
    return fmt.number(+input.value) + (input.dataset.unit ? ' ' + input.dataset.unit : '');
  }
  function stepCount(input) {
    const min = +input.min || 0, max = input.max === '' ? 100 : +input.max;
    const step = input.step === 'any' ? 0 : (+input.step || 1);
    return step > 0 ? Math.round((max - min) / step) + 1 : 0;
  }
  function enhanceRange(input) {
    if (input.hasAttribute('data-native') || (input.parentElement && input.parentElement.classList.contains('t-range'))) return;
    const wrap = document.createElement('span');
    wrap.className = 't-range';
    input.before(wrap);
    wrap.appendChild(input);
    const n = stepCount(input);
    if (input.classList.contains('t-steps') || (n >= 2 && n <= 12 && !input.hasAttribute('data-continuous'))) {
      wrap.classList.add('steps');
      const segs = document.createElement('span');
      segs.className = 't-steps-track';
      segs.setAttribute('aria-hidden', 'true');
      segs.innerHTML = '<i></i>'.repeat(Math.max(2, Math.min(40, n || 10)));
      wrap.appendChild(segs);
    } else {
      const bubble = document.createElement('span');
      bubble.className = 't-range-bubble';
      bubble.setAttribute('aria-hidden', 'true');
      wrap.appendChild(bubble);
    }
    const end = () => wrap.classList.remove('drag');
    input.addEventListener('pointerdown', () => { wrap.classList.add('drag'); fillRange(input); });
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('blur', end);
    // The UI updates its <output> in its own input handler — read it after.
    input.addEventListener('input', () => requestAnimationFrame(() => fillRange(input)));
    fillRange(input);
  }
  document.addEventListener('input', (e) => { if (e.target && e.target.type === 'range') fillRange(e.target); }, true);
  const fillAll = () => document.querySelectorAll('input[type=range]').forEach(fillRange);
  document.addEventListener('DOMContentLoaded', fillAll);
  window.addEventListener('load', fillAll);
  // Sliders a UI builds later (a re-render, a new tab of controls) and values
  // set from code (`slider.value = 70`) get their fill too.
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.MutationObserver) return;
    new MutationObserver(fillAll).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'min', 'max'] });
  });
  document.addEventListener('change', (e) => { if (e.target && e.target.type === 'range') fillRange(e.target); }, true);

  // ── self-wiring controls ──
  // Segmented controls, tabs, chips and steppers work without any code in the
  // UI: clicks update aria-pressed / aria-selected, an indicator glides to the
  // chosen item, and the group fires a bubbling `talos:change` event with
  // { value, values } — `el.addEventListener('talos:change', e => …)`.
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const valueOf = (b) => (b.dataset.value != null ? b.dataset.value : b.textContent.trim());
  const emit = (root, detail) => root.dispatchEvent(new CustomEvent('talos:change', { bubbles: true, detail }));
  function place(root, cls, sel) {
    let ind = root.querySelector(':scope > .' + cls);
    const on = root.querySelector(sel);
    if (!ind) { ind = document.createElement('span'); ind.className = cls; ind.setAttribute('aria-hidden', 'true'); root.prepend(ind); }
    if (!on) { ind.style.width = '0'; return; }
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  function syncSeg(root) { if (!root.classList.contains('t-ready')) root.classList.add('t-ready'); place(root, 't-seg-ind', ':scope > button[aria-pressed="true"], :scope > button.active'); }
  function syncTabs(root) {
    place(root, 't-tabs-ind', ':scope > button[aria-selected="true"]');
    const on = root.querySelector(':scope > button[aria-selected="true"]');
    root.querySelectorAll(':scope > button').forEach((b) => {
      b.setAttribute('role', 'tab');
      const panel = b.dataset.tab && document.querySelector(`[data-tab-panel="${CSS.escape(b.dataset.tab)}"]`);
      if (panel) panel.hidden = b !== on;
    });
  }
  // ── select → floating list ──
  const selProto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const idxProto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openSelect = null;
  function enhanceSelect(sel) {
    if (sel.multiple || sel.size > 1 || sel.hasAttribute('data-native') || sel.parentElement && sel.parentElement.classList.contains('t-select')) return;
    const wrap = document.createElement('span');
    wrap.className = 't-select';
    if (sel.style.width) wrap.style.width = sel.style.width;
    sel.before(wrap);
    wrap.appendChild(sel);
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't-select-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    btn.appendChild(label);
    wrap.appendChild(btn);
    if (sel.id) { const l = document.querySelector(`label[for="${CSS.escape(sel.id)}"]`); if (l) { l.addEventListener('click', (e) => { e.preventDefault(); btn.focus(); }); btn.setAttribute('aria-label', l.textContent.trim()); } }
    const update = () => {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
      btn.disabled = sel.disabled;
    };
    // Values set from code (`select.value = 'x'`) update the button too.
    Object.defineProperty(sel, 'value', { configurable: true, get() { return selProto.get.call(this); }, set(v) { selProto.set.call(this, v); update(); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return idxProto.get.call(this); }, set(v) { idxProto.set.call(this, v); update(); } });
    sel.addEventListener('change', update);
    if (window.MutationObserver) new MutationObserver(update).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
    update();

    let menu = null, active = -1, typed = '', typedAt = 0;
    const rows = () => (menu ? [...menu.querySelectorAll('[role=option]')] : []);
    const setActive = (i) => {
      const r = rows();
      if (!r.length) return;
      active = Math.max(0, Math.min(r.length - 1, i));
      r.forEach((el, k) => el.classList.toggle('active', k === active));
      r[active].scrollIntoView({ block: 'nearest' });
    };
    const close = (focus) => {
      if (!menu) return;
      menu.remove(); menu = null; openSelect = null;
      btn.setAttribute('aria-expanded', 'false');
      if (focus) btn.focus();
      measure();
    };
    const choose = (i) => {
      const r = rows()[i];
      if (!r || r.getAttribute('aria-disabled') === 'true') return;
      idxProto.set.call(sel, +r.dataset.index);
      update();
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      close(true);
    };
    const open = () => {
      if (menu || sel.disabled) return;
      if (openSelect) openSelect();
      menu = document.createElement('ul');
      menu.className = 't-select-menu';
      menu.setAttribute('role', 'listbox');
      [...sel.children].forEach((node) => {
        const add = (o) => {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.dataset.index = String(o.index);
          li.textContent = o.textContent;
          li.setAttribute('aria-selected', o.selected ? 'true' : 'false');
          if (o.disabled) li.setAttribute('aria-disabled', 'true');
          menu.appendChild(li);
        };
        if (node.tagName === 'OPTGROUP') {
          const g = document.createElement('li');
          g.className = 't-select-group';
          g.setAttribute('role', 'presentation');
          g.textContent = node.label;
          menu.appendChild(g);
          [...node.children].forEach(add);
        } else if (node.tagName === 'OPTION') add(node);
      });
      menu.addEventListener('pointermove', (e) => { const li = e.target.closest('[role=option]'); if (li) setActive(rows().indexOf(li)); });
      menu.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (li) choose(rows().indexOf(li)); });
      wrap.appendChild(menu);
      // Open upwards when the list would run past the view and there is room above.
      const r = wrap.getBoundingClientRect(), h = menu.offsetHeight, docH = document.documentElement.clientHeight;
      if (r.bottom + h + 8 > docH && r.top > h + 8) menu.classList.add('up');
      btn.setAttribute('aria-expanded', 'true');
      openSelect = () => close(false);
      setActive(Math.max(0, rows().findIndex((li) => li.getAttribute('aria-selected') === 'true')));
      measure();
    };
    btn.addEventListener('click', () => (menu ? close(true) : open()));
    btn.addEventListener('keydown', (e) => {
      const k = e.key;
      if (!menu) {
        if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); open(); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (k === 'Home') { e.preventDefault(); setActive(0); }
      else if (k === 'End') { e.preventDefault(); setActive(rows().length - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); }
      else if (k === 'Escape') { e.preventDefault(); close(true); }
      else if (k === 'Tab') close(false);
      else if (k.length === 1) {
        const now = Date.now();
        typed = (now - typedAt < 700 ? typed : '') + k.toLowerCase();
        typedAt = now;
        const i = rows().findIndex((li) => li.textContent.toLowerCase().startsWith(typed));
        if (i >= 0) setActive(i);
      }
    });
    document.addEventListener('pointerdown', (e) => { if (menu && !wrap.contains(e.target)) close(false); }, true);
  }

  function syncAll() {
    document.querySelectorAll('select').forEach(enhanceSelect);
    document.querySelectorAll('input[type=range]').forEach(enhanceRange);
    document.querySelectorAll('.t-seg').forEach(syncSeg);
    document.querySelectorAll('.t-tabs').forEach((t) => {
      if (!t.querySelector(':scope > button[aria-selected="true"]')) { const f = t.querySelector(':scope > button'); if (f) f.setAttribute('aria-selected', 'true'); }
      syncTabs(t);
    });
    document.querySelectorAll('.t-chips > button:not([aria-pressed])').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    document.querySelectorAll('input[type=range][data-ticks]:not([data-t-ticks])').forEach((r) => {
      const n = Math.max(2, Math.min(21, +r.dataset.ticks || 5));
      const t = document.createElement('div');
      t.className = 't-ticks';
      t.innerHTML = '<i></i>'.repeat(n);
      r.setAttribute('data-t-ticks', '');
      (r.parentElement && r.parentElement.classList.contains('t-range') ? r.parentElement : r).after(t);
    });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn || !btn.parentElement) return;
    const root = btn.parentElement;
    if (root.classList.contains('t-seg')) {
      root.querySelectorAll(':scope > button').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      syncSeg(root);
      emit(root, { value: valueOf(btn) });
    } else if (root.classList.contains('t-tabs')) {
      root.querySelectorAll(':scope > button').forEach((b) => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
      syncTabs(root);
      measure();
      emit(root, { value: valueOf(btn) });
    } else if (root.classList.contains('t-chips')) {
      const single = root.hasAttribute('data-single');
      const on = btn.getAttribute('aria-pressed') !== 'true';
      if (single) root.querySelectorAll(':scope > button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', single || on ? 'true' : 'false');
      const values = [...root.querySelectorAll(':scope > button[aria-pressed="true"]')].map(valueOf);
      emit(root, { value: valueOf(btn), values });
    } else if (root.classList.contains('t-stepper') && btn.dataset.step) {
      const input = root.querySelector('input');
      if (!input) return;
      const step = (+input.step || 1) * Math.sign(+btn.dataset.step || 1);
      let v = (+input.value || 0) + step;
      if (input.min !== '') v = Math.max(+input.min, v);
      if (input.max !== '') v = Math.min(+input.max, v);
      input.value = String(+v.toFixed(6));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    syncAll();
    if (window.MutationObserver) {
      let queued = false;
      new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; syncAll(); }); } })
        .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
    }
    if (window.ResizeObserver) new ResizeObserver(() => syncAll()).observe(document.body);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncAll);

  /** Count a number up to `to` (formatted with `format(v)`), e.g. after a slider moved. */
  function count(target, to, format, ms) {
    const el = $(target);
    if (!el) return;
    const f = format || ((v) => fmt.number(v));
    const from = +el.dataset.tValue || 0;
    el.dataset.tValue = String(to);
    if (reduced() || !finite(from) || !finite(to) || from === to) { el.textContent = f(to); return; }
    const dur = ms || 450, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = f(from + (to - from) * e);
      if (k < 1 && el.dataset.tValue === String(to)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  talos.kit = {
    fillRange,
    count,
    sync: syncAll,
    /** Wire a .t-seg group: onChange(value) gets the clicked button's data-value. */
    segmented(target, onChange) {
      const root = $(target);
      if (!root) return;
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || !root.contains(btn)) return;
        root.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
        onChange && onChange(btn.dataset.value != null ? btn.dataset.value : btn.textContent.trim());
      });
    },
  };

  // ── scales ──
  function niceTicks(min, max, count) {
    if (!finite(min) || !finite(max)) return [0, 1];
    if (min === max) { if (min === 0) max = 1; else { min = Math.min(0, min); max = Math.max(0, max); } }
    const span = max - min;
    const raw = span / (count || 5);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(12));
    return ticks;
  }
  const textWidth = (s, size) => String(s).length * (size || 11) * 0.56;
  const clip = (s, max) => { s = String(s == null ? '' : s); return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s; };

  // ── shared chart frame: container, legend, tooltip, resize ──
  function mount(target, opts, draw) {
    const host = $(target);
    if (!host) throw new Error('talos.chart: container ' + target + ' not found');
    let options = Object.assign({}, opts);
    host.classList.add('t-chart');
    // The first draw animates in (bars grow, lines draw); redraws from a
    // slider or update() are instant.
    let entered = false;
    const render = () => {
      host.innerHTML = '';
      const series = options.series || [];
      if (options.legend !== false && series.length > 1) {
        const legend = document.createElement('div');
        legend.className = 't-legend';
        legend.innerHTML = series.map((s, i) => `<span><i style="background:${color(i, options)}"></i>${esc(s.name)}</span>`).join('');
        host.appendChild(legend);
      }
      const tip = document.createElement('div');
      tip.className = 't-tooltip';
      const width = Math.max(240, host.clientWidth || 640);
      const ctx = {
        width,
        tooltip(html, x, y) {
          if (html == null) { tip.classList.remove('show'); host.classList.remove('t-hovering'); return; }
          tip.innerHTML = html;
          tip.classList.add('show');
          host.classList.add('t-hovering');
          const w = tip.offsetWidth, h = tip.offsetHeight;
          tip.style.left = Math.min(Math.max(0, x + 12), width - w) + 'px';
          tip.style.top = Math.max(0, y - h - 8) + 'px';
        },
      };
      try {
        draw(host, options, ctx);
      } catch (e) {
        host.innerHTML = '<div class="t-empty">Diagramm konnte nicht gezeichnet werden.</div>';
        throw e;
      }
      host.appendChild(tip);
      if (!entered) {
        entered = true;
        host.querySelectorAll('.t-line').forEach((l) => { try { l.style.setProperty('--t-len', Math.ceil(l.getTotalLength())); } catch (e) { /* not laid out */ } });
        host.classList.add('t-enter');
        setTimeout(() => host.classList.remove('t-enter'), 900);
      }
      measure();
    };
    render();
    let lastWidth = host.clientWidth;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (Math.abs(host.clientWidth - lastWidth) > 4) { lastWidth = host.clientWidth; render(); }
      }).observe(host);
    }
    return {
      update(next) { options = Object.assign({}, options, next); render(); },
      get options() { return options; },
    };
  }

  // A bar rounded only at its data end (t3code's rounded-t-sm), square at the
  // baseline.
  function barPath(x, y, w, h, end) {
    const r = Math.max(0, Math.min(3, w / 2, h / 2));
    if (end === 'right') return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    if (end === 'left') return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
    if (end === 'bottom') return `M${x},${y}H${x + w}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}Z`;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  const valueFormat = (opts) => opts.format || ((v) => fmt.unit(v, opts.unit, opts.digits));
  const tipRows = (title, rows) =>
    `<div class="t-tt-title">${esc(title)}</div>` +
    rows.map((r) => `<div class="t-tt-row"><i style="background:${r.color}"></i>${esc(r.name)}<b>${esc(r.value)}</b></div>`).join('');

  // ── bar (vertical or horizontal, grouped or stacked) ──
  function bar(target, opts) {
    return mount(target, opts, (host, o, ctx) => {
      const cats = o.categories || [];
      const series = (o.series || []).map((s) => ({ name: s.name || '', values: (s.values || []).map((v) => (finite(v) ? v : null)) }));
      if (!cats.length || !series.length) { host.innerHTML = '<div class="t-empty">Keine Daten</div>'; return; }
      const f = valueFormat(o);
      const stacked = !!o.stacked;
      let lo = 0, hi = 0;
      cats.forEach((_, ci) => {
        if (stacked) {
          let pos = 0, neg = 0;
          series.forEach((s) => { const v = s.values[ci] || 0; if (v >= 0) pos += v; else neg += v; });
          hi = Math.max(hi, pos); lo = Math.min(lo, neg);
        } else series.forEach((s) => { const v = s.values[ci]; if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
      });
      const ticks = niceTicks(o.min != null ? o.min : lo, o.max != null ? o.max : hi, 5);
      const t0 = ticks[0], t1 = ticks[ticks.length - 1];
      const W = ctx.width;
      const horizontal = o.horizontal != null ? o.horizontal : cats.some((c) => String(c).length > 12) || cats.length > 14;
      const showValues = o.valueLabels != null ? o.valueLabels : series.length === 1 && cats.length <= 12;

      host.classList.toggle('t-h', horizontal);
      if (horizontal) {
        const labelW = Math.min(W * 0.38, Math.max(...cats.map((c) => textWidth(clip(c, 32), 12))) + 10);
        const rowH = Math.max(18, Math.min(34, (o.barSize || 22) * (stacked ? 1 : series.length))) + 10;
        const top = 4, bottom = 22, right = showValues ? 56 : 12;
        const H = o.height || top + bottom + rowH * cats.length;
        const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.title || 'Balkendiagramm' }, host);
        const x = (v) => labelW + ((v - t0) / (t1 - t0 || 1)) * (W - labelW - right);
        const ax = svgEl('g', { class: 't-axis' }, svg);
        ticks.forEach((t) => {
          svgEl('line', { x1: x(t), x2: x(t), y1: top, y2: H - bottom, class: 't-gridline' }, svg);
          svgEl('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, ax).textContent = o.axisFormat ? o.axisFormat(t) : fmt.compact(t);
        });
        cats.forEach((c, ci) => {
          const y0 = top + ci * rowH + 5;
          svgEl('text', { x: labelW - 8, y: y0 + (rowH - 10) / 2 + 4, 'text-anchor': 'end' }, ax).textContent = clip(c, 32);
          let accPos = 0, accNeg = 0;
          const h = stacked ? rowH - 10 : (rowH - 10) / series.length;
          series.forEach((s, si) => {
            const v = s.values[ci];
            if (v == null) return;
            let a, b;
            if (stacked) { if (v >= 0) { a = accPos; b = accPos += v; } else { a = accNeg; b = accNeg += v; } } else { a = 0; b = v; }
            const xa = x(Math.min(a, b)), xb = x(Math.max(a, b));
            const yy = stacked ? y0 : y0 + si * h;
            // Single bars get a rounded data end; stacked segments stay square
            // with a 1px surface-coloured gap between them.
            const bw2 = Math.max(1, xb - xa), bh2 = Math.max(2, h - (stacked ? 0 : 2));
            const r = svgEl('path', {
              d: stacked ? `M${xa},${yy}h${bw2}v${bh2}h${-bw2}Z` : barPath(xa, yy, bw2, bh2, v >= 0 ? 'right' : 'left'),
              class: 't-mark t-bar',
              style: `fill:${color(si, o)}${stacked ? ';stroke:var(--talos-bg);stroke-width:1' : ''}`,
            }, svg);
            hover(r, c, ci);
            if (showValues && !stacked) svgEl('text', { x: xb + 6, y: yy + h / 2 + 4, class: 't-value-label' }, svg).textContent = f(v);
          });
        });
        svgEl('line', { x1: x(0), x2: x(0), y1: top, y2: H - bottom, class: 't-axis-zero', style: 'stroke:var(--talos-border-strong)' }, svg);
      } else {
        const left = Math.max(...ticks.map((t) => textWidth(o.axisFormat ? o.axisFormat(t) : fmt.compact(t)))) + 12;
        const slot0 = (W - left - 8) / cats.length;
        // Value labels only where they fit over their column — otherwise they
        // collide into an unreadable row; the tooltip still has the figures.
        const colValues = showValues && !stacked && Math.max(...series.flatMap((s) => s.values.filter((v) => v != null).map((v) => textWidth(f(v), 11)))) <= slot0 - 2;
        const top = colValues ? 18 : 8, right = 8;
        const maxLabel = Math.max(3, Math.floor(slot0 / 6.4));
        const bottom = 26;
        // Height follows the width: a narrow column gets a flatter chart
        // instead of a tall one with empty bands.
        const H = o.height || Math.round(Math.min(260, Math.max(170, W * 0.5)));
        const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.title || 'Säulendiagramm' }, host);
        const y = (v) => top + (1 - (v - t0) / (t1 - t0 || 1)) * (H - top - bottom);
        const ax = svgEl('g', { class: 't-axis' }, svg);
        ticks.forEach((t) => {
          svgEl('line', { x1: left, x2: W - right, y1: y(t), y2: y(t), class: 't-gridline' }, svg);
          svgEl('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end' }, ax).textContent = o.axisFormat ? o.axisFormat(t) : fmt.compact(t);
        });
        const slot = slot0;
        const groupW = Math.min(slot * 0.72, (o.barSize || 36) * (stacked ? 1 : series.length));
        const step = Math.ceil(cats.length / Math.max(1, Math.floor((W - left) / 46)));
        cats.forEach((c, ci) => {
          const cx = left + slot * ci + slot / 2;
          if (ci % step === 0) svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, ax).textContent = clip(c, maxLabel * step);
          let accPos = 0, accNeg = 0;
          const bw = stacked ? groupW : groupW / series.length;
          series.forEach((s, si) => {
            const v = s.values[ci];
            if (v == null) return;
            let a, b;
            if (stacked) { if (v >= 0) { a = accPos; b = accPos += v; } else { a = accNeg; b = accNeg += v; } } else { a = 0; b = v; }
            const ya = y(Math.max(a, b)), yb = y(Math.min(a, b));
            const xx = cx - groupW / 2 + (stacked ? 0 : si * bw);
            const bx = xx + (stacked ? 0 : 1), bwid = Math.max(2, bw - (stacked ? 0 : 2)), bh = Math.max(1, yb - ya);
            const r = svgEl('path', {
              d: stacked ? `M${bx},${ya}h${bwid}v${bh}h${-bwid}Z` : barPath(bx, ya, bwid, bh, v >= 0 ? 'top' : 'bottom'),
              class: 't-mark t-bar',
              style: `fill:${color(si, o)}${stacked ? ';stroke:var(--talos-bg);stroke-width:1' : ''}`,
            }, svg);
            hover(r, c, ci);
            if (colValues) svgEl('text', { x: xx + bw / 2, y: ya - 5, 'text-anchor': 'middle', class: 't-value-label' }, svg).textContent = f(v);
          });
        });
        svgEl('line', { x1: left, x2: W - right, y1: y(Math.max(t0, Math.min(0, t1))), y2: y(Math.max(t0, Math.min(0, t1))), style: 'stroke:var(--talos-border-strong)' }, svg);
      }

      function hover(el, cat, ci) {
        el.addEventListener('mousemove', (e) => {
          el.classList.add('t-active');
          const rect = host.getBoundingClientRect();
          ctx.tooltip(tipRows(cat, series.map((s, si) => ({ name: s.name || o.label || '', color: color(si, o), value: f(s.values[ci]) }))), e.clientX - rect.left, e.clientY - rect.top);
        });
        el.addEventListener('mouseleave', () => { el.classList.remove('t-active'); ctx.tooltip(null); });
        if (o.onClick) { el.style.cursor = 'pointer'; el.addEventListener('click', () => o.onClick(cat, ci)); }
      }
    });
  }

  // ── line / area ──
  function line(target, opts) {
    return mount(target, opts, (host, o, ctx) => {
      const cats = o.categories || [];
      const series = (o.series || []).map((s) => ({ name: s.name || '', values: (s.values || []).map((v) => (finite(v) ? v : null)) }));
      if (!cats.length || !series.length) { host.innerHTML = '<div class="t-empty">Keine Daten</div>'; return; }
      const f = valueFormat(o);
      const all = series.flatMap((s) => s.values.filter((v) => v != null));
      let lo = Math.min(...all), hi = Math.max(...all);
      if (o.zero !== false && lo > 0 && o.area) lo = 0;
      if (o.min != null) lo = o.min;
      if (o.max != null) hi = o.max;
      const ticks = niceTicks(lo, hi, 5);
      const t0 = ticks[0], t1 = ticks[ticks.length - 1];
      const W = ctx.width, H = o.height || Math.round(Math.min(260, Math.max(170, W * 0.5)));
      const left = Math.max(...ticks.map((t) => textWidth(o.axisFormat ? o.axisFormat(t) : fmt.compact(t)))) + 12;
      const top = 10, right = 12, bottom = 26;
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.title || 'Liniendiagramm' }, host);
      const x = (i) => left + (cats.length === 1 ? (W - left - right) / 2 : (i / (cats.length - 1)) * (W - left - right));
      const y = (v) => top + (1 - (v - t0) / (t1 - t0 || 1)) * (H - top - bottom);
      const ax = svgEl('g', { class: 't-axis' }, svg);
      ticks.forEach((t) => {
        svgEl('line', { x1: left, x2: W - right, y1: y(t), y2: y(t), class: 't-gridline' }, svg);
        svgEl('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end' }, ax).textContent = o.axisFormat ? o.axisFormat(t) : fmt.compact(t);
      });
      // Room per label from the longest label, so dates like "2025-01" never
      // run into each other; the last label shows only with room to spare.
      const labelW = Math.max(40, ...cats.map((c) => textWidth(clip(c, 14), 12))) + 14;
      const step = Math.ceil(cats.length / Math.max(1, Math.floor((W - left) / labelW)));
      const lastAt = cats.length - 1, showLast = lastAt % step === 0 || lastAt % step >= Math.ceil(step * 0.7);
      cats.forEach((c, i) => {
        if (i % step === 0 || (i === lastAt && showLast)) svgEl('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === lastAt ? 'end' : 'middle' }, ax).textContent = clip(c, 14);
      });
      series.forEach((s, si) => {
        const segs = [];
        let cur = [];
        s.values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
        if (cur.length) segs.push(cur);
        segs.forEach((pts) => {
          const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
          if (o.area) {
            const base = y(Math.max(t0, Math.min(0, t1)));
            svgEl('path', { d: `${d}L${pts[pts.length - 1][0]},${base}L${pts[0][0]},${base}Z`, style: `fill:${color(si, o)};opacity:${series.length > 1 ? 0.12 : 0.16}` }, svg);
          }
          svgEl('path', { d, class: 't-mark t-line', style: `fill:none;stroke:${color(si, o)};stroke-width:2;stroke-linejoin:round;stroke-linecap:round${s.dashed ? ';stroke-dasharray:5 4' : ''}` }, svg);
          if (pts.length === 1) svgEl('circle', { cx: pts[0][0], cy: pts[0][1], r: 3, style: `fill:${color(si, o)}` }, svg);
        });
      });
      // Hover: a guide line and a dot per series at the nearest category.
      const guide = svgEl('line', { y1: top, y2: H - bottom, style: 'stroke:var(--talos-border-strong);stroke-dasharray:3 3;opacity:0' }, svg);
      const dots = series.map((_, si) => svgEl('circle', { r: 4, style: `fill:var(--talos-bg);stroke:${color(si, o)};stroke-width:2;opacity:0` }, svg));
      const overlay = svgEl('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, style: 'fill:transparent' }, svg);
      overlay.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(cats.length - 1, Math.round(((px - left) / (W - left - right)) * (cats.length - 1))));
        guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.style.opacity = 1;
        series.forEach((s, si) => {
          const v = s.values[i];
          dots[si].style.opacity = v == null ? 0 : 1;
          if (v != null) { dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(v)); }
        });
        const hr = host.getBoundingClientRect();
        ctx.tooltip(tipRows(cats[i], series.map((s, si) => ({ name: s.name || o.label || '', color: color(si, o), value: f(s.values[i]) }))), e.clientX - hr.left, e.clientY - hr.top);
      });
      overlay.addEventListener('mouseleave', () => {
        guide.style.opacity = 0; dots.forEach((d) => (d.style.opacity = 0)); ctx.tooltip(null);
        host.classList.remove('t-hovering');
      });
      host.classList.remove('t-hovering');
    });
  }

  // ── donut ──
  function donut(target, opts) {
    return mount(target, Object.assign({ legend: false }, opts), (host, o, ctx) => {
      const items = (o.items || []).filter((it) => finite(it.value) && it.value > 0);
      if (!items.length) { host.innerHTML = '<div class="t-empty">Keine Daten</div>'; return; }
      const f = valueFormat(o);
      const total = items.reduce((a, it) => a + it.value, 0);
      const W = ctx.width;
      const size = Math.min(o.height || 220, W < 420 ? W : W * 0.45);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:16px 24px';
      host.appendChild(wrap);
      const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': o.title || 'Ringdiagramm' }, wrap);
      const cx = size / 2, cy = size / 2, R = size / 2 - 4, r = R * 0.62;
      let a0 = -Math.PI / 2;
      items.forEach((it, i) => {
        const a1 = a0 + (it.value / total) * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
        const full = items.length === 1;
        const d = full
          ? `M${cx - R},${cy}a${R},${R} 0 1,0 ${2 * R},0a${R},${R} 0 1,0 ${-2 * R},0M${cx - r},${cy}a${r},${r} 0 1,1 ${2 * r},0a${r},${r} 0 1,1 ${-2 * r},0`
          : `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
        const seg = svgEl('path', { d, class: 't-mark t-slice', 'fill-rule': 'evenodd', style: `fill:${color(i, o)};stroke:var(--talos-bg);stroke-width:2` }, svg);
        seg.addEventListener('mousemove', (e) => {
          seg.classList.add('t-active');
          const hr = host.getBoundingClientRect();
          ctx.tooltip(tipRows(it.label, [{ name: fmt.percent(it.value / total), color: color(i, o), value: f(it.value) }]), e.clientX - hr.left, e.clientY - hr.top);
        });
        seg.addEventListener('mouseleave', () => { seg.classList.remove('t-active'); ctx.tooltip(null); });
        a0 = a1;
      });
      svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', style: 'font-size:18px;font-weight:600;fill:var(--talos-fg)' }, svg).textContent = o.centerValue != null ? o.centerValue : f(total);
      svgEl('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', style: 'font-size:11px;fill:var(--talos-muted)' }, svg).textContent = o.centerLabel != null ? o.centerLabel : 'Gesamt';
      const legend = document.createElement('div');
      legend.style.cssText = 'display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:160px;flex:1';
      legend.innerHTML = items
        .map((it, i) => `<div style="display:flex;align-items:center;gap:8px"><i style="width:10px;height:10px;border-radius:3px;background:${color(i, o)};flex:none"></i><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.label)}</span><span class="t-muted t-num">${esc(fmt.percent(it.value / total, 0))}</span><b class="t-num" style="font-weight:600;min-width:56px;text-align:right">${esc(f(it.value))}</b></div>`)
        .join('');
      wrap.appendChild(legend);
    });
  }

  talos.chart = { bar, line, donut, niceTicks };

  // A theme token as a plain colour. The tokens are often color-mix()/oklch(),
  // which libraries that compute with colours (Mermaid, ECharts, Chart.js)
  // cannot parse; drawing one pixel and reading it back gives rgb()/rgba()
  // every library understands. Re-read after a theme switch ('talos:theme').
  const swatch = document.createElement('canvas');
  swatch.width = swatch.height = 1;
  const probe = document.createElement('span');
  /** Markdown → safe HTML for live previews and notes: headings, bold,
   *  italic, strike, inline code, code blocks, lists (incl. task lists),
   *  quotes, links, rules, simple tables. Everything is escaped first, so
   *  user text can never inject markup. */
  talos.md = function md(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(line)) {
        const body = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${talos.md(body.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
          items.push(task ? `<li class="t-task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}</li>` : `<li>${inline(item)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('\n');
  };

  /** A small trend line: talos.spark('#el', [3, 5, 4, 8], { color, area }). */
  talos.spark = function spark(target, values, opts) {
    const host = $(target);
    if (!host) return;
    const o = opts || {}, v = (values || []).filter(finite);
    host.innerHTML = '';
    if (v.length < 2) return;
    const W = 100, H = 28, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * W, H - 3 - ((x - lo) / span) * (H - 6)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const c = o.color || 'var(--talos-accent)';
    const svg = svgEl('svg', { class: 't-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, host);
    if (o.area !== false) svgEl('path', { d: `${d} L${W} ${H} L0 ${H} Z`, style: `fill:${c};opacity:.12;stroke:none` }, svg);
    svgEl('path', { d, style: `fill:none;stroke:${c};stroke-width:1.6;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round` }, svg);
    measure();
  };

  talos.color = function color(token, fallback) {
    const name = String(token || '').startsWith('--') ? token : `--talos-${token}`;
    probe.style.color = `var(${name}, ${fallback || 'currentColor'})`;
    (document.body || document.documentElement).appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const ctx = swatch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return resolved;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = resolved;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };

  // ── map (Leaflet + the configured tile server, OpenStreetMap by default) ──
  // The tile server's usage policy is built in rather than left to the model:
  // attribution always on, tiles only on demand (no prefetch, Leaflet's default
  // buffer), zoom capped by the server config, and the wheel does not zoom
  // until the map is clicked, so scrolling the chat never pulls tiles by
  // accident. Talos also prints the attribution under the frame.
  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  talos.map = function map(target, opts) {
    opts = opts || {};
    const host = $(target);
    if (!host) throw new Error('talos.map: container ' + target + ' not found');
    const cfg = ((window.TALOS_CONFIG || {}).maps) || {};
    host.classList.add('t-map');
    if (!host.style.height) host.style.height = (opts.height || 340) + 'px';
    if (!cfg.enabled || !cfg.tileUrl) { host.innerHTML = '<div class="t-empty">Karten sind in dieser Installation deaktiviert.</div>'; return null; }
    if (!window.L) throw new Error('talos.map: Leaflet failed to load');
    const L = window.L;
    const m = L.map(host, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, worldCopyJump: true, maxZoom: cfg.maxZoom || 19 });
    m.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    // Tiles from this instance's caching proxy (src/tile_proxy.py), which
    // talks to the tile server under its usage policy. keepBuffer 1: only one
    // ring of look-ahead beyond the visible area, no prefetching.
    L.tileLayer(cfg.tileUrl, { maxZoom: cfg.maxZoom || 19, attribution: cfg.attribution, keepBuffer: 1 }).addTo(m);
    m.on('click', () => m.scrollWheelZoom.enable());
    host.addEventListener('mouseleave', () => m.scrollWheelZoom.disable());

    let layer = L.layerGroup().addTo(m);
    const draw = (o) => {
      layer.clearLayers();
      const pts = [];
      (o.markers || []).forEach((mk, i) => {
        if (!finite(mk.lat) || !finite(mk.lng)) return;
        const c = mk.color || cssVar(`--talos-chart-${((mk.series != null ? mk.series : 0) % 8) + 1}`, '#2a78d6');
        const marker = L.circleMarker([mk.lat, mk.lng], {
          radius: mk.radius || 7, color: cssVar('--talos-bg', '#fff'), weight: 2, fillColor: c, fillOpacity: 0.95,
        }).addTo(layer);
        if (mk.label) marker.bindTooltip(esc(mk.label), { direction: 'top', offset: [0, -6] });
        if (mk.popup) marker.bindPopup(mk.popup);
        if (o.onClick) marker.on('click', () => o.onClick(mk, i));
        pts.push([mk.lat, mk.lng]);
      });
      (o.lines || []).forEach((ln, i) => {
        const p = (ln.points || []).filter((q) => finite(q[0]) && finite(q[1]));
        if (p.length < 2) return;
        L.polyline(p, { color: ln.color || cssVar(`--talos-chart-${(i % 8) + 1}`, '#2a78d6'), weight: ln.weight || 3, opacity: 0.9, dashArray: ln.dashed ? '6 6' : null }).addTo(layer);
        pts.push(...p);
      });
      if (o.center && finite(o.center[0])) m.setView(o.center, o.zoom || 12);
      else if (pts.length > 1) m.fitBounds(pts, { padding: [28, 28], maxZoom: o.zoom || 15 });
      else if (pts.length === 1) m.setView(pts[0], o.zoom || 13);
      else m.setView([51.1657, 10.4515], 5);
      measure();
    };
    let current = opts;
    draw(current);
    return {
      map: m,
      L,
      update(next) { current = Object.assign({}, current, next); draw(current); },
    };
  };
})();
