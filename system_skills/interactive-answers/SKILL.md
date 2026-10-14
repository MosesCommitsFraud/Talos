---
name: interactive-answers
description: "Base method for answers shown in the chat instead of told: when to use render_widget (standard chart, KPIs, table, diagram, timeline, comparison from data) or render_ui (bespoke interactive UI: calculators, simulations, adjustable comparisons, small tools like checklists, counters, timers, live previews), the Talos UI kit, talos.chart, sources and follow-ups. Read it before the first render_ui/render_widget of a turn. Not for files the user wants to keep (dashboard-v2) or plain factual answers."
requires-tools: render_ui, render_widget
license: MIT
keywords: visualisieren, interaktiv, ansicht, darstellen, zeigen, rechner, simulation, vergleich, gewichtung, regler, dashboard im chat, visualize, interactive, calculator, simulate
---

# Interactive answers in the chat (`render_widget` / `render_ui`)

`render_ui` renders a small web app **inline in the chat**, in a sandboxed
iframe that already carries the Talos look: font, colours, light/dark mode,
styled controls, a component kit and chart helpers. You send `html`, `js`,
`data` and the required `sources` (plus a little `css` when needed); Talos
draws the card around it, the source bar under it and a toolbar (full screen,
source, HTML/PNG download).

## 1. Decide: text, view, or file

| The user wants to … | Answer with |
|---|---|
| know a fact, a definition, a short how-to | text |
| **understand** structure: a process, an architecture, a timeline, how parts relate | `render_ui` – diagram (SVG) |
| **compare** options, periods, products, scenarios | `render_ui` – chart, or comparison with adjustable weights |
| **work something out**: "was kostet …, wenn …", break-even, loan, staffing, sizing | `render_ui` – calculator with sliders/inputs |
| explore data from the database, the knowledge base or the web | `render_ui` – KPIs + chart with a selector |
| **use** something: tick off steps, count, time, convert, write with a live preview, quiz themselves | `render_ui` – a small tool built for exactly this request (`ui-apps`) |
| keep, send or print it (an HTML file, a dashboard to download, a PNG for slides) | **file**: `dashboard-v2` skill, not `render_ui` |

**Which tool:** a standard visual – chart, key figures, table, flow diagram,
timeline, side-by-side comparison – is `render_widget` with data only (see
`ui-visualization`, `ui-diagrams`). Anything with its own controls or logic –
sliders, weights, calculators, simulations, filters – is `render_ui`. Several
widgets in one answer are fine (key figures + chart + table).

**Related built-in skills** – load each one the task needs with `read_skill`,
as many as apply, alongside this one:

| Skill | Load when |
|---|---|
| `ui-visualization` | choosing a chart type, KPI tiles, tables, comparisons; ECharts/D3/Chart.js/three.js |
| `ui-diagrams` | processes, architectures, org charts, sequences, timelines |
| `ui-data` | data from SQL, the knowledge base or the web; reloading it from the view (`dataSources`); images |
| `ui-maps` | anything with locations, routes or regions |
| `ui-apps` | tools to use: todo/checklists, counters, timers, converters, live previews, quizzes, planners |

No ceremony: if a view helps, build it straight away – do not ask "soll ich
das visualisieren?". One view per answer is the norm. Write 1–3 sentences
around it (what it shows, what stands out); never repeat its numbers as a table.

## 2. Get the data first

The iframe has **no network** (`fetch`, XHR, WebSocket all fail). Everything the
view shows goes into the call.

| Origin | How | `sources` entry |
|---|---|---|
| Database | `query_sql`, aggregated in SQL (GROUP BY, ROUND, TOP/LIMIT); independent queries in one message | `{"kind":"sql","label":"Umsatz je Monat","ref":"dbo.orders"}` |
| Knowledge base | `search_knowledge` / `grep_knowledge` / `read_knowledge` | `{"kind":"knowledge","label":"Wartungsintervalle","ref":"Wartungshandbuch.pdf, Kap. 4"}` |
| Web | `web_search` / `web_fetch` | `{"kind":"web","label":"Leitzins EZB","ref":"https://…"}` |
| Your own general knowledge | well-established facts (physical constants, typical values, historic dates) | `{"kind":"model","label":"Typische Wirkungsgrade von Wärmepumpen"}` |
| The user | values from the conversation | `{"kind":"user","label":"Angebote aus deiner Nachricht"}` |
| Derived | sums, shares, forecasts you computed | `{"kind":"calculated","label":"Gewichtete Summe"}` |
| Example values | no real data exists (generic calculator, concept sketch) | `{"kind":"illustrative","label":"Beispielwerte"}` – say so in the text |

Never present invented numbers as facts. Keep `data` small: aggregate, round,
at most a few thousand points.

## 3. Build it with the kit

Field order (lets the view stream in progressively): `title`, `initialHeight`,
`placeholderMessages`, `css`, `html`, `js`, `jsInit`, `data`, `sources`.
`html` is a fragment. `js` defines functions and wiring; `jsInit` runs short
calls after it (`["render()"]`). `data` is `window.TALOS_DATA`.
`initialHeight`: realistic estimate (KPIs + chart ≈ 420).

### Components (classes)

Layout and surfaces:

| Class | Use |
|---|---|
| `t-stack` / `t-row` / `t-spread` | vertical stack / wrapping row / row with space-between |
| `t-grid` | responsive tiles (min width via `style="--t-min:200px"`) |
| `t-split` | two columns: controls left, result right (stacks on narrow screens) |
| `t-section` | a part of the view with a `t-title` heading |
| `t-card` | filled tile for a key figure or a small panel |
| `t-card raised` (+ `accent`) | one bordered object – an offer, a record (+ the recommended one) |
| `t-kpi` > `t-kpi-label`, `t-kpi-value` (`<small>` unit), `t-delta up\|down` | key figure; add `<div class="t-spark" id=…>` + `talos.spark(el, values)` for a trend |
| `t-title`, `t-note`, `t-muted`, `t-num` | heading, small grey text, muted, tabular figures |
| `t-badge` (`good` `warn` `bad`), `t-chip`, `t-avatar` | status label, neutral pill, initials circle |
| `t-callout` (`good` `warn` `bad`) | tinted note: `<div class="t-callout warn"><b>Hinweis</b> …</div>` |
| `t-progress` (`good` `warn` `bad`) | bar with `style="--v:62%"` – animates when `--v` changes |
| `t-list` | dense rows divided by hairlines (each child a row; `button` rows are clickable) |
| `details.t-disclosure` > `summary` | collapsible part (assumptions, details) |
| `data-tip="…"` on any element | small tooltip on hover |
| `t-table`, `td.num`, `t-scroll` | compact table, right-aligned numbers, wrapper for wide tables |

Controls – they wire themselves; listen for the bubbling `talos:change` event
(`e.detail.value`, chips also `e.detail.values`) or read the inputs:

| Markup | Control |
|---|---|
| `<div class="t-seg"><button data-value="m" aria-pressed="true">Monat</button>…</div>` | segmented control, gliding marker |
| `<div class="t-tabs"><button data-tab="a" aria-selected="true">Übersicht</button>…</div>` + `<div data-tab-panel="a">…</div>` | tabs with sliding underline; panels show/hide by themselves |
| `<div class="t-chips"><button data-value="nord" aria-pressed="true">Nord</button>…</div>` | filter chips, multi-select (`data-single` for one) |
| `<div class="t-options"><label class="t-option"><input type="radio" name="p"><span><b>Basis</b><small>12 €/Monat</small></span></label>…</div>` | choice cards (radio or checkbox) |
| `<div class="t-field"><label>Preis <output id="po"></output></label><input type="range" min=0 max=100 step=5></div>` | slider with live value: a track that swells while dragged and shows the value (your `<output>`, else the number + `data-unit`) in a bubble. With 12 values or fewer (`min=1 max=10`) it becomes a row of step segments; force that with `class="t-steps"`, avoid it with `data-continuous`. `t-scale` for end captions |
| `<label class="t-toggle"><input type="checkbox" class="t-switch"> Prognose zeigen</label>` | switch |
| `<div class="t-stepper"><button data-step="-1">−</button><input type="number" value="3" min="0"><button data-step="1">+</button></div>` | stepper for counts |
| `<select>` with `<option>`s | dropdown – Talos turns it into a floating list with keyboard support (`data-native` keeps the browser's own); read `select.value`, listen for `change` |
| `t-btn`, `t-btn primary`, `t-btn ghost`, `t-btn sm` | buttons (one `primary` at most) |

Motion is built in and subtle: switches spring, slider knobs grow a halo,
markers glide, charts grow in on their first draw (redraws are instant).
`talos.kit.count(el, value, format)` counts a figure to its new value – use it
when a slider changes a result. Respect it: no extra CSS animations.

### Layout – like Claude's interactive answers

Talos puts the view in one clean card – the `title` on top, the sources behind
a small icon next to it – the same card as its table and weather widgets.

- Do **not** repeat the title as a heading in `html`; do not wrap the view in
  another card or bordered box, and do not list the sources inside the view.
- Key figures: `t-card` tiles in a `t-grid` – filled, no border, a muted label
  (`t-kpi-label`) above the number (`t-kpi-value`).
- `t-card raised` only for one bounded object – an offer, a record. Mark the
  recommended one with `t-card raised accent` and a
  `<span class="t-badge">Empfohlen</span>`. Never a card inside a card.
- Separate parts with spacing (`t-stack`, `t-section`), not lines or boxes.
- Prefer real controls over text: chips to filter, a segmented control to
  switch views, tabs for separate perspectives, choice cards to pick a
  variant, a stepper for counts, a `<select>` for long option lists.
- Charts, tables and maps stand on their own; no frame around them.
- **No scrolling inside the view.** It grows to its content; fit the width.
  Only a table wider than the column goes in `<div class="t-scroll">`.
- Sentence case, two weights (400, 500), short labels. Explanations belong in
  your text around the view, not inside it.
- A button that asks a follow-up through `talos.sendPrompt` ends with "↗".

Bare `button`, `input`, `select`, checkboxes, range sliders and tables already
look exactly like the Talos controls. Do not restyle them; write `css` only for
layout specifics or a custom diagram.

### Charts (`talos.chart`)

```js
const chart = talos.chart.bar('#chart', {
  categories: ['Jan', 'Feb', 'Mär'],
  series: [{ name: 'Umsatz', values: [120, 135, 128] }],  // several series → legend
  unit: 'T€',            // or format: v => talos.fmt.currency(v)
  // horizontal: true, stacked: true, height: 260, valueLabels: false
});
chart.update({ series: [...] });   // redraw after a slider moves
talos.chart.line('#trend', { categories, series, unit: '%', area: true });
talos.chart.donut('#mix', { items: [{ label: 'A', value: 40 }, …], unit: 'Stk', centerLabel: 'Gesamt' });
```

Tooltips, axes, gridlines, legend and colours are handled. Series take
`--talos-chart-1…8` in order – the same palette as Talos dashboards.
Formatting: `talos.fmt.number(v, digits)`, `.currency(v, 'EUR')`,
`.percent(0.25)` → "25 %", `.compact(1234567)` → "1,2 Mio.", `.unit(v, 'kWh')`.

For diagrams (processes, architectures, timelines) draw an inline SVG with a
`viewBox` and `width:100%`; colour it with `var(--talos-…)` tokens:
`--talos-fg`, `--talos-muted`, `--talos-border`, `--talos-surface`,
`--talos-accent`, `--talos-chart-1…8`, `--talos-good`, `--talos-critical`.
Never hard-code white/black – the view follows light/dark mode live.

**Quality bar:** works at 360 px width · labelled controls · inputs clamped,
never `NaN` (show "–") · units on every number · calm (no autoplay, no
blinking) · no `alert`/`prompt`/`localStorage`/top-level `await`.

## 4. Follow-ups from the view

`window.talos.sendPrompt(text)` sends a chat message as the user – **only inside
a click handler**. Use it for drill-downs that need the agent (new data, a
deeper explanation). Anything the view can compute itself (filtering,
re-weighting, recalculating) happens in the view.

## 5. Later turns

The view stays in the chat. For a change ("als Balkendiagramm", "nimm 2023
dazu"), call `render_ui` again with the **complete new version**, reusing the
data you already have unless new data is needed.

## Example – comparison with adjustable weights

```json
{
  "title": "Angebotsvergleich – gewichtete Bewertung",
  "initialHeight": 330,
  "placeholderMessages": ["Bereite den Vergleich vor …"],
  "css": "",
  "html": "<div class=\"t-split\"><div class=\"t-stack\" id=\"weights\"></div><div class=\"t-stack\"><div id=\"chart\"></div><div class=\"t-spread\"><p class=\"t-note\">Punkte 0–10 je Kriterium, gewichtet. <span id=\"winner\"></span></p><button class=\"t-btn\" id=\"ask\">Annahmen erklären</button></div></div></div>",
  "js": "const D = window.TALOS_DATA;\nconst w = Object.fromEntries(D.criteria.map(c => [c.key, c.weight]));\nlet chart;\nfunction controls() {\n  document.getElementById('weights').innerHTML = D.criteria.map(c => `<div class=\"t-field\"><label for=\"w-${c.key}\">${c.label}<output id=\"o-${c.key}\">${w[c.key]} %</output></label><input type=\"range\" id=\"w-${c.key}\" min=\"0\" max=\"100\" step=\"5\" value=\"${w[c.key]}\"></div>`).join('');\n  D.criteria.forEach(c => document.getElementById('w-' + c.key).addEventListener('input', e => {\n    w[c.key] = +e.target.value;\n    document.getElementById('o-' + c.key).textContent = w[c.key] + ' %';\n    render();\n  }));\n}\nfunction scores() {\n  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;\n  return D.options.map(o => D.criteria.reduce((a, c) => a + o.scores[c.key] * w[c.key], 0) / total);\n}\nfunction render() {\n  const s = scores();\n  const opts = { categories: D.options.map(o => o.name), series: [{ name: 'Gewichtete Punkte', values: s }], max: 10, format: v => talos.fmt.number(v, 1), horizontal: true };\n  if (chart) chart.update(opts); else chart = talos.chart.bar('#chart', opts);\n  const best = s.indexOf(Math.max(...s));\n  document.getElementById('winner').textContent = `Vorne: ${D.options[best].name}.`;\n}\ndocument.getElementById('ask').addEventListener('click', () => window.talos.sendPrompt('Erkläre die Bewertungen und Annahmen hinter dem Angebotsvergleich.'));",
  "jsInit": ["controls()", "render()"],
  "data": {
    "criteria": [
      {"key": "preis", "label": "Preis", "weight": 40},
      {"key": "qualitaet", "label": "Qualität", "weight": 35},
      {"key": "lieferzeit", "label": "Lieferzeit", "weight": 25}
    ],
    "options": [
      {"name": "Angebot A", "scores": {"preis": 8, "qualitaet": 6, "lieferzeit": 7}},
      {"name": "Angebot B", "scores": {"preis": 6, "qualitaet": 9, "lieferzeit": 6}},
      {"name": "Angebot C", "scores": {"preis": 7, "qualitaet": 7, "lieferzeit": 9}}
    ]
  },
  "sources": [
    {"kind": "user", "label": "Angebote und Bewertungen aus deiner Nachricht"},
    {"kind": "calculated", "label": "Gewichtete Summe je Angebot"}
  ]
}
```

## Example – database figures with KPIs and a period switch

Data came from two `query_sql` calls (monthly revenue per region, aggregated in SQL).

```json
{
  "title": "Umsatz 2025 nach Region",
  "initialHeight": 440,
  "placeholderMessages": ["Lade Umsatzzahlen …"],
  "css": "",
  "html": "<div class=\"t-stack\"><div class=\"t-grid\" id=\"kpis\"></div><div class=\"t-spread\"><div class=\"t-seg\" id=\"mode\"><button data-value=\"month\" aria-pressed=\"true\">Monate</button><button data-value=\"cum\" aria-pressed=\"false\">Kumuliert</button></div><span class=\"t-note\">in Tausend €</span></div><div id=\"trend\"></div></div>",
  "js": "const D = window.TALOS_DATA;\nlet mode = 'month', chart;\nconst cum = a => a.reduce((r, v, i) => (r.push(v + (r[i - 1] || 0)), r), []);\nfunction kpis() {\n  const total = D.regions.reduce((a, r) => a + r.values.reduce((x, y) => x + y, 0), 0);\n  const delta = (total - D.previousYear) / D.previousYear;\n  const top = D.regions.map(r => [r.name, r.values.reduce((x, y) => x + y, 0)]).sort((a, b) => b[1] - a[1])[0];\n  document.getElementById('kpis').innerHTML = `\n    <div class=\"t-card t-kpi\"><span class=\"t-kpi-label\">Umsatz 2025</span><span class=\"t-kpi-value\">${talos.fmt.number(total / 1000, 2)}<small>Mio. €</small></span><span class=\"t-delta ${delta >= 0 ? 'up' : 'down'}\">${delta >= 0 ? '▲' : '▼'} ${talos.fmt.percent(Math.abs(delta))} ggü. Vorjahr</span></div>\n    <div class=\"t-card t-kpi\"><span class=\"t-kpi-label\">Stärkste Region</span><span class=\"t-kpi-value\">${top[0]}</span><span class=\"t-delta\">${talos.fmt.number(top[1])} T€</span></div>`;\n}\nfunction render() {\n  const series = D.regions.map(r => ({ name: r.name, values: mode === 'cum' ? cum(r.values) : r.values }));\n  const opts = { categories: D.months, series, unit: 'T€', area: mode === 'cum' };\n  if (chart) chart.update(opts); else chart = talos.chart.line('#trend', opts);\n}\ntalos.kit.segmented('#mode', v => { mode = v; render(); });",
  "jsInit": ["kpis()", "render()"],
  "data": {
    "months": ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
    "previousYear": 3480,
    "regions": [
      {"name": "Nord", "values": [98, 104, 120, 115, 122, 130, 118, 109, 127, 133, 141, 156]},
      {"name": "Süd", "values": [112, 118, 125, 131, 128, 137, 142, 129, 134, 140, 146, 160]},
      {"name": "West", "values": [76, 80, 85, 83, 90, 94, 88, 82, 91, 95, 99, 108]}
    ]
  },
  "sources": [
    {"kind": "sql", "label": "Umsatz je Monat und Region, 2025", "ref": "dbo.orders"},
    {"kind": "sql", "label": "Vorjahresumsatz gesamt", "ref": "dbo.orders"},
    {"kind": "calculated", "label": "Kumulierung und Veränderung zum Vorjahr"}
  ]
}
```

## Checklist before you send

- [ ] A view actually helps here (otherwise text; a file → `dashboard-v2`).
- [ ] Every number comes from a tool result, the user or your well-established knowledge – or is marked `illustrative`.
- [ ] `sources` lists every origin.
- [ ] Kit classes and `talos.chart` used; colours only via `--talos-*`; works at 360 px.
- [ ] Inputs clamped; no NaN; controls labelled.
- [ ] Data a control needs later is a declared `dataSources` entry (`ui-data`), not invented on the fly.
- [ ] `sendPrompt` only in click handlers.
- [ ] Text around it is short and does not repeat the view.
