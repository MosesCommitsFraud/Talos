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

  // Keep range inputs' filled track in step with their value.
  // The fill ends under the knob's centre: the knob travels a track that is
  // one knob (1rem) shorter than the input, so the offset runs from +0.5rem
  // at the start to -0.5rem at the end (t3code's settings slider).
  function fillRange(input) {
    const min = +input.min || 0, max = input.max === '' ? 100 : +input.max, v = +input.value;
    const ratio = max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    input.style.setProperty('--t-fill', `${ratio * 100}%`);
    input.style.setProperty('--t-fill-offset', `${0.5 - ratio}rem`);
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

  talos.kit = {
    fillRange,
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
            const r = svgEl('rect', { x: xa, y: yy, width: Math.max(1, xb - xa), height: Math.max(2, h - (stacked ? 0 : 2)), rx: 3, class: 't-mark', style: `fill:${color(si, o)}` }, svg);
            hover(r, c, ci);
            if (showValues && !stacked) svgEl('text', { x: xb + 6, y: yy + h / 2 + 4, class: 't-value-label' }, svg).textContent = f(v);
          });
        });
        svgEl('line', { x1: x(0), x2: x(0), y1: top, y2: H - bottom, class: 't-axis-zero', style: 'stroke:var(--talos-border-strong)' }, svg);
      } else {
        const left = Math.max(...ticks.map((t) => textWidth(o.axisFormat ? o.axisFormat(t) : fmt.compact(t)))) + 12;
        const top = showValues ? 18 : 8, right = 8;
        const slot0 = (W - left - right) / cats.length;
        const maxLabel = Math.max(3, Math.floor(slot0 / 6.4));
        const bottom = 26;
        const H = o.height || 260;
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
            const r = svgEl('rect', { x: xx + (stacked ? 0 : 1), y: ya, width: Math.max(2, bw - (stacked ? 0 : 2)), height: Math.max(1, yb - ya), rx: 3, class: 't-mark', style: `fill:${color(si, o)}` }, svg);
            hover(r, c, ci);
            if (showValues && !stacked) svgEl('text', { x: xx + bw / 2, y: ya - 5, 'text-anchor': 'middle', class: 't-value-label' }, svg).textContent = f(v);
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
      const W = ctx.width, H = o.height || 260;
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
      const step = Math.ceil(cats.length / Math.max(1, Math.floor((W - left) / 64)));
      cats.forEach((c, i) => {
        if (i % step === 0 || i === cats.length - 1) svgEl('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === cats.length - 1 ? 'end' : 'middle' }, ax).textContent = clip(c, 14);
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
          svgEl('path', { d, class: 't-mark', style: `fill:none;stroke:${color(si, o)};stroke-width:2;stroke-linejoin:round;stroke-linecap:round${s.dashed ? ';stroke-dasharray:5 4' : ''}` }, svg);
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
        const seg = svgEl('path', { d, class: 't-mark', 'fill-rule': 'evenodd', style: `fill:${color(i, o)};stroke:var(--talos-bg);stroke-width:2` }, svg);
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
