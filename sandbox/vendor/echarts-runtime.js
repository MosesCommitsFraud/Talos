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
          chart = echarts.init(el, dark ? 'dark' : null, {locale: options.locale?.startsWith('de') ? 'DE' : 'EN',
              width: el.clientWidth || 640, height: entry.height || el.clientHeight || 340});
          const spec = entry.spec;
          if (spec.setup) cleanup = spec.setup(chart, echarts, spec.data);
          chart.setOption({animation: false, aria: {enabled: true},
            color: Array.from({length: 8}, (_, i) => token(`s${i + 1}`)),
            backgroundColor: 'transparent', textStyle: {color: token('ink')},
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
      resize = new ResizeObserver(() => {
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
