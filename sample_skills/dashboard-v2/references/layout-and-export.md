# Design, formats and downloads

HTML is always the deliverable, with working charts and interactions. Include
`download_png=True` in `td.dashboard(...)` to add HTML and PNG download buttons.
Both work offline; the toolbar is excluded from the PNG. It exports the whole
dashboard (text, background, figures and charts), not just one ECharts canvas.

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
needs more space, reduce the content or create additional HTML pages with their
own downloads. The exporter rejects overflowing fixed pages instead of silently
cropping. A4 pixel dimensions do not imply embedded printer DPI metadata.

## Compose the page, not a wall of tiles

Determine the message and reading order before choosing a layout. Use a focal
chart or number, a strong heading, supporting graphics, intentional whitespace,
short explanations and integrated annotations. Consider editorial columns,
an asymmetric split, a central diagram with callouts, a timeline across the
page, or a report-like composition. Use colour areas, typography, rules and
spacing for grouping; rounded cards are optional. Do not reuse one layout for
every dashboard. Keep the user's branding and desired visual tone.

`layout_html` replaces the generated header, KPI tiles, grid and footer. You
therefore include the visible title, period, units, notes and sources yourself.
Every chart must appear exactly once as `{{chart:id}}`. The scaffold inserts
only its chart host; put headings/notes around it in the authored layout.
`css` is appended after scaffold CSS; scope rules under `#td-artboard` to avoid
restyling download controls. Escape data-derived text with `html.escape`.

This small example demonstrates the API; vary the design for the actual story:

```python
import sys
sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

trend = td.echarts({
    "tooltip": {"trigger": "axis"},
    "grid": {"left": 45, "right": 24, "top": 30, "bottom": 35},
    "xAxis": {"type": "category", "data": ["Q1", "Q2", "Q3", "Q4"]},
    "yAxis": {"type": "value", "name": "Mio. EUR", "min": 0},
    "series": [{"type": "line", "data": [8, 10, 11, 14], "areaStyle": {"opacity": 0.12}}]
})
layout = """
<div class="eyebrow">GESCHÄFTSENTWICKLUNG · 2026 · DEMODATEN</div>
<h1>Wachstum mit<br>klarer Richtung.</h1>
<div class="story">
  <section class="lead"><div class="headline-number">43 Mio.</div>
    <p>Umsatz im Gesamtjahr</p><hr>
    <p>Das vierte Quartal liefert den größten Beitrag.</p>
  </section>
  <section class="figure"><h2>Jedes Quartal gewinnt an Volumen</h2>
    <div class="plot">{{chart:trend}}</div>
  </section>
</div>
<div class="source">Quelle: synthetische Beispieldaten · Beträge in EUR</div>
"""
style = """
#td-artboard {padding:48px 56px; font-family:Georgia,serif;}
#td-artboard .eyebrow {font:12px system-ui;letter-spacing:2px;color:var(--muted)}
#td-artboard h1 {font-size:58px;line-height:1.05;margin:22px 0 28px;}
#td-artboard .story {display:grid;grid-template-columns:280px minmax(0,1fr);gap:60px;}
#td-artboard .story > * {min-width:0;}
#td-artboard .headline-number {font-size:54px;color:var(--td-s1);}
#td-artboard .lead p {font:18px/1.5 system-ui;}
#td-artboard .figure h2 {font:18px system-ui;}
#td-artboard .plot {height:280px;}
#td-artboard .plot .chart {height:100%;}
#td-artboard .source {position:absolute;bottom:32px;font:12px system-ui;color:var(--muted);}
"""
td.dashboard("output/dashboard.html", title="Geschäftsentwicklung 2026",
    charts=[td.chart("trend", "Quartalsumsatz in Mio. EUR", trend, height=None)],
    page_format="16:9", layout_html=layout, css=style, download_png=True)
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
