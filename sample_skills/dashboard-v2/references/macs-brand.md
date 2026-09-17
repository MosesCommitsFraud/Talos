# macs look for BI dashboards

Dashboards read like a well-made BI report (Power BI, Tableau): a header,
filter context, key figures and a grid of visuals. What makes them macs is
**the palette, Encode Sans and the logo** — not PowerPoint slide elements.

`td.compose` applies the brand by default (`brand="macs"`): palette tokens for
light and dark, Encode Sans embedded offline, themed axes/legends/tooltips/labels,
and the logo via `{{brand:logo}}`. `brand=None` only for a deliberately unbranded page.

Every page must work in **three situations at once**: light mode, dark mode,
and a narrow Talos side panel (~420 px wide) as well as a wide screen.

**Theme:** a page is light by default. The Talos preview switches it to the
app's theme (it sets `data-theme` on the root); a downloaded file opened on its
own stays light. Never write your own `prefers-color-scheme` rules or a fixed
dark/light background — use the variables below and both modes follow.

**Enforced:** `td.compose` rejects the page and lists every problem when it
finds fixed colours (hex, `rgb()`, `white`, `black`) in CSS, inline styles or
chart options, font sizes under 12px, font weights outside 400–600,
`@media (max/min-width)` breakpoints, Python-style formatters like
`"{c:,.0f}"`, raw `"{value} Mio"` labels or a chart `grid.left/right` over
48 px. Fix the listed points and call it again.

**Logo:** `{{brand:logo}}` is an inline SVG element on its own —
`<header>{{brand:logo}}<h1>…</h1></header>`. Never put it in `<img src="…">`
or any other attribute. Size it with `#td-artboard .brand-logo {height: 24px}`.

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
| `"@s1/30"` | any token with opacity in percent — area fills, gradient `colorStops` |
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
`tooltip.valueFormatter`. In HTML use the Python helpers — `td.eur(v)` →
`"20,7 Mio. €"`, `td.eur(v, compact=False)` → `"20.748.512 €"`, `td.pct(62.06)`
→ `"62,1 %"`, `td.pct(4.1, signed=True)` → `"+4,1 %"`, `td.num(12037)` →
`"12.037"`. English decimals (`207.5 Mio.`, `62.1%`) and `K €` are rejected.
In-cell bars: `td.meter(share_in_percent)` (clamped, cannot overflow).

Pie/donut labels show share **and** amount: `"{b}\n{d} · @eurCompact"`.

## Key figures people understand

Key figures are the numbers a controller or sales lead already uses: Umsatz,
Deckungsbeitrag/Marge, Veränderung ggü. Vorjahr/Plan, Anteil der größten
Position, Anzahl Kunden/Aufträge. Label them plainly and give the comparison
("+4,1 % ggü. Vorjahr", "37 % vom Umsatz"). Don't invent ratios such as
"Ø Umsatz/Produkt" unless the user asks for them — an unfamiliar ratio forces
the reader to decode instead of decide.

## Insights and recommendations (required)

Every dashboard carries an element with `class="insights"` holding 3–4 `<li>`
points computed from the data, each with the number that supports it:

- concentration / cluster risk ("Vitamin C Brausetablette = 47 % des Umsatzes"),
- dependence on few customers/products (top-3 share), long tail,
- trend breaks, strongest growth or decline, outliers vs. average,
- a concrete next step or what to check ("Preisstruktur Private Label prüfen").

No generic advice without a figure. `td.compose` rejects pages without it.

## Interaction: cross-filter and drill-down (no JavaScript needed)

Declare links in markup and chart options; the scaffold does the rest:

- **Chart as filter**: `"talos": {"emit": "gruppe"}` in a chart option — a click
  on a slice/bar sets `gruppe` to its name, a second click clears it (drill up).
  The emitting chart fades the unselected items.
- **Chart reacting**: `"talos": {"filter": "gruppe", "views": {"Mints": {"series":
  [{"data": [...]}], "yAxis": {"data": [...]}}, …}}` — option patches per value,
  precomputed in Python; without a filter the base option shows.
- **HTML reacting**: `data-filter="gruppe" data-value="Mints"` shows the element
  only for that value (or when unfiltered); add `data-collapsed` to hide it until
  drilled into; `data-value=""` shows it only while unfiltered (totals).
- **HTML as filter**: `data-filter-set="gruppe" data-value="Mints"` on a table row
  or chip — click drills down, click again drills up.
- **State**: `<span data-filter-status="gruppe"></span>` shows the active value,
  `<button data-filter-reset="gruppe">Alle</button>` clears it.

Typical: donut of groups emits `gruppe`; product bar chart has a view per
group; the group table rows are `data-filter-set`, product rows below are
`data-filter … data-collapsed`. ECharts' own drill-down (treemap/sunburst
`nodeClick`, `dataZoom`) stays available too.

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
- Visual grid: `repeat(auto-fit, minmax(min(100%, 380px), 1fr))`; it reflows by
  itself. Wide visuals `grid-column: span 2` only inside
  `@container artboard (min-width: 900px)`. No 12-column grids.
- Chart heights in CSS with `clamp()`, e.g. `height: clamp(240px, 32cqw, 380px)`,
  and `td.chart(..., height=None)`.
- Never a fixed `grid.left/right` of more than 48 px in chart options; let
  ECharts fit axis labels (default in ECharts 6). Long category names: horizontal
  bars with `axisLabel.width: 120, overflow: "truncate"`.
- No `min-height: 100vh`, no fixed pixel widths on tiles, no horizontal scroll.
- Artboard padding is handled by the scaffold; tiles need no extra outer padding.

For `16:9` and A4 the canvas is fixed; design for it, but still avoid hex
colours and unreadable sizes.

## Page grammar that doesn't look generated

Not everything belongs in a box. Rows of identical rounded cards are the most
recognisable generated-dashboard look. Group with whitespace, alignment and
hairlines first; use a surface only where it separates something real.

1. **Header**: logo (~24px high) and report title on the page background,
   data freshness and period right-aligned in `--muted`, one hairline below.
   No coloured header bar.
2. **Filter context**: one line of quiet chips (transparent, `--line` border,
   13px), the active value in `--fg` weight 500, plus the active filter and a
   reset control (`data-filter-status` / `data-filter-reset`).
3. **Key figures**: an open band on the page background, figures separated by
   vertical hairlines, a hairline under the band. No card, no coloured accent
   borders. Label 13px `--muted`, value 26–32px/600, comparison line with ▲/▼.
4. **Visuals**: sit directly on the page in a grid
   (`repeat(auto-fit, minmax(min(100%, 380px), 1fr))`, wide ones
   `grid-column: span 2` inside `@container artboard (min-width: 900px)`,
   full-width ones `1 / -1`). Heading states the finding, subtitle gives unit
   and period. Charts need real space: at least ~360px wide and 260px high.
   A 12-column grid is rejected because unspanned tiles collapse to 1/12.
5. **Tables** where exact values matter: right-aligned tabular numbers, hairline
   rows, header 13px/500 `--muted`, in-cell bars via `td.meter`.
6. **Insights**: a plain section under a hairline, readable line length
   (max ~78ch), numbered list. Not a card.
7. **Footer**: source and data freshness, 12px `--muted`.

## Language: write like a controller, not like a chatbot

Short, factual German sentences that start with the finding and carry the
number. `td.compose` rejects these machine-writing markers (based on
[Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
and German blacklists such as
[lillikoisser.at](https://lillikoisser.at/ki-texte-erkennen/)):

- em dash (—) and spaced en dash ( – ) as punctuation; use full stop, comma or
  colon. `–` stays fine in ranges (Jan–Dez).
- list items that start with a bold label and colon (`<b>Thema:</b> …`);
- stock phrases: nahtlos, ganzheitlich, maßgeschneidert, essenziell,
  bahnbrechend, bemerkenswert, entscheidende Rolle, es ist wichtig zu beachten,
  volles Potenzial, nächstes Level, "nicht nur … sondern auch" and the like;
- emoji and leftover template tokens such as `{{eur 123}}`.

Also avoid, even though not checked: three-part lists by habit ("schnell,
einfach und sicher"), "Nicht X, sondern Y" contrasts, hedging with "kann",
headings above every two sentences, and vague sources ("Experten sagen").

## Charts

- Direct labels over legends when there are ≤ 6 points; legend small, top-right.
- Bars: `barMaxWidth` 24–32, `itemStyle.borderRadius: 2`; one colour per measure.
- Lines: width 2–2.5, `symbol: "none"` or small; area opacity ≤ 0.12 for the main measure only.
- Donuts only for 2–5 shares, labels `"{b}\n{d} · @eurCompact"`, thin 1px
  separators (the default); otherwise a sorted bar chart.
- Colour callbacks may return tokens (`function (p) { return '@s2'; }`); never
  CSS `var(--…)` inside callbacks' HTML strings.
- Bar value labels outside the bar get automatic headroom on the value axis;
  don't widen `grid.right` for them.
- Every ECharts series and component is available (see SKILL.md) — pick by
  the question: heatmap, treemap, sunburst, sankey, funnel, boxplot, scatter,
  calendar, parallel, custom series …
- `dataZoom` for long time series; `tooltip.valueFormatter` always set.

## Final checks (render, don't assume)

- Switch the preview to dark mode: every text, chip, axis and label readable?
- Narrow the preview to ~420 px: no clipped labels, no horizontal scroll, tiles stacked?
- Any hex colour, `#fff`, fixed `grid.left`, raw unformatted number, 10–11px
  text, weight 300 or 700+, uppercase tracked label or accent side-border? Fix it.
- Does the headline figure and its comparison read in two seconds?
- Click every filter source: do dependent charts, rows and the status update,
  and does a second click drill back up?
- Hover every bar and slice: nothing disappears or jumps.
