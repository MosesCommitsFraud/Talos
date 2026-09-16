# macs look for BI dashboards

Dashboards look like a professional BI report (Power BI, Tableau, Qlik style):
a report header, filter context, KPI cards and a grid of visual tiles. What
makes them macs is the **colour palette, Encode Sans and the logo** — not the
PowerPoint slide layout. Do not copy slide elements (big blue slide titles,
gradient footer band, slide-style accent panels).

`td.compose` applies the brand by default (`brand="macs"`): palette tokens,
Encode Sans embedded offline, themed ECharts axes/legends/tooltips, and the
logo via `{{brand:logo}}`. Use `brand=None` only for a deliberately unbranded page.

## Colours: use the CSS variables, never invent hex

| Role | Variable | Light | Use |
| --- | --- | --- | --- |
| macs blue | `--brand-blue` | `#0785c0` | Primary series, selected filter chip, active tab, key KPI value |
| Petrol | `--brand-petrol` | `#2b4553` | Header bar or secondary series, strong text |
| Deep blue | `--brand-deep` | `#1f4e79` | Tile titles, emphasised numbers |
| Text | `--fg` / `--muted` | `#1f3a4d` / `#5a6672` | Values, labels / captions, units, sources |
| Canvas | `--brand-grey` | `#f3f5f7` | Page background behind the tiles |
| Tile | `--td-surface` | `#ffffff` | Visual and KPI card background |
| Soft highlight | `--brand-tint` | `#e7f2f9` | Selected row, hovered chip, highlighted band |
| Borders | `--line` | `#dbe3ea` | Tile borders, table rules, dividers |
| Chart series | `--td-s1…s8` | blue, petrol, light blue, amber, … | Applied automatically in fixed order |
| Status | `--td-good`, `--td-critical` | | Delta arrows / variance only, always with sign and text |

Dark mode swaps all variables automatically (near-black canvas, dark tiles,
white logo "m"). Never hard-code white or light colours; go through variables.

Colour discipline: macs blue carries the primary measure across all visuals,
petrol and light blue the comparison (prior year, plan), grey for "other".
The same measure keeps the same colour in every visual. Amber (`--td-s4`) is
the single highlight hue. No purple, rainbow category palettes or neon.

## Typography

- Encode Sans only; it is set on the artboard. Do not set other font families.
- Report title 20–24px weight 600; tile titles 13–14px weight 600 `--brand-deep`.
- KPI values 26–34px weight 600, tabular numbers (`font-variant-numeric: tabular-nums`),
  label 12px `--muted` above, delta 12px with ▲/▼ and `--td-good`/`--td-critical`.
- Axis/labels 11–12px, captions and data source 11px `--muted`.
- German number format (`1.234,5 €`, `12,3 %`). No emoji.

## BI report grammar

1. **Header bar** (48–56px): `{{brand:logo}}` left (~26–30px high), report title,
   right side: data freshness ("Stand 31.03.2026") and period. White or petrol
   background (if petrol, use `--logo-ink:#fff` on the header).
2. **Filter row**: static chips showing the active context (Zeitraum, Region,
   Kostenstelle …) — pill or 4px-radius, `--line` border, the active value in
   `--brand-blue`. Only show filters that describe the data actually shown.
3. **KPI cards**: 3–5 in a row, white tile, 1px `--line` border, 6px radius,
   optional 3px top or left border in the measure's colour. Each KPI has a
   comparison (Vorjahr, Plan) and optionally a small sparkline.
4. **Visual grid**: CSS grid (12 columns, 12–16px gap) on the grey canvas.
   Tiles differ in size by importance — the main trend spans 8 columns, a
   ranking 4 columns, a detail table full width. Each tile: title top left,
   optional subtitle/unit in `--muted`, visual below, no redundant chart title.
5. **Tables/matrices** where exact values matter: header row `--brand-grey`,
   1px rules, right-aligned numbers, conditional bars or colour scale in blue.
6. Subtle depth only: `box-shadow: 0 1px 2px rgba(16,24,40,.06)`. No glass,
   glow, large radii or gradients.

For `16:9` and A4 use the same grammar compressed to the canvas; for `web` let
the grid reflow (e.g. 12 → 6 → 1 columns).

## Charts

The runtime already themes axes, legends and tooltips. In options additionally:

- Hide the ECharts `title` (the tile has an HTML title); tight `grid` margins.
- Light split lines, no axis ticks on category axes, no 3D, no shadows.
- Bars: `barMaxWidth` 24–36, `borderRadius: 2`; one colour per measure, not per bar.
- Lines: width 2–2.5, small or no symbols; area fill ≤ 0.12 opacity for the main measure.
- Legends at top right of the tile, small; direct labels when there are few points.
- Donuts only for 2–5 shares with labels; horizontal bars for rankings.
- Add `dataZoom` for long time series and cross-highlighting (`emphasis`,
  `connect`) where it helps exploration.

## Anti-generic checklist (run before delivering)

- No logo, default system font, or colours outside the table above.
- A different colour scheme in every visual; the same measure changes colour.
- KPI cards without comparison, or cards that are just an icon plus a number.
- Generic tile titles ("Chart 1", "Übersicht") instead of measure + dimension
  ("Umsatz nach Monat, Ist vs. Vorjahr").
- Emoji, decorative icons, gradient text, glowing or glassmorphism effects.
- Missing units, period or data source.
