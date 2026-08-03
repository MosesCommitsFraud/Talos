---
name: dashboard
description: "Use this skill whenever the user asks for a dashboard, an interactive report, a KPI overview, an analysis 'als Dashboard', or any HTML page with charts they will click around in — including follow-ups like 'make that a dashboard', 'add a chart for X', or 'build me an overview of these numbers'. Also use it when you are about to hand-write an HTML file containing charts for any reason. Do NOT trigger for a single static chart image (use python + seaborn/matplotlib + show_image), for an Excel deliverable (that is the spreadsheet path), or for a written report with no charts."
license: MIT
---

# Dashboards (Talos)

A dashboard here is **one self-contained `.html` file** in the workspace. Talos
renders it live in the preview panel and behind an "open in new tab" button, so
the user sees the working page, not the source.

**Do not hand-write the page.** The shell, CSS, grid, KPI tiles, ECharts
inlining, dark mode, per-chart error isolation and resize handling are vendored
in `/opt/talos/vendor/talos_dash.py` and are identical for every dashboard.
Writing them out again costs a few hundred lines of output for zero information.
Your job is the part that actually varies: **which charts, and what data.**

## The whole build

```python
import sys; sys.path.insert(0, "/opt/talos/vendor")
import talos_dash as td

td.dashboard(
    "output/dashboard.html",
    title="Umsatz 2023-2025",
    subtitle="Quartalszahlen - Stand 03/2026",
    kpis=[
        td.kpi("Nettoumsatz", "45,2 Mio. EUR", "+3,1 % ggue. Vj.", "up"),
        td.kpi("Marge", "18,4 %", "-0,6 pp", "down"),
    ],
    charts=[
        td.chart("trend", "Entwicklung", td.line(quarters, {"Ist": ist, "Plan": plan}), span=2),
        td.chart("mix",   "Umsatzmix",   td.stacked_bar(quarters, mix, percent=True)),
        td.chart("top",   "Top-Kunden",  td.hbar(names, values, top=10)),
    ],
    footer="Prognosewerte ab Q2/2026 sind modelliert, nicht gemessen.",
)
```

**Import the module, not names from it** (`import talos_dash as td`). A
`from talos_dash import a, b, c` line means every builder you reach for later
and forgot to list is a `NameError` and a wasted round trip.

That is the entire page. `dashboard()` validates every option, writes the file
and returns the path. `span=2` makes a card full width; the grid collapses to
one column on narrow screens.

### Arguments: one series or several

Single-series builders (`bar`, `hbar`, `area`, `pie`, `histogram`) take a **flat
sequence of numbers**. Multi-series builders (`line`, `grouped_bar`,
`stacked_bar`, `radar`) take a **mapping** `{"Name": [numbers]}`.

```python
td.bar(gf_names, gf_marge)                       # right
td.bar(gf_names, {"DB1-Marge": gf_marge})        # also fine - one key, unwrapped
td.bar(gf_names, {"DB1": a, "Netto": b})         # TypeError -> use grouped_bar
```

Passing a dict where a flat list belongs used to iterate its **keys**, so the
column names became the values and the chart drew nothing at all. That now
raises, as does any string reaching a numeric series. If you see that error, you
are one call away from `grouped_bar` / `stacked_bar`.

## Colour is already decided

Do not set colours. The scaffold ships the validated categorical palette - eight
fixed hues in a fixed order, stepped separately for light and dark surfaces, and
checked against colourblind-separation, normal-vision, lightness and contrast
gates. Charts emit colour *tokens* that resolve in the browser against the mode
the viewer is actually in, so the same file is correct on a white card and a
dark one, and repaints when the theme is toggled.

What that buys you, and what you must not undo:

- **Never hardcode a hex** in an option. `"#2f6df6"` is wrong in dark mode by
  construction. Use `td.ACCENT`, `td.MUTED`, `td.POSITIVE`, `td.NEGATIVE`,
  `td.SURFACE` if you need a specific role.
- **Magnitude is one hue, light to dark** (`heatmap` already does this). A
  rainbow ramp invents category boundaries the data does not have.
- **One accent, the rest muted.** `bar(..., highlight="Nord")` accents one
  category and greys the others - far stronger than eight competing hues.
- **Status colours are reserved.** `POSITIVE`/`NEGATIVE` mean good/bad, never
  "series 3".
- Legends appear automatically for two or more series and are suppressed for
  one (the card title already names it).

## Pick the chart that fits the question

The builders below all return plain ECharts option dicts, pre-themed and
consistent with each other. They exist so that a heatmap, a sankey or a
waterfall costs you exactly as much to write as a bar chart — **a dashboard of
three bar charts is a sign the alternatives were expensive, not that bars were
right.** Read the data first, then choose.

| The question the user is really asking | Builder |
| --- | --- |
| How did this change over time? | `line(categories, {"name": values})` |
| One series over time, emphasised | `area(categories, name, values)` |
| Which category is biggest? (few, short labels) | `bar(categories, values, sort=True, highlight=…)` |
| Which category is biggest? (many or long labels) | `hbar(categories, values, top=10)` |
| Same measure, several groups, side by side | `grouped_bar(categories, {"g": values})` |
| How is the composition shifting? | `stacked_bar(categories, series, percent=True)` |
| **What drove the change from A to B?** | `waterfall(labels, deltas, start=…)` |
| Do these two measures move together? | `scatter(points, sizes=…, labels=…)` |
| Two categorical dimensions, one measure | `heatmap(x_labels, y_labels, values)` |
| Composition right now, ≤5 parts | `pie(labels, values)` / `donut(…)` |
| Several metrics across a few entities | `radar(indicators, {"entity": values})` |
| One ratio against a target | `gauge(value, target=…)` |
| Where do people drop out? | `funnel(stages, values)` |
| How spread out is it? | `boxplot(categories, groups)` / `histogram(values)` |
| Hierarchy of parts | `treemap(nodes)` |
| What flows from where to where? | `sankey(nodes, links)` |
| A single headline number | `kpi(...)` — a tile, not a chart |

Two that get underused and shouldn't: **`waterfall`** is almost always the right
answer to "why is this number different from last year", and **`heatmap`** turns
a table nobody reads into a pattern you can see at a glance.

`python -c "import sys; sys.path.insert(0,'/opt/talos/vendor'); import talos_dash; help(talos_dash.waterfall)"`
for any signature.

## Going beyond the catalog

Every builder returns a dict, so tune it in place:

```python
opt = td.line(months, {"Ist": ist})
opt["yAxis"]["axisLabel"] = {"formatter": "{value} €"}
opt["series"][0]["markLine"] = {"data": [{"type": "average", "name": "Ø"}]}
charts.append(td.chart("rev", "Umsatz", opt))
```

Or pass a hand-written ECharts option straight to `chart()` — the catalog is a
shortcut, not a fence.

For a chart type that isn't in the table, don't guess at option keys:

- Offline: `grep -n 'interface SunburstSeriesOption' -A 40 /opt/talos/vendor/echarts.d.ts`
- Online (the *agent* has network even though the sandbox doesn't): `web_fetch`
  <https://echarts.apache.org/examples/en/index.html> — every example is a
  complete option object. Fetching one is faster than three rounds of guessing.

## Requirements for every dashboard

- **One file**, at a workspace-relative path (`output/dashboard.html`). Never
  `/tmp`, never absolute.
- **Data inlined.** The page must not read a sibling `.csv` at runtime — the
  preview iframe cannot fetch it, and `dashboard()` embeds whatever you pass.
- **Says what it is**: title, the period covered, and a visible note whenever
  figures are projected rather than measured. A forecast that looks like a
  measurement is the one failure the user cannot detect themselves — put it in
  `footer=` or the chart's `note=`.
- **Readable without hovering.** Units on the axis, a legend when there is more
  than one series. Tooltips add detail; they don't carry it.
- **Also produce the data** when the user asked for both — `df.to_excel(...)`
  from the same frame the charts use, so the two cannot disagree. Compute once,
  render twice.

## Pitfalls

- **Regenerating the whole script to fix one chart.** The `python` tool keeps
  your last body in memory: call it again with `edits` to patch the broken
  lines. Rewriting the file is the slow path and is almost never necessary.
- **Reaching for a CDN.** The workspace has no network *and* the preview runs
  under a CSP that blocks every outbound request. `<script src="https://…">`
  gives a permanently blank page with nothing in the console the user can see.
  `dashboard()` inlines ECharts for you — don't add a tag.
- **`json.dumps` on a DataFrame or Timestamp** raises. Convert first
  (`df.to_dict("records")`, `.strftime("%Y-%m-%d")`); the scaffold passes
  `default=str` but a DataFrame still won't serialise usefully.
- **Series shorter than the axis.** Five values on a twelve-quarter axis plot
  against the *first* five quarters, not the last five. Pad with `None` —
  `check_option` raises on a length mismatch, so this fails in Python instead of
  silently lying in the browser.
- **`xaxis` instead of `xAxis`** if you hand-write an option. ECharts ignores
  unknown keys and then throws inside `setOption`; `check_option` catches the
  common cases before the page is written.
- **A theme name that doesn't exist.** `dashboard(theme=...)` raises with the
  available list — `talos_dash.themes()` prints all 36.
- **Repeated values across every period.** If your per-year numbers come out
  identical, a join or filter is wrong. Sanity-check the frame before charting:
  a dashboard makes wrong numbers look authoritative.

## Verify before you finish

Checking that the file exists is not verification.

```bash
ls -l output/dashboard.html                  # ~1.2 MB; 50 KB means ECharts is not inlined
grep -c 'src="http' output/dashboard.html    # must be 0
grep -c 'chart-error' output/dashboard.html  # 1 (the CSS rule) - more means a chart threw
grep -oE '"#[0-9a-f]{6}"' output/dashboard.html | sort -u | head
```

That last one lists the hex literals inside chart options: it should show only
the palette the scaffold embeds. Anything else is a hardcoded colour that will
be wrong in one of the two modes.

Then open the page in the preview panel and look at it. Every card should
contain a drawn chart; a card showing "Chart ... failed" names the one that threw.
