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
import sys
sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
trend = td.echarts({
    "tooltip": {"trigger": "axis", "valueFormatter": "@eur"},
    "legend": {"top": 0, "right": 0, "itemWidth": 14, "itemHeight": 8},
    "grid": {"left": 8, "right": 8, "top": 36, "bottom": 8},
    "xAxis": {"type": "category", "data": months, "axisTick": {"show": False}},
    "yAxis": {"type": "value", "axisLabel": {"formatter": "@eurCompact"}},
    "series": [
        {"name": "Ist 2026", "type": "line", "smooth": True, "symbol": "none",
         "lineStyle": {"width": 2.5}, "areaStyle": {"opacity": 0.1},
         "data": [3.1e6, 3.0e6, 3.6e6, 3.4e6, 3.8e6, 4.0e6, 3.5e6, 3.3e6, 3.9e6, 4.2e6, 4.4e6, 4.8e6]},
        {"name": "Vorjahr", "type": "line", "smooth": True, "symbol": "none",
         "lineStyle": {"width": 2, "type": "dashed"}, "itemStyle": {"color": "@s3"},
         "data": [2.8e6, 2.9e6, 3.2e6, 3.1e6, 3.3e6, 3.5e6, 3.2e6, 3.0e6, 3.4e6, 3.7e6, 3.8e6, 4.1e6]},
    ],
})
top = td.echarts({
    "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}, "valueFormatter": "@eur"},
    "grid": {"left": 8, "right": 56, "top": 4, "bottom": 4},
    "xAxis": {"type": "value", "show": False},
    "yAxis": {"type": "category", "inverse": True, "axisTick": {"show": False}, "axisLine": {"show": False},
              "axisLabel": {"width": 110, "overflow": "truncate"},
              "data": ["Nord", "West", "Süd", "Ost", "Export"]},
    "series": [{"type": "bar", "barMaxWidth": 22, "itemStyle": {"borderRadius": 2},
                "label": {"show": True, "position": "right", "formatter": "@eurCompact"},
                "data": [14.2e6, 11.8e6, 9.6e6, 5.1e6, 2.3e6]}],
})
charts = [td.chart("trend", "Umsatz nach Monat, Ist vs. Vorjahr", trend, height=None),
          td.chart("top", "Umsatz nach Region", top, height=None)]
layout = """
<header class="bar">{{brand:logo}}<h1>Vertriebsübersicht 2026</h1>
  <span class="meta">Stand 31.12.2026 · Beträge in €</span></header>
<nav class="filters"><span>Zeitraum <b>Jan–Dez 2026</b></span><span>Region <b>Alle</b></span>
  <span>Sparte <b>Alle</b></span></nav>
<section class="figures">
  <div class="figure"><span class="label">Umsatz</span><strong>43,0 Mio. €</strong><em><i class="up">▲</i> 12,0 % ggü. Vorjahr</em></div>
  <div class="figure"><span class="label">Deckungsbeitrag</span><strong>15,9 Mio. €</strong><em><i class="up">▲</i> 4,1 % ggü. Vorjahr</em></div>
  <div class="figure"><span class="label">Aufträge</span><strong>1.284</strong><em><i class="down">▼</i> 2,3 % ggü. Vorjahr</em></div>
  <div class="figure"><span class="label">Ø Auftragswert</span><strong>33.500 €</strong><em><i class="up">▲</i> 14,6 % ggü. Vorjahr</em></div>
</section>
<section class="tiles">
  <article class="tile wide"><h2>Das vierte Quartal wächst am stärksten</h2>
    <p class="sub">Umsatz nach Monat, Ist 2026 und Vorjahr</p><div class="plot">{{chart:trend}}</div></article>
  <article class="tile"><h2>Nord und West tragen 60 %</h2>
    <p class="sub">Umsatz nach Region 2026</p><div class="plot">{{chart:top}}</div></article>
</section>
<p class="source">Quelle: synthetische Beispieldaten</p>
"""
style = """
#td-artboard {background:var(--bg);}
#td-artboard .bar {display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding-bottom:12px;border-bottom:1px solid var(--line);}
#td-artboard .bar .brand-logo {height:24px;}
#td-artboard h1 {font-size:20px;font-weight:600;line-height:1.3;margin:0;}
#td-artboard .meta {margin-left:auto;font-size:13px;color:var(--muted);}
#td-artboard .filters {display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 16px;font-size:13px;color:var(--muted);}
#td-artboard .filters span {border:1px solid var(--line);border-radius:6px;padding:3px 10px;}
#td-artboard .filters b {color:var(--fg);font-weight:500;margin-left:4px;}
#td-artboard .figures, #td-artboard .tile {background:var(--td-surface);border:1px solid var(--line);border-radius:8px;min-width:0;}
#td-artboard .figures {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));overflow:hidden;}
#td-artboard .figure {display:flex;flex-direction:column;gap:2px;padding:14px 18px;
  border-left:1px solid var(--line);border-top:1px solid var(--line);margin:-1px 0 0 -1px;}
#td-artboard .figure .label {font-size:13px;font-weight:500;color:var(--muted);}
#td-artboard .figure strong {font-size:26px;font-weight:600;line-height:1.25;font-variant-numeric:tabular-nums;}
#td-artboard .figure em {font-style:normal;font-size:13px;color:var(--muted);}
#td-artboard .figure i {font-style:normal;} #td-artboard .figure .up {color:var(--td-good);}
#td-artboard .figure .down {color:var(--td-critical);}
#td-artboard .tiles {display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;margin-top:14px;}
#td-artboard .tile {grid-column:span 4;padding:14px 16px;}
#td-artboard .tile.wide {grid-column:span 8;}
#td-artboard .tile h2 {font-size:15px;font-weight:600;line-height:1.35;margin:0;}
#td-artboard .tile .sub {font-size:13px;color:var(--muted);margin:2px 0 8px;}
#td-artboard .plot {height:clamp(240px,30cqw,360px);}
#td-artboard .plot .chart {height:100%;}
#td-artboard .source {font-size:12px;color:var(--muted);margin:12px 0 0;}
@container artboard (max-width: 900px) {
  #td-artboard .tile, #td-artboard .tile.wide {grid-column:span 6;}
}
@container artboard (max-width: 620px) {
  #td-artboard .tile, #td-artboard .tile.wide {grid-column:1/-1;}
  #td-artboard .meta {margin-left:0;width:100%;}
  #td-artboard .figure strong {font-size:22px;}
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
