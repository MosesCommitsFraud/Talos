---
name: ui-data
description: "Getting real data into interactive answers and keeping it honest: SQL, knowledge base, web, user input and model knowledge; aggregation, embedding vs. dataSources, talos.refresh to reload data from the view, sources/provenance, images from the web. Use with interactive-answers whenever a view shows real figures or must reload data."
requires-tools: render_ui, render_widget
keywords: daten, datenbank, abfrage, sql, umsatz, kennzahlen, wissensdatenbank, dokumente, quellen, nachladen, filter, jahr, region, bilder, database, query, sources, refresh, images
---

# Data for interactive answers

## Principles

- Every figure in a view comes from a tool result, the user, or
  well-established general knowledge – and `sources` says which. Example
  values are allowed only when marked `illustrative`, and you say so.
- Aggregate where the data lives: `GROUP BY`, `SUM`, `ROUND`, `TOP`/`LIMIT`
  in SQL. A view needs tens or hundreds of points, not raw rows.
- Independent lookups go out in ONE message (they run in parallel).

## Sources

| Origin | `kind` | `ref` |
|---|---|---|
| `query_sql` | `sql` | table or view, e.g. `dbo.orders` |
| `search_knowledge` / `read_knowledge` | `knowledge` | document and section, e.g. `Handbuch.pdf, Kap. 4` |
| `web_search` / `web_fetch` | `web` | the URL |
| the conversation | `user` | – |
| your own general knowledge | `model` | – |
| values you computed | `calculated` | – |
| example values | `illustrative` | – |

Talos shows the list under the view; the view itself never claims sources.

## Embed or reload?

Embed what the first view shows in `data` (`window.TALOS_DATA`). Declare a
data source only for what a control needs LATER – another year, region,
product, search term.

### Live data (`dataSources` + `talos.refresh`)

Embed what the first view shows in `data`. When a control needs data you did
not embed – another year, region, product, search term – declare a data
source and let the control reload it, instead of embedding everything or
asking for a new turn:

| kind | spec | result of `await talos.refresh(id, params)` |
|---|---|---|
| `sql` | `query` (read-only, `:name` bind parameters), optional `database`, `maxRows` | `{columns, rows, rowCount, truncated}` (rows are arrays) |
| `web` | `url` – https template, `{name}` in path/query, never in the host; `maxChars` | `{url, title, text}` |
| `knowledge` | `query` – search template with `{name}`; `topK` | `{query, passages:[{document, page, text, score}]}` |

Every parameter is declared in `params` with a type and bounds:
`{"type":"int","min":2018,"max":2025,"default":2025}`,
`{"type":"enum","values":["Nord","Süd","West"]}`, `{"type":"string","maxLength":60}`,
`{"type":"bool"}`, `{"type":"date","min":"2024-01-01"}`. The UI can only re-run
YOUR spec with values inside those bounds – it never sends its own SQL or URL.
Call `refresh` from a user action (change, click, slider), show a loading state
(e.g. dim the chart), and catch rejection (`.catch(e => …)` → show
`e.message`). Refreshes from the same source cancel each other – the last wins.

### Images

Images from the web cannot be loaded directly in the view. Write the https URL
into `<img src="…">` (or call `talos.img(url)` for URLs in `data`) – Talos
fetches them through its own proxy. Only use images the user benefits from;
cite where they come from in `sources`.


## Large results

`query_sql` spills big result sets to a CSV in the workspace. Do not embed
those: aggregate further in SQL, or – when the user really needs rows – show a
table widget with the top rows (~10–20) and say where the full set is. The
same applies to results that were not spilled: 200 rows are already far too
many for the chat – summarise, or collapse the rest behind a
`details.t-disclosure` (see `interactive-answers`).

## Example – live data: switch the year

The first year is embedded; the others are loaded when the user picks them.

```json
{
  "title": "Umsatz je Monat",
  "initialHeight": 400,
  "placeholderMessages": [
    "Lade Umsatz …"
  ],
  "css": ".busy{opacity:.45;transition:opacity .15s}",
  "html": "<div class=\"t-stack\"><div class=\"t-spread\"><div class=\"t-seg\" id=\"year\"></div><span class=\"t-note\" id=\"state\">in Tausend €</span></div><div id=\"chart\"></div></div>",
  "js": "const D = window.TALOS_DATA;\nlet chart;\nfunction draw(year, values) {\n  const opts = { categories: D.months, series: [{ name: String(year), values }], unit: 'T€' };\n  if (chart) chart.update(opts); else chart = talos.chart.bar('#chart', opts);\n}\nfunction years() {\n  document.getElementById('year').innerHTML = D.years.map(y => `<button data-value=\"${y}\" aria-pressed=\"${y === D.year}\">${y}</button>`).join('');\n  talos.kit.segmented('#year', async (y) => {\n    const box = document.getElementById('chart'), state = document.getElementById('state');\n    box.classList.add('busy'); state.textContent = 'lädt …';\n    try {\n      const r = await talos.refresh('umsatz', { jahr: Number(y) });\n      const byMonth = Object.fromEntries(r.rows.map(([m, v]) => [m, v]));\n      draw(y, D.months.map((_, i) => byMonth[i + 1] ?? null));\n      state.textContent = 'in Tausend €';\n    } catch (e) {\n      state.textContent = 'Nicht verfügbar: ' + e.message;\n    } finally { box.classList.remove('busy'); }\n  });\n}",
  "jsInit": [
    "years()",
    "draw(D.year, D.values)"
  ],
  "data": {
    "year": 2025,
    "years": [
      2023,
      2024,
      2025
    ],
    "months": [
      "Jan",
      "Feb",
      "Mär",
      "Apr",
      "Mai",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Okt",
      "Nov",
      "Dez"
    ],
    "values": [
      286,
      302,
      330,
      329,
      340,
      361,
      348,
      320,
      352,
      368,
      386,
      424
    ]
  },
  "dataSources": [
    {
      "id": "umsatz",
      "kind": "sql",
      "label": "Umsatz je Monat für ein Jahr",
      "query": "SELECT MONTH(datum) AS monat, ROUND(SUM(betrag) / 1000, 0) AS umsatz FROM dbo.orders WHERE YEAR(datum) = :jahr GROUP BY MONTH(datum) ORDER BY monat",
      "params": {
        "jahr": {
          "type": "int",
          "min": 2023,
          "max": 2025,
          "default": 2025
        }
      }
    }
  ],
  "sources": [
    {
      "kind": "sql",
      "label": "Umsatz je Monat",
      "ref": "dbo.orders"
    }
  ]
}
```

