---
name: ui-visualization
description: "Choosing and building the right visual in the chat: render_widget charts (bar, horizontal, stacked, line, area, donut), KPI tiles, tables, comparisons; chart-choice rules, palettes and when to use ECharts, D3, Chart.js or three.js in render_ui. Use with interactive-answers whenever numbers are shown visually."
requires-tools: render_ui, render_widget
keywords: diagramm, chart, balken, balkendiagramm, linie, verlauf, entwicklung, trend, anteil, kennzahlen, tabelle, vergleich, ranking, grafik, chart, graph, bar, line, kpi, table
---

# Visualizing figures in the chat

## Pick the form from the question

| The question is about … | Use |
|---|---|
| a few headline numbers and how they changed | `render_widget` `kpi` (with `delta`, `higherIsBetter`) |
| development over time | `chart` `line` (one to four series) or `area` (a total building up) |
| ranking or comparing categories | `chart` `horizontal` (long labels, > 8 items) or `bar` |
| composition of a whole | `chart` `stacked` (over time) or `donut` (one moment, ≤ 7 parts) |
| exact values to look up or sort | `table` |
| options against criteria | `comparison` (mark the best value per row with `best`) |
| a mix | several widgets in one answer: `kpi` first, then the chart, then a table |

Prefer `render_widget` – it is fast, consistent and cannot break. Switch to
`render_ui` only for interaction the widgets do not have (filters that
recompute, sliders, what-if), and then use `talos.chart` there.

## Chart rules

- One message per chart; the title says it ("Umsatz je Monat 2025, in T€").
- Units in `unit`; round values to what matters (no 7 decimals).
- Categories in their natural order (months, years); rankings sorted.
- Do not mix magnitudes in one chart (revenue and margin %) – two charts.
- ≤ 8 series; beyond that aggregate ("Sonstige") or use a table.
- Colours come from the Talos palette automatically – do not set colours
  unless one series must be highlighted.
- Key figures: `delta` is a fraction (0.12 = +12 %); set `higherIsBetter:
  false` for costs, error rates, durations so the colour reads right.

## render_widget data, by type

- `chart`: `{kind, categories, series: [{name, values}], unit}`; donut:
  `{kind: "donut", items: [{label, value}], unit}`.
- `kpi`: `{items: [{label, value, unit, delta, deltaLabel, higherIsBetter, note}]}`.
- `table`: `{columns, rows}` (rows as lists); sortable, CSV download, chart toggle.
- `comparison`: `{options, rows: [{criterion, values, best}], verdict}`.

## Libraries in render_ui

Served locally by Talos (no internet needed, no CDN – CDN URLs are blocked).
List them in `libraries`:

| Name | Global | Use for |
|---|---|---|
| `echarts` | `echarts` | many series, zoom/brush, heatmaps, sankey, treemaps |
| `d3` | `d3` | custom data-driven SVG (hierarchies, force layouts) |
| `chartjs` | `Chart` | when the user explicitly wants Chart.js |
| `three` | `THREE` | 3D – only when 3D adds understanding |
| `leaflet` | `L` | maps beyond `talos.map` (GeoJSON areas) |
| `mermaid` | `mermaid` | flowcharts/sequence diagrams from text |

Prefer `talos.chart` / `talos.map`: they match the Talos look without work.
With a library, take colours from the tokens
(`getComputedStyle(document.documentElement).getPropertyValue('--talos-chart-1')`).


Library charts must follow the theme: read colours with
`talos.color('--talos-chart-1')` … (resolved to rgb, which every library
understands) and `talos.color('--talos-fg')` / `'--talos-muted'` /
`'--talos-border'` for text and grid. Re-read them in a
`window.addEventListener('talos:theme', …)` handler and redraw.

## Example – key figures and a trend (two widgets)

```json
{
  "type": "kpi",
  "title": "Vertrieb 2025",
  "data": {"items": [
    {"label": "Umsatz", "value": 4.15, "unit": "Mio. €", "delta": 0.191, "deltaLabel": "ggü. Vorjahr"},
    {"label": "Aufträge", "value": 12840, "delta": 0.064},
    {"label": "Reklamationsquote", "value": "1,8 %", "delta": 0.12, "higherIsBetter": false}
  ]},
  "sources": [{"kind": "sql", "label": "Kennzahlen 2025", "ref": "dbo.orders"}]
}
```

```json
{
  "type": "chart",
  "title": "Umsatz je Monat 2025, in T€",
  "data": {"kind": "line", "categories": ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun"], "series": [{"name": "2025", "values": [286, 302, 330, 329, 340, 361]}, {"name": "2024", "values": [261, 270, 298, 301, 307, 322]}], "unit": "T€"},
  "sources": [{"kind": "sql", "label": "Umsatz je Monat", "ref": "dbo.orders"}]
}
```
