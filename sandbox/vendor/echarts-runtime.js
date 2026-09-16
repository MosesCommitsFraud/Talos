/* Full ECharts options, with the same offline card lifecycle as Talos builders. */

/* Option strings resolved at draw time, so one option works in light and dark:
   "@ink2", "@grid", "@s1", "@brand-blue" … read the page's CSS variables
   (--td-* first, then the plain name) for the current theme, and formatter
   strings using "@eur", "@eurCompact", "@num", "@numCompact" or "@pct" become
   locale-aware functions — optionally inside a template such as "{b}: @eurCompact"
   ({a} series, {b} name, {d} share of a pie in %). */
const TALOS_FORMATS = /@(eurCompact|eur|numCompact|num|pct)\b/g;

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

function talosResolve(node, token, locale, key) {
  if (typeof node === 'string') {
    if ((key === 'formatter' || key === 'valueFormatter') && node.search(TALOS_FORMATS) >= 0) {
      TALOS_FORMATS.lastIndex = 0;
      return talosFormatter(node, locale);
    }
    const m = /^@([a-z][a-z0-9-]*)$/i.exec(node);
    return m ? (token(m[1]) || node) : node;
  }
  if (Array.isArray(node)) return node.map((x) => talosResolve(x, token, locale));
  if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = talosResolve(v, token, locale, k);
    return out;
  }
  return node;
}

window.TalosECharts = {
  mountAll(entries, options = {}) {
    const hosts = {};
    for (const entry of entries) {
      const el = document.getElementById(entry.id);
      if (!el) continue;
      let chart, cleanup, resize, observer, disposed = false;
      const media = window.matchMedia('(prefers-color-scheme: dark)');
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
          el.setAttribute('role', 'img');
          el.setAttribute('aria-label', entry.title);
          const css = getComputedStyle(document.documentElement);
          const token = name => css.getPropertyValue(`--td-${name}`).trim() || css.getPropertyValue(`--${name}`).trim();
          const locale = options.locale || 'de-DE';
          const mode = document.documentElement.dataset.theme;
          const dark = mode === 'dark' || (mode !== 'light' && media.matches);
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
              pie: {label, itemStyle: itemBorder, labelLine: {lineStyle: {color: token('base')}}},
              treemap: {itemStyle: itemBorder}, sunburst: {itemStyle: itemBorder},
              visualMap: {textStyle: {color: token('ink2')}},
            });
          }
          chart = echarts.init(el, theme, {locale: options.locale?.startsWith('de') ? 'DE' : 'EN',
              width: el.clientWidth || 640, height: entry.height || el.clientHeight || 340});
          const spec = entry.spec;
          if (spec.setup) cleanup = spec.setup(chart, echarts, spec.data);
          chart.setOption({animation: false, aria: {enabled: true},
            color: Array.from({length: 8}, (_, i) => token(`s${i + 1}`)),
            backgroundColor: 'transparent', textStyle: {color: token('ink'), fontFamily: font},
            ...talosResolve(spec.option, token, locale)});
          if (previous) {
            const state = {};
            if (previous.dataZoom) state.dataZoom = previous.dataZoom.map(z => ({start: z.start, end: z.end}));
            if (previous.legend) state.legend = previous.legend.map(l => ({selected: l.selected}));
            chart.setOption(state);
          }
        } catch (error) { fail(error); }
      };
      draw();
      // Canvas text is measured once; redraw when an embedded brand font arrives.
      if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(draw);
      resize =new ResizeObserver(() => {
        if (chart && !chart.isDisposed()) chart.resize({width: el.clientWidth || 640, height: entry.height || el.clientHeight || 340});
      });
      resize.observe(el);
      observer = new MutationObserver(draw);
      observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
      media.addEventListener('change', draw);
      hosts[entry.id] = {
        usesGL: entry.spec.extensions?.includes('echarts-gl') || false,
        get chart() { return chart; },
        dispose() {
          disposed = true;
          resize.disconnect(); observer.disconnect(); media.removeEventListener('change', draw);
          if (typeof cleanup === 'function') cleanup();
          if (chart) chart.dispose();
        }
      };
    }
    return hosts;
  }
};
