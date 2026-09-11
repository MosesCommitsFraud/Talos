---
name: dashboard-v2
description: "Create designed Apache ECharts dashboards and interactive HTML reports, including 16:9 presentations, A4 dashboards and downloadable PNG versions. Use for dashboard layout, chart and export requests. Not for a standalone static plot, an Excel deliverable, or a report without charts."
license: MIT
---

# Dashboard v2 in Talos — Apache ECharts

Produce one self-contained HTML file using `/opt/talos/vendor/talos_dash.py`.
The scaffold supplies inline runtimes, theme/resize handling, page
formats and PNG rendering for Talos. You design the composition with `layout_html`
and `css`; charts do not have to sit in cards or a uniform tile grid.

**Read [design-direction.md](references/design-direction.md) and
[layout-and-export.md](references/layout-and-export.md) before designing
the page.** HTML always remains the interactive original. Use `td.compose`,
which requires authored HTML and CSS and exposes PNG rendering to Talos.
Downloads belong in the Talos preview toolbar, never inside the artifact.
Choose `page_format="web"` by default, `"16:9"` for a slide,
`"a4"` for A4 portrait or `"a4-landscape"` for A4 landscape when requested.
Design for that canvas from the start; do not squeeze a long web page onto it.

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
   insight in the heading or annotation, rather than the technical chart name.

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

Use `td.compose` for Dashboard v2. It has no automatic card-layout fallback:
you must supply the composition. `td.dashboard` is the old entrypoint for the
original dashboard skill; do not copy that skill's tile examples into v2.

Before coding, establish the audience, decision, headline finding and supporting
evidence. Compare two plausible spatial arrangements and choose the one that
makes this particular story clear. Set typography, palette, spacing and the
dominant visual deliberately. This is design work, not selecting a different
border radius for a grid of identical panels.

```python
import sys
sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

# First author layout_html, css and the selected chart options for this brief.
# Place each chart in layout_html with {{chart:its-id}}.
td.compose("output/dashboard.html", title=title,
    charts=charts, layout_html=layout_html, css=css, page_format="16:9")
```

The API sketch uses your authored variables; a runnable composition example
is in layout-and-export.md. It demonstrates mechanics, not a visual template.
Avoid the stock KPI-strip + two-column-card-grid composition unless the user
explicitly asks for it. A content-driven layout may use a large diagram,
side commentary, integrated comparisons, a flow across the canvas or other
arrangements. Meaningful grouping can still use a panel where appropriate.

`td.chart(id, title, spec, span=1, height=340, note="")` defines a chart.
In `layout_html`, place it with `{{chart:id}}`; no card is imposed. Set
`height=None` for ECharts whose container height is controlled by your CSS.
Give every chart a distinct simple ID. `span` is for legacy automatic cards;
use CSS to allocate space in a composed dashboard.
Use more height for trees, networks, parallel axes or dense calendars.
Integrate headline numbers and comparisons directly in your layout HTML.
Do not call the legacy KPI-tile helper by habit. Direction is not automatically
good or bad; explain what a comparison means for this audience.

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
For fixed formats, verify the full canvas and absence of clipped content.
Click PNG herunterladen in the Talos UI and open the actual PNG: verify dimensions, text,
charts, inline images and background. Download HTML and verify it still opens
interactively. PNG is a static snapshot of the currently selected chart state.
For GL, test the actual preview's WebGL support. File existence or file size
alone is not a rendering check. Failures must be fixed or clearly reported.

At the final visual check, identify the first thing the reader notices, the
comparison that makes it meaningful, and what they should inspect next. If all
regions look equally important or the page is still a wall of cards, change
the spatial hierarchy before delivering. Inspect both HTML and exported PNG.

For maintaining existing `td.line`, `td.waterfall`, etc. dashboards only,
read [legacy-builders.md](references/legacy-builders.md). Mixed pages work;
the scaffold embeds only the chart engines actually needed.
