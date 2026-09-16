# macs look for BI dashboards

Dashboards read like a well-made BI report (Power BI, Tableau): a header,
filter context, key figures and a grid of visuals. What makes them macs is
**the palette, Encode Sans and the logo** — not PowerPoint slide elements.

`td.compose` applies the brand by default (`brand="macs"`): palette tokens for
light and dark, Encode Sans embedded offline, themed axes/legends/tooltips/labels,
and the logo via `{{brand:logo}}`. `brand=None` only for a deliberately unbranded page.

Every page must work in **three situations at once**: light mode, dark mode,
and a narrow Talos side panel (~420 px wide) as well as a wide screen.

## Colour: never write a hex value

Hard-coded colours are the main reason dashboards break in dark mode (dark
text on a dark tile, white chips on a dark page). There are no exceptions.

**In CSS** use the variables:

| Role | Variable |
| --- | --- |
| Page background | `--bg` (or `--brand-grey` for a canvas behind tiles) |
| Tile / card surface | `--td-surface` |
| Text / secondary text | `--fg` / `--muted` |
| Hairlines, borders | `--line` |
| macs blue (primary measure, active filter) | `--brand-blue` |
| Petrol (comparison measure) | `--brand-petrol` |
| Emphasised numbers, headings | `--brand-deep` |
| Soft highlight (selected row, active chip) | `--brand-tint` |
| Good / bad deltas | `--td-good` / `--td-critical` |

No `#fff`, `white`, `black`, `rgba(0,0,0,…)` backgrounds or text colours.
A shadow may use `rgba(16,24,40,.06)`; nothing else.

**In ECharts options** don't set axis, label, legend, split-line, tooltip or
pie-border colours at all — the theme does it per mode. Where a series needs a
specific colour, write a token string; it is resolved for the current theme:

| Token | Meaning |
| --- | --- |
| `"@s1"` … `"@s8"` | categorical series colours (s1 = macs blue, s2 = petrol, s3 = light blue, s4 = amber highlight) |
| `"@q1"` … `"@q5"` | sequential blue scale for magnitude (visualMap, heatmaps) |
| `"@ink"`, `"@ink2"`, `"@muted"` | text colours |
| `"@grid"`, `"@base"`, `"@surface"` | lines, axis base, tile colour |
| `"@good"`, `"@critical"`, `"@warning"` | status |
| `"@brand-blue"`, `"@brand-petrol"`, … | any page variable |

Colour discipline: the primary measure is `@s1` in every visual, the comparison
(prior year, plan) `@s2` or `@s3`, "other" `@muted`. One amber highlight (`@s4`)
at most. No per-bar rainbow, no purple, no neon.

## Numbers: always formatted

Raw values like `41781151.9` are unreadable. Use formatter strings, which
become German-locale functions:

- `"@eurCompact"` → `41,8 Mio. €` (axes, bar labels, KPIs in charts)
- `"@eur"` → `41.781.152 €` (tooltips, tables)
- `"@numCompact"`, `"@num"`, `"@pct"` (value already in percent → `12,3 %`)
- Templates: `"{b}: @eurCompact"` ({a} series, {b} name, {d} pie share in %)

Put them on `axisLabel.formatter`, `label.formatter` and
`tooltip.valueFormatter`. In HTML, format numbers in Python
(`f"{v/1e6:,.1f} Mio. €".replace(",", "X").replace(".", ",").replace("X", ".")`).

## Typography: readable, not decorative

- Encode Sans only (already set). Base text 14px, line-height 1.5.
- Weights: **400** body, **500** labels, **600** headings and key numbers.
  Never 100–350 (too thin) or 700–900 (too heavy).
- Minimum size 12px for anything that must be read (axis labels, captions,
  chip text). Report title 20–22px, tile titles 14–15px, KPI values 24–28px.
- Sentence case. No uppercase letter-spaced labels, no gradient text, no emoji.
- `font-variant-numeric: tabular-nums` for figures; German number format.

## Layout: responsive by container, not by window

The artboard is a size container named `artboard`. Use **container queries**
(`@container artboard (max-width: 720px) { … }`), not `@media` on the window —
the preview panel, the full page and the PNG all have different widths.

- KPI row: `grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr))`.
- Visual grid: 12 columns on wide pages; at `max-width: 900px` 6 columns; at
  `max-width: 620px` every tile spans the full width.
- Chart heights in CSS with `clamp()`, e.g. `height: clamp(240px, 32cqw, 380px)`,
  and `td.chart(..., height=None)`.
- Never a fixed `grid.left/right` of more than ~16 px in chart options; let
  ECharts fit axis labels (default in ECharts 6). Long category names: horizontal
  bars with `axisLabel.width: 120, overflow: "truncate"`.
- No `min-height: 100vh`, no fixed pixel widths on tiles, no horizontal scroll.
- Artboard padding is handled by the scaffold; tiles need no extra outer padding.

For `16:9` and A4 the canvas is fixed; design for it, but still avoid hex
colours and unreadable sizes.

## Page grammar that doesn't look generated

1. **Header**: logo (~24px high) and report title on the page background,
   data freshness and period right-aligned in `--muted`, a single hairline
   (`--line`) below. No coloured header bar with rounded corners.
2. **Filter context**: one line of quiet text chips — transparent background,
   `--line` border, 12–13px; the active value in `--fg` weight 500. Only
   filters that describe the data shown.
3. **Key figures**: 3–5 figures in ONE tile, separated by hairline dividers
   (not five separate boxed cards). Each: label (13px `--muted`), value
   (24–28px/600 `--fg`), comparison line with ▲/▼ in `--td-good`/`--td-critical`
   and what it compares to. No coloured left or top accent borders.
4. **Visual tiles**: `--td-surface` background, 1px `--line` border, 8px radius,
   no or very faint shadow. Title states the finding or measure + dimension
   ("amazon trägt 37 % des Umsatzes"), subtitle gives unit and period.
   The most important visual gets the largest tile.
5. **Tables** where exact values matter: right-aligned tabular numbers, hairline
   rows, header in `--muted` 13px/500, optional in-cell bars in `@s1`.
6. **Footer**: source and data freshness, 12px `--muted`.

## Charts

- Direct labels over legends when there are ≤ 6 points; legend small, top-right.
- Bars: `barMaxWidth` 24–32, `itemStyle.borderRadius: 2`; one colour per measure.
- Lines: width 2–2.5, `symbol: "none"` or small; area opacity ≤ 0.12 for the main measure only.
- Donuts only for 2–5 shares, labels `"{b}: {d}"`; otherwise a sorted bar chart.
- `dataZoom` for long time series; `tooltip.valueFormatter` always set.

## Final checks (render, don't assume)

- Switch the preview to dark mode: every text, chip, axis and label readable?
- Narrow the preview to ~420 px: no clipped labels, no horizontal scroll, tiles stacked?
- Any hex colour, `#fff`, fixed `grid.left`, raw unformatted number, 10–11px
  text, weight 300 or 700+, uppercase tracked label or accent side-border? Fix it.
- Does the headline figure and its comparison read in two seconds?
