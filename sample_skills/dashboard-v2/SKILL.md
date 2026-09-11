---
name: dashboard-v2
description: "Create interactive HTML dashboards, KPI overviews and reports with Apache ECharts, including follow-ups that add or change charts. Use when producing an HTML page with interactive charts. Not for a single static chart image, an Excel deliverable, or a report without charts."
license: MIT
---

# Dashboard v2 in Talos — Apache ECharts

Produce one self-contained HTML file using `/opt/talos/vendor/talos_dash.py`.
The scaffold supplies layout, KPI tiles, inline runtimes, theme and resize
handling, and per-card error isolation. Focus on chart selection and data.

**Use `td.echarts(option)` for new charts. The full ECharts option API is
available, including custom series, callbacks, coordinate systems and events.
The old Python builders are conveniences, not the available-chart boundary.**

## Choose from the whole gallery

Before building a new dashboard or adding a materially different chart:

1. Identify what each view should reveal: comparison, temporal change,
   distribution, hierarchy, relationships, flow, geography or uncertainty.
2. Read [chart-selection.md](references/chart-selection.md) to consider the
   families beyond bars, lines and donuts. Choose by the analytical question;
   diversity should reveal something, not decorate the page.
3. Search the **complete offline official-example index**, then read the
   source of relevant candidates before adapting them. Do not stop at the
   first familiar example or limit selection to this skill's snippets.
4. Inspect dependencies and `since`. Adapt the example's data and interaction
   to the question and the offline constraints below. Explain the useful
   insight in the card title/note, rather than the technical chart name.

```bash
cat /opt/talos/vendor/echarts.version
cat /opt/talos/vendor/echarts-examples/categories.tsv
rg -i 'sunburst|tree|chord|parallel|matrix|custom' /opt/talos/vendor/echarts-examples/index.tsv
cat /opt/talos/vendor/echarts-examples/public/examples/ts/sunburst-simple.ts
```

The index includes every `.ts`/`.js` example source in the pinned Apache
repository, including GL, documentation and archived examples. It records
titles, categories, minimum versions where supplied, source paths, URLs and
dependency hints. Hints are heuristic; inspect the source. Supplemental and
archived examples may require migration. Upstream sources are references,
not scripts to execute blindly. Do not load the whole collection into context:
search broadly, then read only the candidates needed for this dashboard.

Official gallery: https://echarts.apache.org/examples/en/index.html
Offline revision: `/opt/talos/vendor/echarts-examples/REVISION`.
This is a build-time snapshot, not a promise of future examples or new APIs.
If uncertain about an option, search `/opt/talos/vendor/echarts-types/`.

## Build

```python
import sys
sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

portfolio = {
    "tooltip": {"trigger": "item"},
    "series": [{
        "type": "sunburst", "radius": [0, "90%"],
        "data": [
            {"name": "Services", "children": [
                {"name": "Support", "value": 42},
                {"name": "Beratung", "value": 28}]},
            {"name": "Lizenzen", "value": 30}
        ],
        "emphasis": {"focus": "ancestor"},
        "label": {"rotate": "radial"}
    }]
}
td.dashboard("output/dashboard.html", title="Umsatzstruktur",
    subtitle="2026 — Beispieldaten",
    charts=[td.chart("portfolio", "Wo entsteht der Umsatz?",
                     td.echarts(portfolio), height=480, span=2)],
    footer="Demonstration mit synthetischen Zahlen.")
```

`td.chart(id, title, spec, span=1, height=340, note="")` makes a card.
Give every card a distinct simple ID. `span=2` uses the full grid width.
Use more height for trees, networks, parallel axes or dense calendars.
`td.kpi(label, value, delta="", tone="")` adds a headline tile; tones are
`up`, `down`, or empty. Direction is not automatically good or bad.

Options stay native: `dataset`, `encode`, `visualMap`, `dataZoom`, `brush`,
`timeline`, `graphic`, `media`, multiple grids/axes and any installed series
are available. There is no fixed series whitelist. Do not pass native ECharts
options into a legacy builder spec, or invent `td.sunburst`-style helpers.

## Functions, maps and interactive examples

Python dicts handle ordinary options. Wrap authored JavaScript expressions
with `td.js(...)` for `renderItem`, formatters, symbol sizing, gradients or
other functions. They are emitted as actual JavaScript, without `eval`.
Never interpolate user-provided data into executable code: pass it as data.

```python
option = {
    "xAxis": {}, "yAxis": {},
    "series": [{"type": "scatter", "data": [[10, 20, 100], [30, 15, 400]],
                "symbolSize": td.js("function (v) { return Math.sqrt(v[2]); }")}]
}
spec = td.echarts(option)
```

`td.echarts(option, setup=td.js("function(chart, echarts, data) {...}"),
data=payload, extensions=())` supports preparation and event wiring.
`setup` runs before `setOption`; register maps/transforms and attach events
there. It may return a cleanup function to remove custom timers/listeners.
Setup runs again on theme changes, so clean up side effects. The runtime
preserves legend selection and zoom across theme changes; custom interaction
state must be managed in your setup if needed.

```python
spec = td.echarts(
    {"series": [{"type": "map", "map": "regions", "data": values}]},
    setup=td.js("function (chart, echarts, data) { echarts.registerMap('regions', data); }"),
    data=geojson,
)
```

Translate gallery globals: `myChart` becomes setup's `chart`; use actual
JavaScript rather than TypeScript annotations. Replace demo `app` controls
with intentional chart events or ECharts controls. A timer-based example must
return cleanup (e.g. `return () => clearInterval(timer)`). A custom series can
use a function in `renderItem` without changing the Talos runtime.

## Offline dependencies

- The sandbox and preview have **no outbound network**. No CDN scripts,
  `fetch`, `$.get`, `getScript`, remote map tiles, or sibling runtime assets.
- Official example assets are under
  `/opt/talos/vendor/echarts-examples/public/data/asset/`. Read needed JSON,
  GeoJSON or SVG in Python and embed it via `data`, `dataset` or options.
  Embed required images/textures as data URIs; observe asset licenses.
- `extensions=("echarts-gl",)` inlines the installed GL extension for 3D,
  globe, surface and GL series; the browser must support WebGL.
  `extensions=("echarts-stat",)` supplies global `ecStat`; register needed
  transforms in setup. Extensions are opt-in so ordinary charts stay smaller.
- jQuery, D3, Mapbox/Baidu APIs, API keys and arbitrary third-party plugins
  are not supplied by the core library. An example using them needs adaptation
  (e.g. inline GeoJSON instead of online basemaps) or an explicitly installed
  dependency. Do not claim every upstream demo works unchanged offline.
- Keep all data inline. Convert DataFrames/NumPy/dates to JSON-compatible
  structures, and missing values to `None`; non-finite numbers are rejected.

## Readability and verification

Use theme defaults for categories/text; explicit option colours are available
when semantically useful. Magnitude needs a sequential scale, signed deviation
a diverging one. Avoid copying a gallery's background or rainbow palette just
because it looks striking. Tooltips add detail; titles, units and legends must
make the chart understandable without hover.

Use truthful data, label projections and synthetic data, and show uncertainty
where justified. Use a workspace-relative output path such as
`output/dashboard.html`. When both data and dashboard are requested, export
the same frame used by the charts.

Open the generated page in the preview and inspect every card. Check the
chosen interaction, narrow layout, light/dark appearance and console errors.
For GL, test the actual preview's WebGL support. File existence or file size
alone is not a rendering check. Failures must be fixed or clearly reported.

For maintaining existing `td.line`, `td.waterfall`, etc. dashboards only,
read [legacy-builders.md](references/legacy-builders.md). Mixed pages work;
the scaffold embeds only the chart engines actually needed.
