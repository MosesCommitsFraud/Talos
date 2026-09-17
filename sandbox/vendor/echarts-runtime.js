/* Full ECharts options, with the same offline card lifecycle as Talos builders. */

/* Option strings resolved at draw time, so one option works in light and dark:
   "@ink2", "@grid", "@s1", "@brand-blue" … read the page's CSS variables
   (--td-* first, then the plain name) for the current theme, and formatter
   strings using "@eur", "@eurCompact", "@num", "@numCompact" or "@pct" become
   locale-aware functions — optionally inside a template such as "{b}: @eurCompact"
   ({a} series, {b} name, {d} share of a pie in %). */
const TALOS_FORMATS = /@(eurCompact|eur|numCompact|num|pct)\b/g;
// Below this chart width, outside pie labels no longer fit beside the ring.
const TALOS_NARROW = 480;

function talosNumber(kind, value, locale) {
  const v = Number(value);
  if (!Number.isFinite(v)) return value == null ? '' : String(value);
  const compact = kind.endsWith('Compact');
  const base = compact ? {notation: 'compact', maximumFractionDigits: 1} : {maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2};
  if (kind.startsWith('eur')) return new Intl.NumberFormat(locale, {...base, style: 'currency', currency: 'EUR'}).format(v);
  if (kind === 'pct') return new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(v) + ' %';
  return new Intl.NumberFormat(locale, base).format(v);
}

function talosValue(p) {
  if (p == null || typeof p !== 'object') return p;
  const v = p.value;
  if (Array.isArray(v)) {
    const dim = p.encode && (p.encode.x || p.encode.y || p.encode.value);
    const nums = v.filter((x) => typeof x === 'number');
    return typeof v[1] === 'number' && !dim ? v[1] : nums[nums.length - 1];
  }
  return v;
}

function talosFormatter(template, locale) {
  return (params) => {
    const one = (p) => template
      .replace(/\{a\}/g, p && p.seriesName != null ? p.seriesName : '')
      .replace(/\{b\}/g, p && p.name != null ? p.name : '')
      .replace(/\{d\}/g, p && p.percent != null ? talosNumber('pct', p.percent, locale) : '')
      .replace(TALOS_FORMATS, (_m, kind) => talosNumber(kind, talosValue(p), locale));
    if (Array.isArray(params)) {
      const head = params[0] && params[0].axisValueLabel ? `${params[0].axisValueLabel}<br/>` : '';
      return head + params.map((p) => `${p.marker || ''}${one(p)}`).join('<br/>');
    }
    return one(params);
  };
}

/* "@s1", "@s1/30" (30 % opacity) or "var(--line)" → a colour canvas can paint.
   Canvas does not understand CSS variables; an unresolved one paints black and
   turns transparent on hover. */
function talosColor(value, token) {
  if (typeof value !== 'string') return value;
  const v = /^var\(--(?:td-)?([a-z0-9-]+)(?:\s*,[^)]*)?\)$/i.exec(value.trim());
  if (v) return token(v[1]) || value;
  const m = /^@([a-z][a-z0-9-]*)(?:\/(\d{1,3}))?$/i.exec(value);
  if (!m) return value;
  const resolved = token(m[1]);
  if (!resolved) return value;
  return m[2] ? talosAlpha(resolved, Math.min(100, Number(m[2])) / 100) : resolved;
}

function talosResolve(node, token, locale, key) {
  if (typeof node === 'string') {
    if ((key === 'formatter' || key === 'valueFormatter') && node.search(TALOS_FORMATS) >= 0) {
      TALOS_FORMATS.lastIndex = 0;
      return talosFormatter(node, locale);
    }
    return talosColor(node, token);
  }
  // A colour callback may return a token too ({color: function (p) {return '@s2'}}).
  if (typeof node === 'function' && key && /color$/i.test(key)) {
    return function (...args) { return talosColor(node.apply(this, args), token); };
  }
  // Readability floor and ceiling: nothing a reader must decode below 12px,
  // no hairline or black weights.
  if (key === 'fontSize' && typeof node === 'number') return Math.max(12, node);
  if (key === 'fontWeight') {
    const w = typeof node === 'number' ? node : ({bold: 700, bolder: 800, lighter: 300}[node] ?? 400);
    return Math.min(600, Math.max(400, w));
  }
  if (Array.isArray(node)) return node.map((x) => talosResolve(x, token, locale));
  if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = talosResolve(v, token, locale, k);
    return out;
  }
  return node;
}

/* Legend text for a pie whose labels were moved out of a narrow tile: the same
   content the label formatter would have shown, on one line. */
function talosPieLegend(series) {
  const items = (series.data || []).map((d) => (d && typeof d === 'object' ? d : {value: d}));
  const total = items.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
  const labelFormatter = series.label && series.label.formatter;
  return (name) => {
    const d = items.find((x) => String(x.name) === String(name)) || {name, value: 0};
    const percent = total ? Math.round((Number(d.value) || 0) / total * 1000) / 10 : 0;
    const params = {name: d.name, value: d.value, percent, data: d, seriesName: series.name};
    const text = typeof labelFormatter === 'function' ? labelFormatter(params) : `${name}  ${percent} %`;
    return String(text).replace(/\n+/g, '  ');
  };
}

/* Layout guards applied after resolution. Series labels are not part of the
   grid's outer bounds, so a "97,7 Mio." label at the end of the longest bar was
   cut off; widening the value axis a little keeps it inside the chart. */
function talosFit(option, width = 640) {
  const narrow = width < TALOS_NARROW;
  talosHorizontalBars(option, width);
  const series = [].concat(option.series || []);
  const axes = (name) => [].concat(option[name] || []);
  const hasPie = series.some((s) => s && s.type === 'pie');
  if (hasPie && option.legend) talosPieLegendLayout(option, series);
  for (const s of series) {
    if (!s || typeof s !== 'object') continue;
    // Value labels on dense charts ("215,4 Mio. €" over six narrow bars) run
    // into each other; hide the ones that would overlap instead.
    if (s.type !== 'pie' && s.label && s.label.show && s.labelLayout == null) s.labelLayout = {hideOverlap: true};
    if (s.type === 'bar' && s.label && s.label.show) {
      const horizontal = axes('yAxis').some((a) => a && a.type === 'category');
      const pos = s.label.position || (horizontal ? 'right' : 'top');
      const outside = horizontal ? pos === 'right' : pos === 'top';
      if (outside) {
        for (const a of axes(horizontal ? 'xAxis' : 'yAxis')) {
          if (a && (a.type === 'value' || a.type == null) && a.boundaryGap == null && a.max == null) {
            a.boundaryGap = [0, horizontal ? '18%' : '10%'];
          }
        }
      }
    }
    if (s.type === 'pie') {
      s.itemStyle = {...(s.itemStyle || {})};
      if (s.itemStyle.borderWidth == null || s.itemStyle.borderWidth > 1.5) s.itemStyle.borderWidth = 1;
      // Outside labels need room beside the ring; a narrow tile gets a smaller
      // ring and labels as legend-style lines under it instead of "11…".
      if (narrow && (!s.label || s.label.position == null || s.label.position === 'outside')) {
        s.label = {...(s.label || {}), show: false};
        s.labelLine = {...(s.labelLine || {}), show: false};
        s.center = ['50%', '42%'];
        s.radius = ['38%', '62%'];
        if (option.legend) {
          // The page's own legend now carries what the hidden labels showed.
          option.legend = [].concat(option.legend).map((l) => (l && typeof l === 'object' && l.formatter == null
            ? {...l, formatter: talosPieLegend(s)} : l));
        } else {
          option.legend = {type: 'scroll', bottom: 6, left: 'center', orient: 'horizontal', itemWidth: 10, itemHeight: 10,
            formatter: talosPieLegend(s)};
        }
      }
    }
  }
  return option;
}

/* Long category names under vertical bars end up rotated and overlapping.
   A plain single-grid bar chart with such names is turned into horizontal bars,
   which is what a reader needs for a ranking anyway. */
function talosHorizontalBars(option, width) {
  const x = option.xAxis, y = option.yAxis;
  if (!x || !y || Array.isArray(x) || Array.isArray(y) || x.type !== 'category' || !Array.isArray(x.data)) return;
  if (y.type && y.type !== 'value') return;
  const series = [].concat(option.series || []);
  if (!series.length || series.some((s) => !s || s.type !== 'bar')) return;
  const names = x.data.map((d) => String(d && typeof d === 'object' ? d.value : d));
  const longest = Math.max(...names.map((n) => n.length));
  const perBar = width / Math.max(1, names.length);
  if (names.length < 4 || longest * 7 < perBar) return;
  const {rotate, interval, ...xLabel} = x.axisLabel || {};
  option.yAxis = {...x, inverse: true, axisLabel: {...xLabel, width: Math.min(160, Math.round(width * 0.35)), overflow: 'truncate'}};
  option.xAxis = {...y};
  for (const s of series) {
    if (s.label && (s.label.position == null || s.label.position === 'top')) s.label = {...s.label, position: 'right'};
    const radius = s.itemStyle && s.itemStyle.borderRadius;
    if (Array.isArray(radius) && radius.length === 4) s.itemStyle = {...s.itemStyle, borderRadius: [0, radius[0], radius[1], 0]};
  }
}

/* A pie with its own legend: the legend goes into a scrolling strip under the
   ring (or beside it when vertical) so the two never overlap. */
function talosPieLegendLayout(option, series) {
  const legends = [].concat(option.legend);
  const vertical = legends.some((l) => l && l.orient === 'vertical');
  option.legend = legends.map((l) => {
    if (!l || typeof l !== 'object') return l;
    const {top, bottom, left, right, ...rest} = l;
    return vertical
      ? {...rest, type: 'scroll', orient: 'vertical', right: 0, top: 'middle'}
      : {...rest, type: 'scroll', orient: 'horizontal', left: 'center', bottom: 4};
  });
  for (const s of series) {
    if (!s || s.type !== 'pie') continue;
    s.center = vertical ? ['36%', '50%'] : ['50%', '44%'];
    const outer = Array.isArray(s.radius) ? s.radius[1] : s.radius;
    if (outer == null || parseFloat(outer) > 62) s.radius = Array.isArray(s.radius) ? [s.radius[0], '62%'] : ['0%', '62%'];
  }
}

/* A chart host inside a container that has its own height must fill that
   container. A fixed td.chart height (default 340px) in a CSS-sized slot
   overflowed it by the difference and drew over the headings below, but only
   where the slot was smaller, e.g. in the narrower Talos preview. A host with
   no height at all gets a readable default instead of collapsing. */
function talosFitHost(el, entry) {
  const parent = el.parentElement;
  const alone = parent && [...parent.children].every((c) => c === el);
  if (alone) {
    el.style.height = '0px';
    const slot = parent.clientHeight;
    if (slot >= 120) { el.style.height = '100%'; return; }
  }
  el.style.height = entry.height != null ? `${entry.height}px` : '320px';
}

/* Deep merge for filter views: objects merge, arrays of objects (series) merge
   by index, everything else is replaced. */
function talosMerge(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) {
    return patch.map((p, i) => (p && typeof p === 'object' && !Array.isArray(p) && base[i] && typeof base[i] === 'object'
      ? talosMerge(base[i], p) : p));
  }
  if (base && patch && typeof base === 'object' && typeof patch === 'object' && !Array.isArray(base) && !Array.isArray(patch)) {
    const out = {...base};
    for (const [k, v] of Object.entries(patch)) out[k] = k in base ? talosMerge(base[k], v) : v;
    return out;
  }
  return patch;
}

/* The emitting chart shows the active selection: other items fade. */
function talosMarkSelection(option, value) {
  const categories = [].concat(option.xAxis || [], option.yAxis || [])
    .find((a) => a && a.type === 'category' && Array.isArray(a.data));
  for (const s of [].concat(option.series || [])) {
    if (!s || !Array.isArray(s.data)) continue;
    s.data = s.data.map((d, i) => {
      const name = d && typeof d === 'object' && !Array.isArray(d) ? d.name : categories?.data?.[i];
      if (value == null || name == null) return d;
      const item = d && typeof d === 'object' && !Array.isArray(d) ? {...d} : {value: d};
      item.itemStyle = {...(item.itemStyle || {}), opacity: String(name) === String(value) ? 1 : 0.3};
      return item;
    });
  }
  return option;
}

function talosAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

window.TalosECharts = {
  mountAll(entries, options = {}) {
    const hosts = {};
    for (const entry of entries) {
      const el = document.getElementById(entry.id);
      if (!el) continue;
      let chart, cleanup, resize, observer, disposed = false, narrowDrawn = false;
      const fail = error => {
        console.error(entry.id, error);
        try { if (typeof cleanup === 'function') cleanup(); }
        catch (cleanupError) { console.error(entry.id, cleanupError); }
        cleanup = null;
        if (chart) chart.dispose();
        el.replaceChildren();
        const p = document.createElement('p');
        p.className = 'chart-error';
        p.textContent = `Chart ${entry.id} failed: ${error.message || error}`;
        el.appendChild(p);
      };
      const draw = () => {
        if (disposed) return;
        try {
          const previous = chart && !chart.isDisposed() ? chart.getOption() : null;
          if (typeof cleanup === 'function') cleanup();
          cleanup = null;
          if (chart) chart.dispose();
          el.replaceChildren();
          if (entry.height != null) el.style.height = `${entry.height}px`;
          talosFitHost(el, entry);
          el.setAttribute('role', 'img');
          el.setAttribute('aria-label', entry.title);
          const css = getComputedStyle(document.documentElement);
          const token = name => css.getPropertyValue(`--td-${name}`).trim() || css.getPropertyValue(`--${name}`).trim();
          const locale = options.locale || 'de-DE';
          const mode = document.documentElement.dataset.theme;
          const dark = mode === 'dark';
          // A branded page carries its own axis, legend and tooltip colours and
          // typeface. The stock ECharts greys are what make a chart look generic.
          const font = token('font') || undefined;
          let theme = dark ? 'dark' : null;
          if (token('brand')) {
            // 12px is the floor for anything a reader has to decode on a chart.
            const axis = {axisLine: {lineStyle: {color: token('base')}}, axisTick: {lineStyle: {color: token('base')}},
              axisLabel: {color: token('ink2'), fontSize: 12, hideOverlap: true}, nameTextStyle: {color: token('ink2'), fontSize: 12},
              splitLine: {lineStyle: {color: token('grid')}}};
            const label = {color: token('ink2'), fontSize: 12, textBorderWidth: 0};
            const itemBorder = {borderColor: token('surface')};
            theme = `talos-brand-${dark ? 'dark' : 'light'}`;
            echarts.registerTheme(theme, {
              textStyle: {fontFamily: font, fontSize: 12}, title: {textStyle: {color: token('ink')}, subtextStyle: {color: token('ink2')}},
              legend: {textStyle: {color: token('ink2'), fontSize: 12}, pageTextStyle: {color: token('ink2')}},
              tooltip: {backgroundColor: token('surface'), borderColor: token('grid'), textStyle: {color: token('ink'), fontSize: 13}},
              categoryAxis: axis, valueAxis: axis, logAxis: axis, timeAxis: axis,
              bar: {label}, line: {label}, scatter: {label},
              pie: {label: {...label, lineHeight: 16}, itemStyle: {...itemBorder, borderWidth: 1},
                labelLine: {lineStyle: {color: token('base')}}},
              treemap: {itemStyle: itemBorder}, sunburst: {itemStyle: itemBorder},
              visualMap: {textStyle: {color: token('ink2')}},
            });
          }
          chart = echarts.init(el, theme, {locale: options.locale?.startsWith('de') ? 'DE' : 'EN',
              width: el.clientWidth || 640, height: el.clientHeight || entry.height || 340});
          const spec = entry.spec;
          if (spec.setup) cleanup = spec.setup(chart, echarts, spec.data);
          // `talos` is ours, not ECharts': {emit: field} makes a click set a
          // page filter, {filter: field, views: {value: optionPatch}} swaps in
          // the view for the active value (see TalosFilter in dashboard-view.js).
          let option = spec.option && typeof spec.option === 'object' ? {...spec.option} : spec.option;
          const link = (option && option.talos) || {};
          if (option && option.talos) delete option.talos;
          const bus = window.TalosFilter;
          if (bus && link.filter && link.views) {
            const view = link.views[bus.get(link.filter)];
            if (view) option = talosMerge(option, view);
          }
          narrowDrawn = (el.clientWidth || 640) < TALOS_NARROW;
          option = talosFit(talosResolve(option, token, locale), el.clientWidth || 640);
          if (bus && link.emit) option = talosMarkSelection(option, bus.get(link.emit));
          chart.setOption({animation: false, aria: {enabled: true},
            color: Array.from({length: 8}, (_, i) => token(`s${i + 1}`)),
            backgroundColor: 'transparent', textStyle: {color: token('ink'), fontFamily: font},
            ...option});
          if (bus && link.emit) {
            chart.on('click', (p) => { if (p && p.name != null) bus.toggle(link.emit, String(p.name)); });
          }
          if (previous) {
            const state = {};
            if (previous.dataZoom) state.dataZoom = previous.dataZoom.map(z => ({start: z.start, end: z.end}));
            if (previous.legend && option && option.legend) state.legend = previous.legend.map(l => ({selected: l.selected}));
            chart.setOption(state);
          }
        } catch (error) { fail(error); }
      };
      draw();
      // Canvas text is measured once; redraw when an embedded brand font arrives.
      if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(draw);
      resize = new ResizeObserver(() => {
        // Crossing the narrow threshold changes the layout (pie labels ↔ legend), not just the size.
        if (((el.clientWidth || 640) < TALOS_NARROW) !== narrowDrawn) { draw(); return; }
        if (chart && !chart.isDisposed()) chart.resize({width: el.clientWidth || 640, height: el.clientHeight || entry.height || 340});
      });
      resize.observe(el);
      observer = new MutationObserver(draw);
      observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
      const linked = entry.spec.option && entry.spec.option.talos;
      const unsubscribe = linked && window.TalosFilter ? window.TalosFilter.on(draw) : null;

      hosts[entry.id] = {
        usesGL: entry.spec.extensions?.includes('echarts-gl') || false,
        get chart() { return chart; },
        dispose() {
          disposed = true;
          resize.disconnect(); observer.disconnect(); if (unsubscribe) unsubscribe();
          if (typeof cleanup === 'function') cleanup();
          if (chart) chart.dispose();
        }
      };
    }
    return hosts;
  }
};
