---
name: dashboard
description: "Use this skill whenever the user asks for a dashboard, an interactive report, a KPI overview, an analysis 'als Dashboard', or any HTML page with charts they will click around in — including follow-ups like 'make that a dashboard', 'add a chart for X', or 'build me an overview of these numbers'. Also use it when you are about to hand-write an HTML file containing charts for any reason. Do NOT trigger for a single static chart image (use python + seaborn/matplotlib + show_image), for an Excel deliverable (that is the spreadsheet path), or for a written report with no charts."
license: MIT
---

# Dashboards (Talos)

A dashboard here is **one self-contained `.html` file** in the workspace. Talos
renders it live in the preview panel and behind an "open in new tab" button, so
the user sees the working page, not the source.

Self-contained is not a style preference — it is the hard constraint everything
else follows from.

## The constraint: no network, ever

The workspace has **no internet access**, and the page is served under a Content
Security Policy that blocks every outbound request: no script `src`, no
stylesheet `href`, no remote fonts, no images by URL, no `fetch`.

So a line like this produces a permanently blank dashboard:

```html
<!-- broken: the CDN is unreachable from the workspace AND blocked by the CSP -->
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
```

Everything the page needs must be *inside* the file: the chart library inlined,
CSS inlined, data inlined as a JS literal, images as `data:` URIs.

## Build it with ECharts

ECharts is pre-installed in the sandbox at
`/opt/talos/vendor/echarts.min.js`. Inline it — don't try to install one.

Write a small Python builder rather than typing the HTML by hand. The builder
reads your data, renders the chart configs, and stitches the page together;
when something is wrong you fix a few lines instead of regenerating 40 KB of
markup.

```python
import json
from pathlib import Path

ECHARTS = Path('/opt/talos/vendor/echarts.min.js').read_text()

def page(title: str, charts: list[dict], kpis: list[dict]) -> str:
    """charts: [{'id': 'revenue', 'title': 'Umsatz', 'option': {...}}, ...]"""
    tiles = "".join(
        f'<div class="kpi"><span class="kpi-label">{k["label"]}</span>'
        f'<span class="kpi-value">{k["value"]}</span>'
        f'<span class="kpi-delta {k.get("tone", "")}">{k.get("delta", "")}</span></div>'
        for k in kpis
    )
    blocks = "".join(
        f'<section class="card"><h2>{c["title"]}</h2>'
        f'<div class="chart" id="{c["id"]}"></div></section>'
        for c in charts
    )
    inits = "\n".join(
        f'echarts.init(document.getElementById({c["id"]!r}), theme)'
        f'.setOption({json.dumps(c["option"], ensure_ascii=False, default=str)});'
        for c in charts
    )
    return f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{CSS}</style>
<script>{ECHARTS}</script>
</head><body>
<header><h1>{title}</h1></header>
<div class="kpis">{tiles}</div>
{blocks}
<script>
const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : null;
{inits}
addEventListener('resize', () => echarts.getInstanceByDom
  && document.querySelectorAll('.chart').forEach(el => echarts.getInstanceByDom(el)?.resize()));
</script>
</body></html>"""

Path('output/dashboard.html').write_text(page(...), encoding='utf-8')
```

`echarts.init(el, 'dark')` gives you a working dark theme for free — use it, and
match the surrounding CSS, so the page doesn't glare in a dark UI.

## Requirements for every dashboard

- **One file**, written to a workspace-relative path — `output/dashboard.html`.
  Never `/tmp`, never an absolute path.
- **Data inlined** as a JS literal or embedded JSON. The page must not read a
  sibling `.csv` at runtime; the preview iframe cannot fetch it.
- **Responsive**: a CSS grid that collapses to one column on narrow screens, and
  charts that `resize()` with the window. The preview panel is narrow.
- **Says what it is**: a title, the period covered, and — when figures are
  projected rather than measured — a visible note saying so. A forecast that
  looks like a measurement is the one failure the user cannot detect themselves.
- **Readable without hovering.** Axis labels, units and a legend on every chart;
  tooltips add detail, they don't carry it.

## Choosing marks

- Trend over time → line; add a shaded `confidence band` (an `'ES'`-styled area
  series) when you are plotting a forecast interval.
- Comparison across categories → bar, sorted by value unless the category order
  carries meaning (months, stages).
- Part-of-whole → stacked bar over time, or a single stacked bar. Reach for a
  pie only with ≤5 slices.
- A single headline number → a KPI tile, not a chart.
- Distribution → boxplot or histogram; don't summarise it to a mean and hide the
  spread.

## Also produce the data

When the user asked for a dashboard *and* data (the usual case), write the
spreadsheet too — `df.to_excel('output/analysis.xlsx', ...)` — from the same
computed frame the charts use, so the two can't disagree. Compute once, render
twice.

## Pitfalls

- **A CDN `<script src>`** gives a blank page with no error the user can see.
  This is the most common way to get this wrong; grep your own output for
  `src="http` before you finish.
- **Regenerating the whole HTML to fix one chart.** Edit the builder, re-run it.
- **`json.dumps` on a DataFrame/Timestamp** raises. Convert first
  (`df.to_dict('records')`, `.strftime('%Y-%m-%d')`) or pass `default=str`.
- **Charts with zero height.** ECharts needs the container to have an explicit
  height before `init` — set one in CSS (`.chart { height: 320px }`).
- **Forgetting to verify.** After writing the file, check it: the size is
  plausible (ECharts alone is ~1 MB, so a 50 KB file means the library did not
  get inlined) and `grep -c 'src="http' output/dashboard.html` returns 0.
