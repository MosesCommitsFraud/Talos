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
logo, title and data freshness → filter context → KPI cards with comparisons →
main visual in the largest tile → supporting visuals → detail. Use a CSS grid of
white tiles on the grey canvas; size tiles by importance. Keep the same colour
for the same measure across all visuals.

`layout_html` replaces the generated header, KPI tiles, grid and footer. You
therefore include the visible title, period, units, notes and sources yourself.
Every chart must appear exactly once as `{{chart:id}}`. The scaffold inserts
only its chart host; put tile titles/notes around it in the authored layout.
`css` is appended after scaffold CSS; scope rules under `#td-artboard` to keep
the outer preview-sizing wrapper intact. Escape data-derived text with `html.escape`.

This example shows the BI structure in macs colours; adapt KPIs, tiles and
visuals to the actual data:

```python
import sys
sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
trend = td.echarts({
    "tooltip": {"trigger": "axis"},
    "legend": {"top": 0, "right": 0, "itemWidth": 14, "itemHeight": 8},
    "grid": {"left": 44, "right": 12, "top": 30, "bottom": 24},
    "xAxis": {"type": "category", "data": months, "axisTick": {"show": False}},
    "yAxis": {"type": "value", "name": "Mio. €"},
    "series": [
        {"name": "Ist 2026", "type": "line", "smooth": True, "symbol": "none", "lineStyle": {"width": 2.5},
         "areaStyle": {"opacity": 0.1}, "data": [3.1, 3.0, 3.6, 3.4, 3.8, 4.0, 3.5, 3.3, 3.9, 4.2, 4.4, 4.8]},
        {"name": "Vorjahr", "type": "line", "smooth": True, "symbol": "none", "lineStyle": {"width": 2, "type": "dashed"},
         "data": [2.8, 2.9, 3.2, 3.1, 3.3, 3.5, 3.2, 3.0, 3.4, 3.7, 3.8, 4.1]},
    ],
})
top = td.echarts({
    "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
    "grid": {"left": 92, "right": 48, "top": 4, "bottom": 4},
    "xAxis": {"type": "value", "show": False},
    "yAxis": {"type": "category", "inverse": True, "axisTick": {"show": False}, "axisLine": {"show": False},
              "data": ["Nord", "West", "Süd", "Ost", "Export"]},
    "series": [{"type": "bar", "barMaxWidth": 18, "itemStyle": {"borderRadius": 2},
                "label": {"show": True, "position": "right", "formatter": "{c} Mio."},
                "data": [14.2, 11.8, 9.6, 5.1, 2.3]}],
})
charts = [td.chart("trend", "Umsatz nach Monat, Ist vs. Vorjahr", trend, height=None),
          td.chart("top", "Umsatz nach Region", top, height=None)]
layout = """
<header class="bar">{{brand:logo}}<h1>Vertriebsübersicht 2026</h1>
  <span class="meta">Stand 31.12.2026 · Beträge in Mio. €</span></header>
<nav class="filters"><span>Zeitraum <b>Jan–Dez 2026</b></span><span>Region <b>Alle</b></span>
  <span>Sparte <b>Alle</b></span></nav>
<section class="kpis">
  <div class="kpi"><label>Umsatz</label><strong>43,0</strong><em class="up">▲ 12,0 % ggü. Vorjahr</em></div>
  <div class="kpi"><label>Deckungsbeitrag</label><strong>15,9</strong><em class="up">▲ 4,1 % ggü. Vorjahr</em></div>
  <div class="kpi"><label>Aufträge</label><strong>1.284</strong><em class="down">▼ 2,3 % ggü. Vorjahr</em></div>
  <div class="kpi"><label>Ø Auftragswert</label><strong>33,5 T€</strong><em class="up">▲ 14,6 % ggü. Vorjahr</em></div>
</section>
<section class="tiles">
  <article class="tile wide"><h2>Umsatz nach Monat, Ist vs. Vorjahr</h2><div class="plot">{{chart:trend}}</div></article>
  <article class="tile"><h2>Umsatz nach Region</h2><div class="plot">{{chart:top}}</div></article>
</section>
<p class="source">Quelle: synthetische Beispieldaten</p>
"""
style = """
#td-artboard {padding:0 20px 16px;background:var(--brand-grey);color:var(--fg);}
#td-artboard .bar {display:flex;align-items:center;gap:16px;height:56px;margin:0 -20px;padding:0 20px;
  background:var(--td-surface);border-bottom:1px solid var(--line);}
#td-artboard .bar .brand-logo {height:26px;}
#td-artboard h1 {font-size:20px;font-weight:600;margin:0;padding-left:16px;border-left:1px solid var(--line);}
#td-artboard .meta {margin-left:auto;font-size:12px;color:var(--muted);}
#td-artboard .filters {display:flex;gap:8px;margin:14px 0;font-size:12px;color:var(--muted);}
#td-artboard .filters span {background:var(--td-surface);border:1px solid var(--line);border-radius:4px;padding:5px 10px;}
#td-artboard .filters b {color:var(--brand-blue);font-weight:600;margin-left:4px;}
#td-artboard .kpis {display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
#td-artboard .kpi, #td-artboard .tile {background:var(--td-surface);border:1px solid var(--line);border-radius:6px;
  box-shadow:0 1px 2px rgba(16,24,40,.06);min-width:0;}
#td-artboard .kpi {padding:12px 16px;border-top:3px solid var(--brand-blue);display:flex;flex-direction:column;}
#td-artboard .kpi label {font-size:12px;color:var(--muted);}
#td-artboard .kpi strong {font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--brand-deep);}
#td-artboard .kpi em {font-style:normal;font-size:12px;}
#td-artboard .up {color:var(--td-good);} #td-artboard .down {color:var(--td-critical);}
#td-artboard .tiles {display:grid;grid-template-columns:repeat(12,1fr);gap:14px;margin-top:14px;}
#td-artboard .tile {grid-column:span 4;padding:12px 14px;}
#td-artboard .tile.wide {grid-column:span 8;}
#td-artboard .tile h2 {font-size:13px;font-weight:600;margin:0 0 6px;color:var(--brand-deep);}
#td-artboard .plot {height:360px;}
#td-artboard .plot .chart {height:100%;}
#td-artboard .source {font-size:11px;color:var(--muted);margin:10px 0 0;}
"""
td.compose("output/dashboard.html", title="Vertriebsübersicht 2026",
    charts=charts, page_format="16:9", layout_html=layout, css=style)
```

Give CSS-sized chart hosts a definite container height. Fixed-size charts can
instead use `height=...`. The legacy builders still need explicit heights.
For `web`, use responsive CSS to stack sections when needed. For fixed formats,
avoid viewport-based media queries that alter the composition when the preview
is narrow; use format-specific selectors such as
`body[data-page-format="a4"] #td-artboard .story` or a dedicated layout instead.

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
