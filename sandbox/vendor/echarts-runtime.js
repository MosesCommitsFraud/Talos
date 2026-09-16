/* Full ECharts options, with the same offline card lifecycle as Talos builders. */
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
          const token = name => css.getPropertyValue(`--td-${name}`).trim();
          const mode = document.documentElement.dataset.theme;
          const dark = mode === 'dark' || (mode !== 'light' && media.matches);
          // A branded page carries its own axis, legend and tooltip colours and
          // typeface. The stock ECharts greys are what make a chart look generic.
          const font = token('font') || undefined;
          let theme = dark ? 'dark' : null;
          if (token('brand')) {
            const axis = {axisLine: {lineStyle: {color: token('base')}}, axisTick: {lineStyle: {color: token('base')}},
              axisLabel: {color: token('ink2')}, nameTextStyle: {color: token('ink2')},
              splitLine: {lineStyle: {color: token('grid')}}};
            theme = `talos-brand-${dark ? 'dark' : 'light'}`;
            echarts.registerTheme(theme, {
              textStyle: {fontFamily: font}, title: {textStyle: {color: token('ink')}, subtextStyle: {color: token('ink2')}},
              legend: {textStyle: {color: token('ink2')}},
              tooltip: {backgroundColor: token('surface'), borderColor: token('grid'), textStyle: {color: token('ink')}},
              categoryAxis: axis, valueAxis: axis, logAxis: axis, timeAxis: axis,
            });
          }
          chart = echarts.init(el, theme, {locale: options.locale?.startsWith('de') ? 'DE' : 'EN',
              width: el.clientWidth || 640, height: entry.height || el.clientHeight || 340});
          const spec = entry.spec;
          if (spec.setup) cleanup = spec.setup(chart, echarts, spec.data);
          chart.setOption({animation: false, aria: {enabled: true},
            color: Array.from({length: 8}, (_, i) => token(`s${i + 1}`)),
            backgroundColor: 'transparent', textStyle: {color: token('ink'), fontFamily: font},
            ...spec.option});
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
