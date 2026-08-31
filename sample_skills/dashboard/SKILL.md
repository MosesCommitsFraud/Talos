---
name: dashboard
description: "Use this skill whenever the user asks for a dashboard, an interactive report, a KPI overview, an analysis 'als Dashboard', or any HTML page with charts they will click around in — including follow-ups like 'make that a dashboard', 'add a chart for X', or 'build me an overview of these numbers'. Also use it when you are about to hand-write an HTML file containing charts for any reason. Do NOT trigger for a single static chart image (use python + seaborn/matplotlib + show_image), for an Excel deliverable (that is the spreadsheet path), or for a written report with no charts."
license: MIT
---

# Dashboards (Talos)

A dashboard here is **one self-contained `.html` file** in the workspace. Talos
renders it live in the preview panel and behind an "open in new tab" button, so
the user sees the working page, not the source.

**Do not hand-write the page.** The shell, CSS, grid, KPI tiles, the inlined
chart runtime, dark mode, per-chart error isolation and resize handling are
vendored in `/opt/talos/vendor/talos_dash.py` and are identical for every
dashboard. Writing them out again costs a few hundred lines of output for zero
information. Your job is the part that actually varies: **which charts, and what
data.**

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

That is the entire page. `dashboard()` validates every spec, writes the file and
returns the path. `span=2` makes a card full width; the grid collapses to one
column on narrow screens.

### Arguments: one series or several

Single-series builders (`bar`, `hbar`, `area`, `pie`, `funnel`, `histogram`)
take a **flat sequence of numbers**. Multi-series builders (`line`,
`grouped_bar`, `stacked_bar`, `radar`) take a **mapping** `{"Name": [numbers]}`.

```python
td.bar(gf_names, gf_marge)                       # right
td.bar(gf_names, {"DB1-Marge": gf_marge})        # also fine - one key, unwrapped
td.bar(gf_names, {"DB1": a, "Netto": b})         # TypeError -> use grouped_bar
```

Passing a dict where a flat list belongs used to iterate its **keys**, so the
column names became the values and the chart drew nothing at all. That now
raises, as does any string reaching a numeric series. If you see that error, you
are one call away from `grouped_bar` / `stacked_bar`.

## What a builder returns

A **spec**: a plain dict of data plus a fixed set of options, which the runtime
in the page turns into marks, scales and guides. It is not a chart library
option object, and it is not an escape hatch — `check_spec` rejects any key it
does not know, because an option that silently does nothing is a chart that
looks configured and is not.

What you can change in place, on any spec:

```python
opt = td.line(months, {"Ist": ist})
opt["y"]["label"] = "Mio. EUR"        # axis title
opt["y"]["format"] = td.fmt(unit="EUR", decimals=1)   # axis + labels + tooltip
opt["y"]["min"] = 0                   # pin the baseline (see below)
opt["x"]["rotate"] = -35              # rotate crowded category labels
opt["legend"] = False                 # suppress the legend
charts.append(td.chart("rev", "Umsatz", opt))
```

`td.fmt(unit=…, decimals=…, compact=…, percent=…)` is one format for the axis,
the data labels and the tooltip at once, so a "412.000 EUR" label never sits
over a "400000" gridline. `compact=True` is locale-dependent abbreviation, not a
thousands suffix: German has no short form below a million.

**`y["min"] = 0` is the one you will want most.** Bar charts already include
zero. Line charts do not, and a trend line whose axis starts at the smallest
observed value turns a 4 % drift into a cliff.

## Colour is already decided

Do not set colours — no spec takes one. The scaffold ships the validated
categorical palette: eight fixed hues in a fixed order, stepped separately for
light and dark surfaces, checked against colourblind-separation, normal-vision,
lightness and contrast gates. Colours reach the page as CSS variables, so the
same file is correct on a white card and a dark one and repaints instantly when
the theme is toggled.

What that buys you, and what you must not undo:

- **Magnitude is one hue, light to dark** (`heatmap` already does this). A
  rainbow ramp invents category boundaries the data does not have.
- **One accent, the rest muted.** `bar(..., highlight="Nord")` accents one
  category and greys the others — far stronger than eight competing hues.
- **Status colours are reserved.** Green and red mean good and bad (the
  waterfall uses them for rises and falls), never "series 3".
- Legends appear automatically for two or more series and are suppressed for
  one (the card title already names it).

`td.ACCENT`, `td.MUTED`, `td.POSITIVE`, `td.NEGATIVE`, `td.SURFACE` and
`td.PALETTE` still exist as the token names the runtime resolves, but no builder
accepts them as an argument any more. There is no page-level `theme=`.

## Pick the chart that fits the question

The builders below cost the same to write, so **a dashboard of three bar charts
is a sign the alternatives felt expensive, not that bars were right.** Read the
data first, then choose.

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

Three take input shapes worth checking before you call them:

- `boxplot(categories, groups)` wants the **raw observations** per category, not
  quartiles. The box, the Tukey fences and the outliers are computed in the
  page, so the drawing and your frame cannot drift apart.
- `treemap(nodes)` wants **one row per leaf** with a full slash-separated path:
  `{"path": "Konzern/Nord/Handel", "name": "Handel", "value": 42}`. Parents are
  imputed and summed from their children — adding a parent row double-counts it.
- `sankey(nodes, links)` validates that every link endpoint is a declared node.

## Beyond the catalog

There is no raw-options escape hatch: the spec vocabulary above is the whole
surface. A chart type that is not in the table has to be added to the runtime
(`sandbox/vendor/charts/entry.mjs` in the Talos repo, bundled into the image) —
that is a code change, not something to improvise inside a dashboard turn.

Before concluding a question needs one, check the catalog again for a
composition that answers it: a "bullet chart" is a `bar` with `highlight`, a
"lollipop" is an `hbar`, a "100 % stacked" is `stacked_bar(percent=True)`, and a
"progress ring" is a `gauge`.

The chart library's own documentation is vendored offline at
`/opt/talos/vendor/tanstack-charts-docs/` (its `skills/` subdirectory included).
Grep it when you need to know what a mark or scale can actually do — it is the
reference for extending the runtime, not something a dashboard script imports.

## Requirements for every dashboard

- **One file**, at a workspace-relative path (`output/dashboard.html`). Never
  `/tmp`, never absolute.
- **Data inlined.** The page must not read a sibling `.csv` at runtime — the
  preview iframe cannot fetch it, and `dashboard()` embeds whatever you pass.
- **Says what it is**: title, the period covered, and a visible note whenever
  figures are projected rather than measured. A forecast that looks like a
  measurement is the one failure the user cannot detect themselves — put it in
  `footer=` or the chart card's `note=`.
- **Readable without hovering.** Units on the axis (`y["format"]`), a legend
  when there is more than one series. Tooltips add detail; they don't carry it.
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
  `dashboard()` inlines the runtime for you — don't add a tag.
- **`json.dumps` on a DataFrame or Timestamp** raises. Convert first
  (`df.to_dict("records")`, `.strftime("%Y-%m-%d")`); the scaffold passes
  `default=str` but a DataFrame still won't serialise usefully.
- **Series shorter than the axis.** Five values on a twelve-quarter axis plot
  against the *first* five quarters, not the last five. Pad with `None` —
  `check_spec` raises on a length mismatch, so this fails in Python instead of
  silently lying in the browser.
- **Duplicate category labels.** A categorical axis de-duplicates, so two rows
  named "Sonstige" become one bar. Aggregate them yourself, or make the labels
  distinct before charting.
- **Repeated values across every period.** If your per-year numbers come out
  identical, a join or filter is wrong. Sanity-check the frame before charting:
  a dashboard makes wrong numbers look authoritative.

## Verify before you finish

Checking that the file exists is not verification.

```bash
ls -l output/dashboard.html                  # ~250 KB; 20 KB means the runtime is not inlined
grep -c 'src="http' output/dashboard.html    # must be 0
grep -c 'chart-error' output/dashboard.html  # 1 (the CSS rule) - more is impossible in the
                                             # source, so also open the page and look
```

A card that failed at mount time shows "Chart … failed: …" in place of the
chart, and names the spec that threw — that text is written by the browser, not
by the file, so the page has to be opened to see it. Open it in the preview
panel and look: every card should contain a drawn chart.
