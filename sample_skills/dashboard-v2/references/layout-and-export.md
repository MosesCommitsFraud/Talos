# Design, formats and downloads

HTML is always the deliverable, with working charts and interactions. Use
`td.compose(...)`; it enables PNG rendering without inserting controls.
HTML and PNG download buttons belong to the Talos preview toolbar. Never author
download controls in the HTML. PNG includes the entire composition, not just
one ECharts canvas. Standalone HTML stays interactive; reopen it in Talos to use
the UI export, or call `window.TALOS_EXPORT.png()` in a rendering/test workflow.

## Choose a canvas

| `page_format` | Layout dimensions (CSS px) | PNG pixels | Use |
| --- | --- | --- | --- |
| `web` | Responsive width and full content height | 2× current layout size | Interactive scrolling HTML, default |
| `16:9` | 1280 × 720 | 1920 × 1080 | Presentation or widescreen dashboard |
| `a4` | 794 × 1123 | 2480 × 3508 | A4 portrait, pixel dimensions for 300 dpi printing |
| `a4-landscape` | 1123 × 794 | 3508 × 2480 | A4 landscape |

Fixed formats retain their composition and scale down as a whole in a narrow
preview; they do not reflow into a long page. PNG output stays at the specified
resolution regardless of preview zoom. These are single canvases. If the story
needs more space, reduce the content or create additional HTML pages, each
exportable through Talos. The exporter rejects overflowing fixed pages instead of silently
cropping. A4 pixel dimensions do not imply embedded printer DPI metadata.

## Build a BI report page

Determine the question and reading order before choosing a layout: header with
logo, title and data freshness → filter context → key figures with comparisons →
main visual in the largest tile → supporting visuals → detail. Size tiles by
importance and keep the same colour for the same measure across all visuals.

`layout_html` replaces the generated header, KPI tiles, grid and footer. You
therefore include the visible title, period, units, notes and sources yourself.
Every chart must appear exactly once as `{{chart:id}}`. The scaffold inserts
only its chart host; put tile titles/notes around it in the authored layout.
`css` is appended after scaffold CSS; scope rules under `#td-artboard` to keep
the outer preview-sizing wrapper intact. Escape data-derived text with `html.escape`.

The page must read well in light and dark mode and from ~420 px (Talos side
panel) up to a wide screen. `#td-artboard` is a size container named
`artboard`: use `@container artboard (max-width: …)` for breakpoints, CSS
variables for every colour and `"@…"` tokens/formatters in chart options.

This example shows the structure; adapt figures, tiles and visuals to the data:

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
  margin:16px 0 28px;border-bottom:1px solid var(--line);}
#td-artboard .figure {display:flex;flex-direction:column;gap:2px;padding:4px 20px 18px 0;}
#td-artboard .figure + .figure {padding-left:20px;border-left:1px solid var(--line);}
#td-artboard .figure .label {font-size:13px;font-weight:500;color:var(--muted);}
#td-artboard .figure strong {font-size:30px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;}
#td-artboard .figure em {font-style:normal;font-size:13px;color:var(--muted);}
#td-artboard .figure i {font-style:normal;}
#td-artboard .up {color:var(--td-good);} #td-artboard .down {color:var(--td-critical);}
#td-artboard .panels {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:32px 36px;}
#td-artboard .panel {min-width:0;}
#td-artboard .panel.full {grid-column:1/-1;}
#td-artboard h2 {font-size:16px;font-weight:600;line-height:1.35;margin:0;}
#td-artboard .sub {font-size:13px;color:var(--muted);margin:2px 0 10px;}
#td-artboard .plot {height:clamp(260px,32cqw,400px);}
#td-artboard .plot .chart {height:100%;}
#td-artboard .drill {width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;}
#td-artboard .drill th, #td-artboard .drill td {padding:8px;border-bottom:1px solid var(--line);text-align:right;}
#td-artboard .drill thead th {font-size:13px;font-weight:500;color:var(--muted);}
#td-artboard .drill th:first-child {text-align:left;font-weight:500;}
#td-artboard .drill td:last-child {width:28%;}
#td-artboard .drill .detail th {padding-left:24px;font-weight:400;color:var(--muted);}
#td-artboard .insights {margin-top:32px;padding-top:16px;border-top:1px solid var(--line);max-width:78ch;}
#td-artboard .insights ol {margin:8px 0 0;padding-left:20px;display:grid;gap:8px;line-height:1.55;}
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

Give CSS-sized chart hosts a definite container height. Fixed-size charts can
instead use `height=...`. The legacy builders still need explicit heights.
For `web`, reflow with container queries on `artboard`. For fixed formats
(`16:9`, A4) the canvas does not reflow; use format-specific selectors such as
`body[data-page-format="a4"] #td-artboard .tiles` for a dedicated arrangement.

## Export fidelity

PNG captures the current theme and chart selection. Keep meaningful labels and
units visible without hover. Embed images as data URIs and fonts locally/inline;
remote resources are unavailable. The exporter rasterizes HTML/CSS through SVG, so exotic
filters, blending, masks and some CSS effects can differ from the live page.
Use straightforward CSS for export-critical designs and inspect the downloaded
PNG, not only the browser preview. ECharts charts are captured through their
own image export, including GL when supported by the browser. GL graphics are
captured at the browser's native resolution and scaled within the final PNG.

Fix blank graphics, cropped text, overlaps or overflow before delivering.
The HTML download remains interactive; PNG does not preserve tooltips or links.
Do not substitute PNG for HTML unless the user explicitly requests that.
