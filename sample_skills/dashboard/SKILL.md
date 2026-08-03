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

ECharts 6.1 is pre-installed in the sandbox. Inline it — don't try to install
one, and don't reach for a CDN.

| Path | What it is |
| --- | --- |
| `/opt/talos/vendor/echarts.min.js` | the UMD build — inline this into every page |
| `/opt/talos/vendor/echarts-themes/*.js` | 36 official themes — inline one after the library |
| `/opt/talos/vendor/echarts.d.ts` | the full option reference, offline and greppable |
| `/opt/talos/vendor/echarts.version` | the exact version, when you need to check |

Write a small Python builder rather than typing the HTML by hand. The builder
reads your data, renders the chart configs, and stitches the page together;
when something is wrong you fix a few lines instead of regenerating 40 KB of
markup.

**ECharts option keys are camelCase** — `xAxis`, `yAxis`, `axisLabel`,
`markPoint`, `areaStyle`. Writing them in Python tempts you into `xaxis` /
`yaxis`, and that mistake is silent and total: ECharts ignores the unknown key,
finds no axis for the series, and throws `TypeError: Cannot read properties of
undefined (reading 'get')` out of `setOption`. The exception aborts the rest of
the script, so **every chart after the first one is never created either** — the
whole page is empty boxes. Validate before you write (see `check_option` below).

A complete, correct option looks like this:

```python
option = {
    "title": {"text": "Nettoumsatz — Ist / Plan / Prognose", "left": "center"},
    "tooltip": {"trigger": "axis"},
    "legend": {"data": ["Ist", "Prognose"], "top": 30},
    "xAxis": {"type": "category", "data": ["2023", "2024", "2025"]},
    "yAxis": {"type": "value", "name": "Mio. €"},
    "series": [
        {"name": "Ist", "type": "line", "data": [44.9, 45.0, 45.2],
         "lineStyle": {"width": 3}},
        {"name": "Prognose", "type": "line", "data": [None, None, 46.1],
         "lineStyle": {"type": "dotted"}, "areaStyle": {"opacity": 0.1}},
    ],
    "grid": {"left": 80, "right": 30, "top": 80, "bottom": 50},
}
```

Every series' `data` must be the same length as `xAxis.data`; pad the gaps with
`None` (→ `null`), as the forecast series does above. A short array does not
align to the right-hand end of the axis — it silently plots against the wrong
years.

```python
import json
from pathlib import Path

VENDOR = Path('/opt/talos/vendor')
ECHARTS = (VENDOR / 'echarts.min.js').read_text(encoding='utf-8')
THEME_NAME = 'macarons'                     # ls VENDOR/'echarts-themes' for the set
THEME = (VENDOR / 'echarts-themes' / f'{THEME_NAME}.js').read_text(encoding='utf-8')

_CARTESIAN = {"line", "bar", "scatter", "effectScatter", "candlestick", "boxplot"}

def check_option(cid: str, opt: dict) -> None:
    """Fail loudly in Python rather than silently in the browser."""
    for wrong, right in (("xaxis", "xAxis"), ("yaxis", "yAxis")):
        if wrong in opt:
            raise ValueError(f"{cid}: {wrong!r} must be {right!r} (ECharts is camelCase)")
    series = opt.get("series") or []
    if any(s.get("type") in _CARTESIAN for s in series):
        missing = [k for k in ("xAxis", "yAxis") if k not in opt]
        if missing:
            raise ValueError(f"{cid}: cartesian series needs {missing}")
    cats = (opt.get("xAxis") or {}).get("data")
    if cats:
        for s in series:
            if s.get("data") is not None and len(s["data"]) != len(cats):
                raise ValueError(
                    f"{cid}: series {s.get('name')!r} has {len(s['data'])} points "
                    f"but xAxis has {len(cats)} categories — pad with None"
                )

def page(title: str, charts: list[dict], kpis: list[dict]) -> str:
    """charts: [{'id': 'revenue', 'title': 'Umsatz', 'option': {...}}, ...]"""
    for c in charts:
        check_option(c["id"], c["option"])
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
    # Each init is isolated: an exception in one setOption must not stop the
    # ones after it, and the failure has to be visible in the page instead of
    # showing up as a blank box.
    inits = "\n".join(
        f'try {{ echarts.init(document.getElementById({c["id"]!r}), theme)'
        f'.setOption({json.dumps(c["option"], ensure_ascii=False, default=str)}); }}'
        f'catch (e) {{ console.error({c["id"]!r}, e);'
        f' document.getElementById({c["id"]!r}).innerHTML ='
        f' \'<p class="chart-error">Chart {c["id"]} failed: \' + e.message + \'</p>\'; }}'
        for c in charts
    )
    return f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{CSS}</style>
<script>{ECHARTS}</script>
<script>{THEME}</script>
</head><body>
<header><h1>{title}</h1></header>
<div class="kpis">{tiles}</div>
{blocks}
<script>
// Fail loudly if the library didn't survive being inlined. A blank dashboard
// with a clean console is the hardest version of this to debug.
if (typeof echarts !== 'object' || typeof echarts.init !== 'function') {{
  document.body.insertAdjacentHTML('afterbegin',
    '<p style="background:#fee;color:#900;padding:1rem">ECharts did not load: '
    + 'window.echarts is ' + typeof echarts + '. The library must be inlined '
    + 'verbatim, with nothing assigned to it.</p>');
}}
// 'dark' is built into ECharts (dark background, default palette); THEME_NAME
// is the one inlined above. Inline a dark theme file too if you want a dark
// palette rather than just a dark canvas.
const theme = matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark' : {THEME_NAME!r};
{inits}
addEventListener('resize', () => echarts.getInstanceByDom
  && document.querySelectorAll('.chart').forEach(el => echarts.getInstanceByDom(el)?.resize()));
</script>
</body></html>"""

Path('output/dashboard.html').write_text(page(...), encoding='utf-8')
```

## Look it up instead of guessing

You do not have the option reference memorized, and ECharts has hundreds of
keys. Two ways to check, both cheap:

**Offline, from inside the sandbox** — the TypeScript declarations are vendored,
so the authoritative list of keys is a grep away:

```bash
grep -n 'xAxis?:' /opt/talos/vendor/echarts.d.ts          # confirm a key exists
grep -n 'interface SunburstSeriesOption' -A 40 /opt/talos/vendor/echarts.d.ts
grep -c '"xaxis"' output/dashboard.html                    # must be 0
```

A case-sensitive grep is decisive here: the declarations contain `xAxis` 30
times and lowercase `xaxis` zero times. If your key isn't in that file, it isn't
a real option and ECharts will ignore it.

**Online, from the agent side** — the *sandbox* has no network, but `web_fetch`
runs outside it and does. Use it when you want a chart type you haven't built
before, or when the default styling isn't good enough:

- <https://echarts.apache.org/examples/en/index.html> — the example gallery.
  Every example is a complete option object; find one close to what you want and
  adapt it rather than inventing a config.
- <https://echarts.apache.org/en/option.html> — the full option reference.
- <https://echarts.apache.org/handbook/en/basics/release-note/v6-feature/> —
  what 6.x added (chord diagrams, the matrix coordinate system, scatter
  jittering, `dataMin`/`dataMax` axis extents).

Fetching one gallery example before building an unfamiliar chart is almost
always faster than three rounds of guessing at option keys.

## Don't ship the default look

The stock palette on a stock white card is what makes a generated dashboard look
generated. It costs very little to do better:

- **Use a theme.** Inline one of `/opt/talos/vendor/echarts-themes/*.js` after
  the library, then `echarts.init(el, 'macarons')`. `macarons`, `shine`, `roma`,
  `infographic`, `vintage` and `tech-blue` all read as deliberate; `dark`,
  `dark-bold` or `dark-blue` handle a dark UI. (`v5` restores the pre-6.0 look
  if you specifically want it.) `ls /opt/talos/vendor/echarts-themes/` for the
  full set — the theme file registers itself, so inlining it is enough.
- **One accent, not eight.** Give the series the user cares about the strong
  colour and mute the rest to greys. A twelve-colour rainbow says "I did not
  decide what matters".
- **`smooth: true`** on trend lines, and an `areaStyle` with a gradient
  (`echarts.graphic.LinearGradient`) under the primary series only.
- **Kill the chart junk.** `yAxis.splitLine` light grey, `xAxis.axisLine` off,
  no gridlines on the category axis. Let the data be the darkest thing.
- **Label the ends, not every point.** `endLabel` on a line beats a legend the
  eye has to bounce to.

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
- **`xaxis` / `yaxis` instead of `xAxis` / `yAxis`.** The single most likely way
  to ship a dashboard of empty boxes — and because the throw aborts the script,
  one lowercase key blanks every chart on the page, not just its own. See
  `check_option` above.
- **Assigning the library to something.** `<script>echarts={...the file...}</script>`
  looks harmless and destroys it. `echarts.min.js` is a UMD bundle that starts
  with `!function(...)` and registers `window.echarts` itself; putting
  `echarts=` in front assigns the IIFE's return value — `!undefined`, i.e.
  `true` — over the object it just created. Every later `echarts.init(...)`
  then dies on "not a function" and the first failure takes all the remaining
  charts with it. **Inline the file verbatim**: no assignment, no `var`, no
  wrapper, nothing before it inside the tag.
- **A theme name that was never registered.** `echarts.init(el, 'macarons')`
  when `macarons.js` wasn't inlined does *not* error — it silently falls back to
  the default palette. If your dashboard still looks stock after you picked a
  theme, that's why: check the theme file actually made it into the page
  (`grep -c registerTheme output/dashboard.html`).
- **Charts with zero height.** ECharts needs the container to have an explicit
  height before `init` — set one in CSS (`.chart { height: 320px }`).
- **Series shorter than the axis.** Five values on a twelve-year axis plots the
  first five years, not the last five. Pad with `None`.
- **Repeated values across every period.** If your "per year" numbers come out
  identical, the query is aggregating the same rows each time — a join or filter
  is wrong. Sanity-check the frame before charting it; a dashboard makes wrong
  numbers look authoritative.

## Verify before you finish

Checking the file exists is not verification — the failure modes above all
produce a perfectly plausible file. Run these three:

```bash
grep -c 'src="http' output/dashboard.html    # must be 0 — no CDN
ls -l output/dashboard.html                  # ~1.2 MB; 50 KB means ECharts is not inlined
grep -o '"[xy]axis"' output/dashboard.html   # must print nothing
grep -c registerTheme output/dashboard.html  # 1 if you inlined a theme
grep -o '<script>[a-zA-Z_$]*=' output/dashboard.html   # must print nothing —
                                             # nothing may be assigned the library
```

Then open the page in the preview panel and look at it. Every chart box should
contain a drawn chart; an empty box means `setOption` threw, and the browser
console says which one.
