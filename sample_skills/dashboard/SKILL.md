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

## Choosing: start from the question, not from the data

**The single most common failure of a generated dashboard is four bar charts.**
Every builder below costs one line, so a page of bars means the question was
never asked, not that bars were the answer. Read the numbers, decide what the
reader needs to *compare*, then pick from this table.

| The question the reader actually has | Builder |
| --- | --- |
| How did it develop? | `line` |
| …one series, and the level matters | `area` |
| …and how did the mix inside it shift? | `stacked_area` |
| …how uncertain is the forecast? | `range_area` |
| …which days were busy? | `calendar` |
| …when does each phase run? | `timeline` |
| Which category is biggest? (few, short labels) | `bar` |
| …many categories, or long labels | `hbar` |
| …a lot of categories, bars too heavy | `lollipop` |
| …two measures per category, side by side | `grouped_bar` |
| …two values per category, and the GAP is the point | `dumbbell` |
| …who overtook whom between two dates? | `slope` |
| How does the total divide up? | `stacked_bar` |
| …one moment, ≤5 parts | `pie` / `donut` |
| …and the parts are countable things | `waffle` |
| …parts differ in size *and* share | `mosaic` |
| …nested parts | `treemap` |
| …where do people drop out? | `funnel` |
| **Why is this number different from last year?** | `waterfall` |
| Do these two measures move together? | `scatter` |
| Two categorical dimensions, one measure | `heatmap` |
| How spread out is it? | `boxplot` |
| …and what *shape* is the spread? | `violin` |
| …one variable, how is it distributed? | `histogram` |
| One ratio against a target | `gauge` |
| Several metrics across a few entities | `radar` |
| What flows from where to where? | `sankey` |
| A single headline number | `kpi` — a tile, not a chart |

Underused and usually right: **`waterfall`** for any "why did this change"
question, **`heatmap`** to turn a table nobody reads into a visible pattern,
**`dumbbell`** for Ist-vs-Plan per Region, and **`range_area`** for anything
projected.

## The catalog

Every entry is complete — paste it, swap the data. Arguments not shown are in
`help(td.<name>)`.

### Over time

**`line`** — the default for an ordered axis. Two or three series maximum;
past that, facet the question instead.
```python
td.line(quarters, {"Ist": ist, "Plan": plan}, y_name="Mio. EUR")
td.line(days, {"Tickets": counts}, rolling=7)   # noisy daily data
```
`rolling=7` draws a 7-point moving average over a faded raw line. Use it
whenever day-level data zigzags: the smoothed line carries the trend and the
faded one still shows how noisy the underlying series was.
*Not for* unordered categories — that draws a trend that does not exist.

**`area`** — one series where the level, not just the direction, is the
subject (Bestand, Kapazität, Auslastung).
```python
td.area(months, "Auftragsbestand", values, y_name="Stück")
```
*Not for* several series: overlapping fills hide each other. Use `line`.

**`stacked_area`** — composition over a continuous axis.
```python
td.stacked_area(months, {"Core": core, "Services": svc, "Sonstige": rest})
td.stacked_area(months, mix, percent=True)      # share of total, 0-100 %
td.stacked_area(months, mix, stream=True)       # streamgraph
```
`stream=True` drops the shared baseline so every band stays readable — only do
that when no single band's level has to be read off the axis.
*Not for* few periods: with six quarters `stacked_bar` reads better.

**`range_area`** — a band between two bounds. **This is the honest way to draw
a projection**; a single line into the future claims a precision the model does
not have.
```python
td.range_area(months, low=worst, high=best, line=expected, y_name="Mio. EUR")
```

**`calendar`** — daily activity over weeks or a year, laid out weekday × week,
so weekly rhythm and quiet periods appear as stripes.
```python
td.calendar(dates, counts, unit="Tickets")      # dates are "YYYY-MM-DD"
```

**`timeline`** — phases, projects or bookings on a real date axis (a Gantt
without dependency arrows). Gaps between phases are real gaps.
```python
td.timeline([
    {"label": "Analyse",   "start": "2026-01-06", "end": "2026-02-20", "group": "Phase 1"},
    {"label": "Umsetzung", "start": "2026-02-10", "end": "2026-06-30", "group": "Phase 2"},
])
```

### Comparing categories

**`bar`** — few categories, short labels, and one of them is the point.
```python
td.bar(regions, umsatz, sort=True, highlight="Nord", y_name="Mio. EUR")
```
`highlight=` accents one category and greys the rest — far stronger than eight
competing hues.

**`hbar`** — many categories or long labels. Horizontal, largest at the top.
```python
td.hbar(kundennamen, umsatz, top=10, value_format=td.fmt(unit="EUR"))
```

**`lollipop`** — the same ranking with a fraction of the ink. Past ~15 rows,
bars turn the card into a solid block; a stem and a dot do not.
```python
td.lollipop(artikelnummern, absatz, top=25)
```

**`grouped_bar`** — the same measure for several groups, read side by side.
```python
td.grouped_bar(regions, {"2025": last, "2026": this}, sort=True)
```
*Not for* more than three groups per category — use `heatmap` or small charts.

**`dumbbell`** — two values per category where **the gap is the finding**:
Ist vs. Plan, vorher vs. nachher. Sorted by the size of the gap.
```python
td.dumbbell(regions, {"Plan": plan, "Ist": ist})
```
*Prefer this over* `grouped_bar` whenever the reader's question is "where is the
deviation largest" rather than "how big is each".

**`slope`** — level *and* rank change between exactly two moments. Crossing
lines answer "who overtook whom", which two bar charts make the reader work out.
```python
td.slope(produkte, marge_2025, marge_2026, before_name="2025", after_name="2026")
```

### Composition

**`stacked_bar`** — how a total divides, per period.
```python
td.stacked_bar(quarters, {"Core": core, "Services": svc}, percent=True)
```
`percent=True` normalises every column to 100 % and pins the axis to 0-100.

**`pie` / `donut`** — one moment, at most five slices, no negatives.
```python
td.donut(["Core", "Services", "Lizenzen", "Sonstige"], anteile)
```
*Not for* a ranking (`hbar`) or anything over ~5 parts — the builder raises past
six. Fold the tail into "Sonstige".

**`waffle`** — part-to-whole in countable squares. Better than a pie whenever
the quantity is a count of *things* (Mitarbeiter, Störungen, Aufträge): the
reader sees "roughly one in five" without estimating an angle.
```python
td.waffle(["Vollzeit", "Teilzeit", "Aushilfe"], [62, 25, 13], unit=1)
```

**`mosaic`** (Marimekko) — column *width* is the segment's size, segment
*height* is its share. One rectangle's area is its absolute contribution, which
is exactly what a 100 %-stacked bar throws away.
```python
td.mosaic([("Handel", "Neu", 40), ("Handel", "Bestand", 60),
           ("Service", "Neu", 15), ("Service", "Bestand", 25)],
          y_order=["Neu", "Bestand"])
```
*Reach for it when* "a big share of a small segment" must not look like "big".

**`treemap`** — nested parts. One row per **leaf**, full slash path; parents are
imputed and summed, so passing a parent row too double-counts it.
```python
td.treemap([{"path": "Konzern/Nord/Handel", "name": "Handel", "value": 42},
            {"path": "Konzern/Süd/Handel",  "name": "Handel", "value": 31}])
```

**`funnel`** — remaining volume at each ordered stage, with the share of the
first stage on every bar.
```python
td.funnel(["Leads", "Qualifiziert", "Angebot", "Abschluss"], [1200, 640, 310, 128])
```

**`waterfall`** — signed contributions bridging a start to a total. Rises are
green, falls are red, the endpoints are the accent.
```python
td.waterfall(["Preis", "Menge", "Neukunden"], [18, -12, 23],
             start=120, total_label="2026")
```

### Relationships

**`scatter`** — do two measures move together? `sizes=` adds a third measure
(bubble chart), `trend=True` overlays a least-squares fit with a 95 % band.
```python
td.scatter(list(zip(rabatt, menge)), x_name="Rabatt %", y_name="Menge",
           sizes=umsatz, trend=True)
```
When you switch `trend` on, say so in the card `note=`: a fit line is a claim,
not a measurement.

**`heatmap`** — two categorical dimensions against one measure. A 2-D list
indexed `[y][x]`, or `(xi, yi, value)` triples.
```python
td.heatmap(wochentage, regionen, matrix, unit="Aufträge")
```
One hue, light to dark. **Reach for this instead of a wide table** — Wochentag ×
Region, Monat × Produkt, Standort × Fehlerart.

### Distribution

**`boxplot`** — spread and outliers per category, from **raw observations**.
Quartiles, Tukey fences and outliers are computed in the page, so the drawing
and your frame cannot drift apart.
```python
td.boxplot(regionen, [durchlaufzeiten_nord, durchlaufzeiten_sued])
```
*Never* summarise a distribution to a mean and hide the shape.

**`violin`** — same input, but shows the *form*: bimodality, a long tail, a
pile-up at zero. Use it when the shape is the finding; `boxplot` is the safer
default.
```python
td.violin(maschinen, [messwerte_a, messwerte_b, messwerte_c])
```

**`histogram`** — the shape of one variable.
```python
td.histogram(antwortzeiten, bins=20, x_name="ms")
```

### Targets, profiles, flows

**`gauge`** — one ratio against a target, when the distance to the target is
the point. A `kpi` tile is usually better.
```python
td.gauge(72, name="Zielerreichung", target=100)
```

**`radar`** — a few entities across several metrics. Each axis is normalised by
its own maximum, so raw units never share a radius.
```python
td.radar(["Umsatz", "Marge", "Wachstum", "Qualität"], {"Nord": a, "Süd": b})
```
*Not for* more than ~3 entities or ~8 metrics.

**`sankey`** — flow between stages. Every link endpoint must be a declared node.
```python
td.sankey([{"id": "lead", "label": "Leads"}, {"id": "won", "label": "Gewonnen"}],
          [("lead", "won", 310)])
```

**`kpi`** — a headline number as a tile. `tone` only colours the delta, and
direction is not goodness, so set it deliberately.
```python
td.kpi("Nettoumsatz", "45,2 Mio. EUR", "+3,1 % ggü. Vj.", "up")
```

## Tuning a spec

A builder returns a **spec**: a plain dict of data plus a fixed set of options,
which the runtime turns into marks, scales and guides. It is not a chart-library
option object and not an escape hatch — `check_spec` rejects any key it does not
know, because an option that silently does nothing is a chart that looks
configured and is not.

```python
opt = td.line(months, {"Ist": ist})
opt["y"]["label"] = "Mio. EUR"
opt["y"]["format"] = td.fmt(unit="EUR", decimals=1)   # axis + labels + tooltip
opt["y"]["min"] = 0                   # pin the baseline
opt["x"]["rotate"] = -35              # rotate crowded category labels
opt["legend"] = False
charts.append(td.chart("rev", "Umsatz", opt, span=2, note="Ohne Konzernumlage."))
```

`td.fmt(unit=…, decimals=…, compact=…, percent=…)` is one format for the axis,
the data labels and the tooltip at once, so a "412.000 EUR" label never sits
over a "400000" gridline. `compact=True` is locale-dependent abbreviation, not a
thousands suffix: German has no short form below a million.

**`y["min"] = 0` is the one you will want most.** Bar charts already include
zero. Line charts do not, and a trend line whose axis starts at the smallest
observed value turns a 4 % drift into a cliff.

### Arguments: one series or several

Single-series builders (`bar`, `hbar`, `lollipop`, `area`, `pie`, `waffle`,
`funnel`, `histogram`) take a **flat sequence of numbers**. Multi-series
builders (`line`, `grouped_bar`, `stacked_bar`, `stacked_area`, `dumbbell`,
`radar`) take a **mapping** `{"Name": [numbers]}`.

```python
td.bar(gf_names, gf_marge)                       # right
td.bar(gf_names, {"DB1-Marge": gf_marge})        # also fine - one key, unwrapped
td.bar(gf_names, {"DB1": a, "Netto": b})         # TypeError -> use grouped_bar
```

Passing a dict where a flat list belongs used to iterate its **keys**, so the
column names became the values and the chart drew nothing at all. That now
raises, as does any string reaching a numeric series.

## Colour is already decided

Do not set colours — no spec takes one. The scaffold ships the validated
categorical palette: eight fixed hues in a fixed order, stepped separately for
light and dark surfaces, checked against colourblind-separation, normal-vision,
lightness and contrast gates. Colours reach the page as CSS variables, so the
same file is correct on a white card and a dark one and repaints instantly when
the theme is toggled.

What that buys you, and what you must not undo:

- **Magnitude is one hue, light to dark** (`heatmap` and `calendar` already do
  this). A rainbow ramp invents category boundaries the data does not have.
- **One accent, the rest muted** — `bar(highlight=…)`.
- **Status colours are reserved.** Green and red mean good and bad (the
  waterfall uses them for rises and falls), never "series 3".
- Legends appear automatically for two or more series and are suppressed for
  one, since the card title already names it.

`td.ACCENT`, `td.MUTED`, `td.POSITIVE`, `td.NEGATIVE`, `td.SURFACE` and
`td.PALETTE` still exist as the token names the runtime resolves, but no builder
accepts them as an argument. There is no page-level `theme=`.

## Beyond the catalog

There is no raw-options escape hatch: the 28 types above are the whole surface.
A chart type that is not here has to be added to the runtime
(`sandbox/vendor/charts/entry.mjs` in the Talos repo, bundled into the image at
build time) — a code change, not something to improvise inside a dashboard turn.

Before concluding you need one, check the catalog again for a composition that
answers the question: a "bullet chart" is a `bar` with `highlight`, a "100 %
stacked" is `stacked_bar(percent=True)`, a "progress ring" is a `gauge`, a
"bubble chart" is `scatter(sizes=…)`, and a "Gantt" is a `timeline`.

The chart library's own documentation is vendored offline at
`/opt/talos/vendor/tanstack-charts-docs/` (its `skills/` subdirectory included).
Grep it when you need to know what a mark or scale can do — it is the reference
for extending the runtime, not something a dashboard script imports.

## Requirements for every dashboard

- **One file**, at a workspace-relative path (`output/dashboard.html`). Never
  `/tmp`, never absolute.
- **Data inlined.** The page must not read a sibling `.csv` at runtime — the
  preview iframe cannot fetch it, and `dashboard()` embeds whatever you pass.
- **Says what it is**: title, the period covered, and a visible note whenever
  figures are projected rather than measured. A forecast that looks like a
  measurement is the one failure the user cannot detect themselves — put it in
  `footer=` or the card's `note=`, and prefer `range_area` over a bare line.
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
  gives a permanently blank page. `dashboard()` inlines the runtime for you.
- **`json.dumps` on a DataFrame or Timestamp** raises. Convert first
  (`df.to_dict("records")`, `.strftime("%Y-%m-%d")`).
- **Series shorter than the axis.** Five values on a twelve-quarter axis plot
  against the *first* five quarters, not the last five. Pad with `None` —
  `check_spec` raises on a length mismatch, so this fails in Python instead of
  silently lying in the browser.
- **Duplicate category labels.** A categorical axis de-duplicates, so two rows
  named "Sonstige" become one bar. Aggregate them or make the labels distinct.
- **Repeated values across every period.** If your per-year numbers come out
  identical, a join or filter is wrong. Sanity-check the frame before charting:
  a dashboard makes wrong numbers look authoritative.

## Verify before you finish

Checking that the file exists is not verification.

```bash
ls -l output/dashboard.html                  # ~250 KB; 20 KB means the runtime is not inlined
grep -c 'src="http' output/dashboard.html    # must be 0
```

A card that failed at mount time shows "Chart … failed: …" in place of the
chart and names the spec that threw — that text is written by the browser, not
by the file, so the page has to be opened to see it. Open it in the preview
panel and look: every card should contain a drawn chart.
