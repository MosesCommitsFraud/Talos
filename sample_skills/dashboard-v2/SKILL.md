---
name: dashboard-v2
description: "Create designed Apache ECharts dashboards and interactive HTML reports, including 16:9 presentations, A4 dashboards and downloadable PNG versions. Use for dashboard layout, chart and export requests. Not for a standalone static plot, an Excel deliverable, or a report without charts."
license: MIT
---

# Dashboard v2 in Talos (Apache ECharts, macs design)

Produce one self-contained HTML file with `td.compose` from
`/opt/talos/vendor/talos_dash.py`. **Everything required is in this file.**
The files under `references/` are optional depth: fixed page formats and PNG
details (`layout-and-export.md`) and the old builders (`legacy-builders.md`,
only for maintaining old dashboards).

## Workflow

1. Load and aggregate the data in Python. Compute every figure you will show
   (totals, shares, changes, top positions) before writing any markup.
2. Decide what the reader must see: 3–5 key figures, as many visuals as the
   question needs (one for a narrow question, ten for a broad overview), a
   table where exact values matter, and 3–4 insights with numbers. For each
   visual pick the chart type from "Choosing charts" below, not by habit.
3. Start from the **complete example below** and adapt it. Keep its structure,
   class names, CSS approach and interaction pattern; change content and charts.
4. Call `td.compose(...)`. It checks design, numbers, wording and interaction.
   If it raises, fix **every** listed point and call it again. Do not work
   around the check (no `brand=None`, no legacy builders, no `td.dashboard`).
5. Verify the rendered page (see the checklist at the end).

## Rules that make or break the page

**Charts**
- Only `td.echarts(option)`. The full ECharts API is available: every series
  listed in "Choosing charts" below (22 series types, all components, GL).
- `td.chart(id, title, spec, height=None)` and a CSS height on the container.
- Leave axis, label, legend, tooltip and split-line colours to the theme.
- Series colours only as tokens: `"@s1"` macs blue (main measure), `"@s2"`
  petrol, `"@s3"` light blue (comparison), `"@s4"` amber (one highlight),
  `"@q1"`…`"@q5"` sequential scale, `"@muted"`, `"@good"`, `"@critical"`,
  `"@s1/12"` = 12 % opacity. Colour callbacks may return tokens too.
- Numbers only through formatters: `"@eurCompact"` (41,8 Mio. €), `"@eur"`,
  `"@num"`, `"@numCompact"`, `"@pct"`, or templates like
  `"{b}\n{d} · @eurCompact"` ({a} series, {b} name, {d} pie share).
  Set `tooltip.valueFormatter` on every chart.
- Keep `grid.left/right` ≤ 48. Value labels outside bars get headroom
  automatically. Donuts: 2–5 slices, labels with share and amount.

**Numbers in HTML**
- `td.eur(v)` → "20,7 Mio. €", `td.eur(v, compact=False)` → "20.748.512 €",
  `td.pct(62.06)` → "62,1 %", `td.pct(4.1, signed=True)` → "+4,1 %",
  `td.num(12037)` → "12.037", `td.meter(share)` → in-cell bar (0–100).
- Put finished values into the f-string. There is no template engine:
  `{{eur 123}}` or similar is rejected.
- Key figures people already use: Umsatz, Deckungsbeitrag, Veränderung ggü.
  Vorjahr/Plan, Anteil der größten Position, Anzahl Kunden/Aufträge. No
  invented ratios such as "Ø Umsatz/Produkt".

**Colour and theme**
- No hex, `rgb()`, `white` or `black` anywhere, and no redefining theme
  variables. CSS uses `var(--bg)`, `var(--fg)`, `var(--muted)`, `var(--line)`,
  `var(--td-surface)`, `var(--brand-blue)`, `var(--brand-tint)`,
  `var(--td-good)`, `var(--td-critical)`.
- Pages are light by default; the Talos preview switches them to the app
  theme. Never write `prefers-color-scheme` rules.

**Typography**
- Encode Sans is set. Body 14px, minimum 12px, weights 400/500/600 only.
- Title 20–22px, section headings 15–16px, key figures 26–32px.
- Sentence case, no uppercase letter-spaced labels, no emoji.

**Layout (open, not boxed)**
- Rows of identical rounded cards look generated. Group with whitespace,
  alignment and hairlines (`1px solid var(--line)`), as in the example.
- Header: `{{brand:logo}}` (standalone, never inside `<img>`), title, data
  freshness. Key figures as an open band with vertical hairlines. Visuals
  directly on the page. Insights as a plain section under a hairline.
- Grid: `repeat(auto-fit, minmax(min(100%, 420px), 1fr))`. Wide visuals
  `grid-column: span 2` inside `@container artboard (min-width: 900px)`,
  full width `1 / -1`. No 12-column grids.
- Breakpoints only with `@container artboard (…)`, never `@media (…width)`.
  The page must work at ~420 px (Talos side panel) and on a wide screen.
- Chart heights with `clamp()`, e.g. `height: clamp(260px, 24cqw, 360px)`.
- Use space efficiently but keep it calm: 16–28px between sections, no half
  empty rows (let a lone last visual span the row), no oversized margins. Charts
  need room: at least ~420px wide; long category names go into horizontal bars;
  more than 6 parts of a whole go into a sorted bar chart, not a pie.

**Interaction (required when there are two or more charts)**
- Chart as filter: `"talos": {"emit": "region"}` in the option. A click sets
  the filter, a second click clears it; other items fade.
- Chart reacting: `"talos": {"filter": "region", "views": {value: option_patch}}`
  with patches precomputed in Python (e.g. `{"series": [{"data": [...]}]}`).
- Table drill-down: parent rows `data-filter-set="region" data-value="Nord"`,
  child rows `data-filter="region" data-value="Nord" data-collapsed`.
- Filter state: `<b data-filter-status="region"></b>` and an element with
  `data-filter-reset="region"`; `data-filter="region" data-value=""` shows
  something only while unfiltered.

**Insights (required)**
- An element with `class="insights"` holding 3–4 `<li>`. Each point states a
  finding with its number and what follows from it: concentration risk,
  dependence on top customers/products, trend breaks, outliers, next check.

**Language**
Short, factual German sentences that start with the finding. Rejected:
em dash (—) and spaced en dash ( – ) as punctuation (ranges like Jan–Dez are
fine), list items starting with a bold label and colon, stock phrases such as
nahtlos, ganzheitlich, maßgeschneidert, essenziell, bahnbrechend,
bemerkenswert, "spielt eine (entscheidende) Rolle", "es ist wichtig zu
beachten", "nicht nur … sondern auch", and emoji. Also avoid three-part lists
by habit, "Nicht X, sondern Y", hedging with "kann" and vague sources.

## Complete example

```python
import html
import sys
sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
ist = [3.1e6, 3.0e6, 3.6e6, 3.4e6, 3.8e6, 4.0e6, 3.5e6, 3.3e6, 3.9e6, 4.2e6, 4.4e6, 4.8e6]
vorjahr = [2.8e6, 2.9e6, 3.2e6, 3.1e6, 3.3e6, 3.5e6, 3.2e6, 3.0e6, 3.4e6, 3.7e6, 3.8e6, 4.1e6]
regions = {"Nord": 14.2e6, "West": 11.8e6, "Süd": 9.6e6, "Ost": 5.1e6, "Export": 2.3e6}
products = {  # region -> [(product, revenue)]
    "Nord": [("Vitamin C", 8.1e6), ("Magnesium", 3.9e6), ("Mints", 2.2e6)],
    "West": [("Vitamin C", 6.0e6), ("Traubenzucker", 4.1e6), ("Mints", 1.7e6)],
    "Süd": [("Traubenzucker", 5.2e6), ("Vitamin C", 3.1e6), ("Mints", 1.3e6)],
    "Ost": [("Vitamin C", 3.4e6), ("Mints", 1.7e6)],
    "Export": [("Vitamin C", 2.3e6)],
}
total = sum(regions.values())

trend = td.echarts({
    "tooltip": {"trigger": "axis", "valueFormatter": "@eur"},
    "legend": {"top": 0, "right": 0, "itemWidth": 14, "itemHeight": 8},
    "grid": {"left": 8, "right": 8, "top": 36, "bottom": 8},
    "xAxis": {"type": "category", "data": months, "axisTick": {"show": False}},
    "yAxis": {"type": "value", "axisLabel": {"formatter": "@eurCompact"}},
    "series": [
        {"name": "Ist 2026", "type": "line", "smooth": True, "symbol": "none",
         "lineStyle": {"width": 2.5}, "areaStyle": {"color": "@s1/12"}, "data": ist},
        {"name": "Vorjahr", "type": "line", "smooth": True, "symbol": "none",
         "lineStyle": {"width": 2, "type": "dashed"}, "itemStyle": {"color": "@s3"}, "data": vorjahr},
    ],
    # Reacts to the region filter: the same months, scaled to that region.
    "talos": {"filter": "region", "views": {
        r: {"series": [{"data": [round(v * rev / total) for v in ist]},
                       {"data": [round(v * rev / total) for v in vorjahr]}]}
        for r, rev in regions.items()}},
})
by_region = td.echarts({
    "tooltip": {"trigger": "item", "valueFormatter": "@eur"},
    "series": [{"type": "pie", "radius": ["48%", "72%"], "center": ["50%", "52%"],
                "label": {"formatter": "{b}\n{d} · @eurCompact"},
                "data": [{"name": r, "value": v} for r, v in regions.items()]}],
    "talos": {"emit": "region"},  # click a slice to filter the page
})
charts = [td.chart("trend", "Umsatz nach Monat, Ist vs. Vorjahr", trend, height=None),
          td.chart("regions", "Umsatz nach Region", by_region, height=None)]

rows = []
for r, rev in regions.items():
    share = rev / total * 100
    rows.append(f'<tr data-filter-set="region" data-value="{html.escape(r)}"><th scope="row">{html.escape(r)}</th>'
                f'<td>{td.eur(rev)}</td><td>{td.pct(share)}</td><td>{td.meter(share)}</td></tr>')
    for name, prod_rev in products[r]:
        rows.append(f'<tr class="detail" data-filter="region" data-value="{html.escape(r)}" data-collapsed>'
                    f'<th scope="row">{html.escape(name)}</th><td>{td.eur(prod_rev)}</td>'
                    f'<td>{td.pct(prod_rev / rev * 100)}</td><td>{td.meter(prod_rev / rev * 100)}</td></tr>')
rows_html = "".join(rows)
nord_share = td.pct(regions["Nord"] / total * 100)

layout = f"""
<header class="bar">{{{{brand:logo}}}}<h1>Vertriebsübersicht 2026</h1>
  <span class="meta">Stand 31.12.2026 · Beträge in €</span></header>
<nav class="filters"><span>Zeitraum <b>Jan–Dez 2026</b></span>
  <span data-filter="region" data-value="">Region <b>Alle</b></span>
  <span data-filter-reset="region">Region <b data-filter-status="region"></b> ×</span></nav>
<section class="figures">
  <div class="figure"><span class="label">Umsatz</span><strong>{td.eur(total)}</strong><em><i class="up">▲</i> {td.pct(12.0, signed=True)} ggü. Vorjahr</em></div>
  <div class="figure"><span class="label">Größte Region</span><strong>Nord</strong><em>{nord_share} vom Umsatz</em></div>
  <div class="figure"><span class="label">Aufträge</span><strong>{td.num(1284)}</strong><em><i class="down">▼</i> {td.pct(-2.3)} ggü. Vorjahr</em></div>
</section>
<section class="panels">
  <article class="panel wide"><h2>Das vierte Quartal wächst am stärksten</h2>
    <p class="sub">Umsatz nach Monat, Ist 2026 und Vorjahr</p><div class="plot">{{{{chart:trend}}}}</div></article>
  <article class="panel"><h2>Nord und West tragen 60 % des Umsatzes</h2>
    <p class="sub">Umsatzanteil nach Region. Ein Klick filtert die Seite.</p><div class="plot">{{{{chart:regions}}}}</div></article>
  <article class="panel full"><h2>Regionen und Produkte</h2>
    <p class="sub">Zeile anklicken, um die Produkte zu sehen</p>
    <table class="drill"><thead><tr><th>Region / Produkt</th><th>Umsatz</th><th>Anteil</th><th></th></tr></thead>
    <tbody>{rows_html}</tbody></table></article>
</section>
<section class="insights"><h2>Auffälligkeiten und Empfehlungen</h2><ol>
  <li>Vitamin C bringt {td.pct(22.9 / 43.0 * 100)} des Umsatzes. Fällt das Produkt aus, fehlt mehr als die Hälfte; ein zweites starkes Produkt im Sortiment würde das Risiko senken.</li>
  <li>Nord und West liefern zusammen {td.pct(26.0 / 43.0 * 100)}. Die Großkunden dieser Regionen sollten im Forecast einzeln betrachtet werden.</li>
  <li>Der Export kommt auf {td.eur(2.3e6)} mit einem einzigen Produkt. Hier lohnt eine Entscheidung, ob ausgebaut oder zurückgefahren wird.</li>
  <li>Die Aufträge sinken um 2,3 %, der Umsatz steigt um 12 %. Vor der Planung 2027 prüfen, ob Preise oder Produktmix den Anstieg erklären.</li>
</ol></section>
<p class="source">Quelle: synthetische Beispieldaten</p>
"""
style = """
#td-artboard .bar {display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding-bottom:12px;border-bottom:1px solid var(--line);}
#td-artboard .bar .brand-logo {height:24px;}
#td-artboard h1 {font-size:21px;font-weight:600;line-height:1.3;margin:0;}
#td-artboard .meta {margin-left:auto;font-size:13px;color:var(--muted);}
#td-artboard .filters {display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px;font-size:13px;color:var(--muted);}
#td-artboard .filters span {border:1px solid var(--line);border-radius:6px;padding:3px 10px;}
#td-artboard .filters b {color:var(--fg);font-weight:500;margin-left:4px;}
#td-artboard .figures {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));
  margin:10px 0 18px;border-bottom:1px solid var(--line);}
#td-artboard .figure {display:flex;flex-direction:column;gap:2px;padding:4px 20px 18px 0;}
#td-artboard .figure + .figure {padding-left:20px;border-left:1px solid var(--line);}
#td-artboard .figure .label {font-size:13px;font-weight:500;color:var(--muted);}
#td-artboard .figure strong {font-size:30px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;}
#td-artboard .figure em {font-style:normal;font-size:13px;color:var(--muted);}
#td-artboard .figure i {font-style:normal;}
#td-artboard .up {color:var(--td-good);} #td-artboard .down {color:var(--td-critical);}
#td-artboard .panels {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:20px 28px;}
#td-artboard .panel {min-width:0;}
#td-artboard .panel.full {grid-column:1/-1;}
#td-artboard h2 {font-size:16px;font-weight:600;line-height:1.35;margin:0;}
#td-artboard .sub {font-size:13px;color:var(--muted);margin:2px 0 6px;}
#td-artboard .plot {height:clamp(260px,24cqw,360px);}
#td-artboard .plot .chart {height:100%;}
#td-artboard .drill {width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;}
#td-artboard .drill th, #td-artboard .drill td {padding:8px;border-bottom:1px solid var(--line);text-align:right;}
#td-artboard .drill thead th {font-size:13px;font-weight:500;color:var(--muted);}
#td-artboard .drill th:first-child {text-align:left;font-weight:500;}
#td-artboard .drill td:last-child {width:28%;}
#td-artboard .drill .detail th {padding-left:24px;font-weight:400;color:var(--muted);}
#td-artboard .insights {margin-top:22px;padding-top:12px;border-top:1px solid var(--line);}
#td-artboard .insights ol {margin:6px 0 0;padding-left:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:6px 36px;line-height:1.5;}
#td-artboard .source {font-size:12px;color:var(--muted);margin:20px 0 0;}
@container artboard (min-width: 900px) {
  #td-artboard .panel.wide {grid-column:span 2;}
}
@container artboard (max-width: 620px) {
  #td-artboard .meta {margin-left:0;width:100%;}
  #td-artboard .figure, #td-artboard .figure + .figure {padding:10px 0;border-left:0;border-top:1px solid var(--line);}
  #td-artboard .figure strong {font-size:24px;}
  #td-artboard .drill td:nth-child(3) {display:none;}
}
"""
td.compose("output/dashboard.html", title="Vertriebsübersicht 2026",
    charts=charts, layout_html=layout, css=style)
```

Page formats: `page_format="web"` (default, responsive), `"16:9"`, `"a4"`,
`"a4-landscape"`. Fixed formats are one canvas that must not overflow; design
for it from the start (details in `references/layout-and-export.md`).
Downloads (HTML/PNG) live in the Talos preview toolbar, never in the page.

## Choosing charts: everything ECharts 6 offers

Pick by the reader's question, not by habit. Bars, lines and donuts are right
often, but check this list for every visual. All of these work with
`td.echarts`, tokens, formatters and filters.

**All series types (`series[].type`)**

| type | Use it when | Notes |
| --- | --- | --- |
| `bar` | compare categories, rankings, periods; stacked for composition; horizontal for long names | sorted descending for rankings; `stack` for parts of a total; waterfall = stacked bar with a transparent base series |
| `line` | development over time, Ist vs. Vorjahr/Plan, many periods | `areaStyle` for the main series only, `step` for price/stock levels, `markLine` for targets/averages |
| `pie` | share of 2–5 parts of one total | `radius: [inner, outer]` for donut, `roseType` only for seasonal patterns |
| `scatter` | relationship of two measures (Umsatz vs. Marge), outliers; bubble size = third measure | `symbolSize` via `td.js` function |
| `effectScatter` | a few points that must draw attention (top locations on a map) | use sparingly |
| `radar` | profile of few items across 4–8 normalized criteria | normalize axes, max 3 items |
| `heatmap` | two categorical dimensions (Kunde × Monat, Produkt × Region), density | `visualMap` with `"@q1"`…`"@q5"`; also on `calendar` |
| `tree` | parent-child structure (Kostenstellen, Organisation) | orient `LR`, collapsible |
| `treemap` | hierarchical size (Umsatz by Gruppe → Produkt), many items | built-in drill-down on click, `leafDepth` |
| `sunburst` | hierarchical shares over 2–3 levels | click drills into a ring |
| `boxplot` | distribution per group (Auftragswerte je Region), spread and outliers | compute quartiles in Python |
| `candlestick` | open/high/low/close series (prices, daily ranges) | with `dataZoom` |
| `map` | values per region/country (choropleth) | GeoJSON inline via `setup` + `registerMap`, no online tiles |
| `lines` | flows or routes between locations on `geo` | with `effect` only if movement matters |
| `graph` | networks: relations between customers, products, sites | `layout: 'force'` or `'circular'` |
| `sankey` | volume flowing through stages or from source to target (Umsatz Region → Kanal → Produkt) | flows must add up |
| `chord` | mutual flows between a set of entities (ECharts 6) | few entities |
| `funnel` | ordered conversion stages (Anfrage → Angebot → Auftrag) | only real sequential stages |
| `gauge` | one value against a target or range | a plain key figure is often clearer |
| `pictorialBar` | bars made of symbols, progress towards a target | only when the symbol adds meaning |
| `themeRiver` | composition changing over time (streamgraph) | mix matters more than exact values |
| `parallel` | many measures per item, find profiles | with `brush` |
| `custom` | anything else: Gantt, bullet chart, dumbbell, violin, range bands | `renderItem` via `td.js` |

**Coordinate systems and components worth combining**

- `grid` (several grids for small multiples), `polar` (radial bars),
  `singleAxis`, `calendar` (heatmap/scatter per day), `geo`, `parallel`,
  `matrix` (ECharts 6, charts arranged in a table layout).
- `dataset` + `encode` + `transform` (filter/sort/aggregate in the chart),
  `dataZoom` (long series), `visualMap` (colour scales), `brush` (select
  ranges), `timeline` (switch periods), `markLine`/`markArea`/`markPoint`
  (targets, averages, events), `graphic` (annotations), `legend`, `tooltip`,
  `axisPointer` (linked crosshair), `universalTransition` (animated drill).
- GL (`extensions=("echarts-gl",)`): `bar3D`, `scatter3D`, `line3D`,
  `surface`, `globe`, `map3D`, `lines3D`, `scatterGL`, `graphGL`, `flowGL`.
  Only when a third dimension is real; needs WebGL.

**Source examples.** The complete official example index is offline; read the
source of a candidate before adapting it:

```bash
cat /opt/talos/vendor/echarts-examples/categories.tsv
rg -i 'sunburst|treemap|sankey|heatmap|custom' /opt/talos/vendor/echarts-examples/index.tsv
cat /opt/talos/vendor/echarts-examples/public/examples/ts/sunburst-simple.ts
```

Read only the candidates you need, then adapt them: `myChart` becomes the
`chart` argument of `setup`, TypeScript annotations go, demo `app` controls
become real ECharts controls, and every colour becomes a token. If unsure about
an option, search `/opt/talos/vendor/echarts-types/`.

## Functions, setup and offline data

- JavaScript callbacks (`renderItem`, `symbolSize`, custom formatters) go
  through `td.js("function (p) { … }")`. Never put user data into code.
- `td.echarts(option, setup=td.js("function (chart, echarts, data) {…}"),
  data=payload)` for maps (`echarts.registerMap`), transforms and events.
  Setup runs again on theme changes; return a cleanup function for timers.
- No network in sandbox or preview: no CDN scripts, no `fetch`. Example assets
  are in `/opt/talos/vendor/echarts-examples/public/data/asset/`; embed them
  via `data`/`dataset`. `extensions=("echarts-gl",)` or `("echarts-stat",)`
  when needed.
- Convert DataFrames/NumPy/dates to plain JSON types; missing values → `None`.

## Verify before delivering

Open the page in the Talos preview and check:

- Dark mode and light mode: every text, chip, axis and label readable.
- Narrow panel (~420 px): nothing clipped, no horizontal scroll, sections stack.
- Key figures show values (no placeholders), numbers in German format.
- Click each filter source: dependent charts, rows and the status update; a
  second click drills back up. Hover bars and slices: nothing disappears.
- The first thing a reader sees is the main finding with its comparison.
- For fixed formats and PNG export: the whole canvas, nothing cut off.

Report any failure you could not fix instead of claiming the page works.
