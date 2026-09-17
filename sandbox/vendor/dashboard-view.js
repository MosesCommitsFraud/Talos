/* Offline presentation sizing and PNG rendering; download controls live in Talos. */

/* Page-wide filters for cross-filtering and drill-down, declared in markup:
     data-filter-set="gruppe" data-value="Mints"   click toggles gruppe=Mints (again: clears)
     data-filter="gruppe" data-value="Mints"       shown when no filter or gruppe=Mints
       + data-collapsed                            shown only when gruppe=Mints (drill-down rows)
     data-filter="gruppe" data-value=""            shown only while no gruppe filter (totals)
     data-filter-status="gruppe"                   shows the active value, hidden otherwise
     data-filter-reset="gruppe"                    clears the filter, hidden otherwise
   Charts join through their option: talos: {emit: "gruppe"} / {filter: "gruppe", views: {…}}. */
window.TalosFilter = (() => {
  const state = {};
  const listeners = new Set();
  const apply = () => {
    document.querySelectorAll('[data-filter]').forEach((el) => {
      const active = state[el.dataset.filter];
      const value = el.dataset.value ?? '';
      el.hidden = value === ''
        ? active != null
        : (active == null ? el.hasAttribute('data-collapsed') : active !== value);
    });
    document.querySelectorAll('[data-filter-set]').forEach((el) => {
      el.setAttribute('aria-pressed', String(state[el.dataset.filterSet] === (el.dataset.value ?? '')));
    });
    document.querySelectorAll('[data-filter-status]').forEach((el) => {
      const active = state[el.dataset.filterStatus];
      el.textContent = active ?? '';
      el.hidden = active == null;
    });
    document.querySelectorAll('[data-filter-reset]').forEach((el) => {
      el.hidden = state[el.dataset.filterReset] == null;
    });
  };
  const api = {
    get: (field) => state[field],
    set(field, value) {
      if (value == null || value === '') delete state[field]; else state[field] = String(value);
      apply();
      listeners.forEach((fn) => { try { fn(field); } catch (e) { console.error(e); } });
    },
    toggle(field, value) { api.set(field, state[field] === String(value) ? null : value); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    apply,
  };
  document.addEventListener('click', (event) => {
    const setter = event.target.closest && event.target.closest('[data-filter-set]');
    if (setter) { api.toggle(setter.dataset.filterSet, setter.dataset.value ?? ''); return; }
    const reset = event.target.closest && event.target.closest('[data-filter-reset]');
    if (reset) api.set(reset.dataset.filterReset, null);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const setter = event.target.closest && event.target.closest('[data-filter-set]');
    if (setter) { event.preventDefault(); api.toggle(setter.dataset.filterSet, setter.dataset.value ?? ''); }
  });
  return api;
})();

window.TalosDashboard = {
  init(config) {
    const art = document.getElementById('td-artboard');
    const stage = document.getElementById('td-stage');
    const size = config.size;
    document.body.dataset.pageFormat = config.format;
    document.querySelectorAll('[data-filter-set]').forEach((el) => {
      if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    });
    window.TalosFilter.apply();
    if (size) {
      art.style.width = `${size[0]}px`;
      art.style.height = `${size[1]}px`;
      const printStyle = document.createElement('style');
      printStyle.textContent = `@page{size:${config.format === 'a4' ? 'A4 portrait' : config.format === 'a4-landscape' ? 'A4 landscape' : '338.667mm 190.5mm'};margin:0}`;
      document.head.appendChild(printStyle);
    }
    const fit = () => {
      if (!size) return;
      const bodyStyle = getComputedStyle(document.body);
      const available = document.body.clientWidth - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight);
      const scale = Math.min(1, available / size[0]);
      art.style.transform = `scale(${scale})`;
      stage.style.width = `${size[0] * scale}px`;
      stage.style.height = `${size[1] * scale}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    new ResizeObserver(fit).observe(document.body);

    async function png() {
      if (typeof htmlToImage !== 'object') throw new Error('PNG-Laufzeit fehlt. Sandbox-Image aktualisieren.');
      await document.fonts.ready;
      await Promise.all([...art.querySelectorAll('img')].map(img => img.decode()));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (art.querySelector('.chart-error')) throw new Error('Bitte zuerst die Diagrammfehler beheben.');
      if (size && (art.scrollWidth > size[0] + 1 || art.scrollHeight > size[1] + 1)) {
        throw new Error('Der Inhalt passt nicht auf die Zeichenfläche. Layout kürzen oder ein größeres Format wählen.');
      }
      const width = size ? size[0] : art.offsetWidth;
      const height = size ? size[1] : art.scrollHeight;
      const outWidth = size ? size[2] : width * 2;
      const outHeight = size ? size[3] : height * 2;
      if (outWidth * outHeight > 32000000 || outWidth > 16000 || outHeight > 16000) {
        throw new Error('Diese Seite ist für einen PNG-Export zu groß. Bitte in mehrere Dashboards aufteilen.');
      }
      const scale = outWidth / width;
      // Capture ECharts directly, including WebGL, before cloning the DOM.
      const snapshots = {};
      for (const el of art.querySelectorAll('.chart')) {
        const host = window.TALOS_CHARTS?.[el.id];
        const chart = host?.chart;
        if (chart && !chart.isDisposed()) {
          // zrender's high-DPI repaint path omits external WebGL layers. Capture
          // those at native DPR and let the final composition scale the bitmap.
          const ratio = host.usesGL ? Math.min(scale, chart.getDevicePixelRatio()) : scale;
          snapshots[el.id] = chart.getDataURL({type: 'png', pixelRatio: ratio,
            backgroundColor: 'transparent', excludeComponents: ['toolbox']});
        }
      }
      const overlays = [], excluded = new Set();
      try {
        for (const [id, src] of Object.entries(snapshots)) {
          const host = document.getElementById(id);
          for (const child of host.children) excluded.add(child);
          const img = document.createElement('img');
          img.src = src;
          img.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none';
          host.appendChild(img);
          overlays.push(img);
          await img.decode();
        }
        // SVG foreignObject rendering avoids a nested iframe: those have a
        // different opaque origin in the Talos sandbox and cannot be accessed.
        const blob = await htmlToImage.toBlob(art, {
          width, height, canvasWidth: outWidth, canvasHeight: outHeight, pixelRatio: 1,
          backgroundColor: getComputedStyle(art).backgroundColor,
          style: {transform: 'none', margin: '0'},
          filter: node => !excluded.has(node),
        });
        if (!blob) throw new Error('PNG konnte nicht erstellt werden.');
        return blob;
      } finally { for (const img of overlays) img.remove(); }
    }
    window.TALOS_EXPORT = {png};
  }
};
