---
name: ui-apps
description: "Small working tools built in the chat with render_ui: todo and checklists, counters and tallies, timers, converters, calculators, live previews (markdown, text, colours, regex), quizzes and flashcards, planners, random pickers, forms that hand back to the chat. Built from scratch for the request with the Talos kit – state, events, persistence (talos.store), copy and download. Use with interactive-answers whenever the user wants something to use, not only to read."
requires-tools: render_ui
keywords: todo, to-do, aufgabenliste, checkliste, liste, zähler, zaehler, counter, strichliste, timer, stoppuhr, pomodoro, countdown, umrechner, konverter, rechner, vorschau, live vorschau, markdown, editor, notizen, quiz, karteikarten, lernkarten, zufall, würfel, auswahl, planer, packliste, einkaufsliste, formular, tool, werkzeug, mini app, app
---

# Small tools in the chat (`render_ui`)

When the user wants something to **use** – tick off, count, time, convert,
type into and see the result – build a small working tool with `render_ui`.
There is no catalogue of ready-made widgets: write the tool for exactly this
request (its fields, its steps, its wording), from the kit's building blocks.
A packing list for a ski trip is not a generic todo app; a counter for a
stock-take counts the articles the user named.

Good fits:

| The user … | Build |
|---|---|
| has steps or items to work through | checklist / todo list with progress (`t-progress`), add, tick, remove |
| counts something | counter or tally per item, with +/− (`t-stepper`), totals, reset |
| needs a time box | timer, countdown, stopwatch, pomodoro with laps |
| converts or estimates | converter / calculator with live result as they type |
| writes or tests text | live preview: markdown (`talos.md`), text stats, regex tester, template filler |
| picks colours or styles | colour picker with contrast check, CSS value playground on a sample element |
| learns or checks knowledge | quiz, flashcards with flip and score |
| decides | weighted decision matrix, random picker, dice, team splitter |
| plans | weekly plan, shopping or packing list grouped by category |
| fills something in for you | a form whose button sends the answer back with `talos.sendPrompt` |

Still answer in text first when one sentence does it. Do not wrap a fact in an app.

## How to build it

- **State → render.** Keep all state in one object, write one `render()` that
  draws the whole view from it, call it after every change. No scattered DOM
  edits.
- **Persist what the user creates** with `talos.store`: items, counts, notes,
  progress survive a reload and a rebuilt card.
  ```js
  const state = talos.store.get('state', { items: D.items });
  function save() { talos.store.set('state', state); render(); }
  ```
  Seed from `data` (`window.TALOS_DATA`) on the first run only, as above.
- **One listener, delegated:** `root.addEventListener('click', e => { const b = e.target.closest('[data-act]'); … })`
  with `data-act="add|remove|toggle"` and `data-id` on the buttons – it keeps
  working after `render()` replaces the markup.
- **Keyboard:** Enter in the input adds, Escape clears. Focus stays in the
  input after adding (`input.focus()`).
- **Empty and done states:** say what to do when the list is empty
  (`<p class="t-note">Noch nichts hier – oben eintragen.</p>`), celebrate
  quietly when everything is done (`t-callout good`).
- **Results move:** `talos.kit.count(el, value, format)` counts a figure to
  its new value; `t-progress` animates when `--v` changes.
- **Timers:** `setInterval` with the start time stored (`Date.now()`), not a
  tick counter – the time stays right when the tab sleeps. Store a running
  timer's start in `talos.store`.
- **Ids** on inputs, selects and textareas: their values are also restored
  automatically when the card is rebuilt.

Bridge and helpers (all in the frame already):

| Call | Does |
|---|---|
| `talos.store.get(key, fallback)` / `.set(key, value)` / `.remove(key)` / `.clear()` | JSON state per view, kept across reloads (~100 KB) |
| `talos.copy(text)` | copy to the clipboard – from a click |
| `talos.download('liste.csv', text)` | save a file (csv, json, md, txt, ics, tsv, svg) – from a click |
| `talos.md(text)` | markdown → safe HTML; put it in `<div class="t-prose">` |
| `talos.sendPrompt(text)` | hand the result back to the chat – from a click; label the button with "↗" |
| `talos.kit.count(el, v, fmt)` · `talos.fmt.*` | animated figures, number/currency/percent formatting |
| `talos:change` events | from `t-seg`, `t-tabs`, `t-chips`; selects fire `change` |

Kit pieces that tools use most: `t-list` (rows), `t-stepper`, `t-chips`,
`t-seg`, `t-tabs` + `data-tab-panel`, `t-options`, `t-switch`, `t-progress`,
`t-badge`, `t-callout`, `t-prose`, `t-field`, `t-btn primary` (one per view),
`t-row`/`t-spread`/`t-stack`. Layout rules from `interactive-answers` apply:
no title in `html`, no box around the view, no scrolling inside it.

`sources`: a tool that shows no data of its own passes `"sources": []`. If it
starts from data (the steps of a manual, the articles from a query), name
that source as usual.

## Example – checklist built for the request

```json
{
  "title": "Packliste Skiwochenende",
  "initialHeight": 360,
  "html": "<div class=\"t-stack\" id=\"app\"><div class=\"t-spread\"><span class=\"t-note\" id=\"count\"></span><button class=\"t-btn ghost sm\" data-act=\"reset\">Zurücksetzen</button></div><div class=\"t-progress good\" id=\"bar\"></div><div class=\"t-row\"><input id=\"new\" placeholder=\"Etwas hinzufügen …\" style=\"flex:1\"><button class=\"t-btn primary\" data-act=\"add\">Hinzufügen</button></div><div id=\"groups\" class=\"t-stack\"></div></div>",
  "js": "const D = window.TALOS_DATA;\nconst state = talos.store.get('state', { items: D.items.map((t, i) => ({ id: i + 1, ...t, done: false })) });\nconst $ = s => document.querySelector(s);\nconst esc = s => String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));\nfunction save() { talos.store.set('state', state); render(); }\nfunction render() {\n  const done = state.items.filter(i => i.done).length, all = state.items.length;\n  $('#count').textContent = `${done} von ${all} eingepackt`;\n  $('#bar').style.setProperty('--v', (all ? done / all * 100 : 0) + '%');\n  const groups = [...new Set(state.items.map(i => i.group))];\n  $('#groups').innerHTML = groups.map(g => `<section class=\"t-section\"><h3 class=\"t-title\">${esc(g)}</h3><div class=\"t-list\">${state.items.filter(i => i.group === g).map(i => `<label><span class=\"t-toggle\"><input type=\"checkbox\" data-act=\"toggle\" data-id=\"${i.id}\" ${i.done ? 'checked' : ''}> <span style=\"${i.done ? 'text-decoration:line-through;color:var(--talos-muted)' : ''}\">${esc(i.text)}</span></span><button class=\"t-btn ghost sm\" data-act=\"remove\" data-id=\"${i.id}\" aria-label=\"Entfernen\">×</button></label>`).join('')}</div></section>`).join('') || '<p class=\"t-note\">Noch nichts hier – oben eintragen.</p>';\n}\n$('#app').addEventListener('click', e => {\n  const b = e.target.closest('[data-act]'); if (!b) return;\n  const id = Number(b.dataset.id);\n  if (b.dataset.act === 'add') add();\n  if (b.dataset.act === 'remove') { state.items = state.items.filter(i => i.id !== id); save(); }\n  if (b.dataset.act === 'reset') { state.items.forEach(i => i.done = false); save(); }\n});\n$('#app').addEventListener('change', e => { if (e.target.dataset.act === 'toggle') { const it = state.items.find(i => i.id === Number(e.target.dataset.id)); it.done = e.target.checked; save(); } });\nfunction add() { const v = $('#new').value.trim(); if (!v) return; state.items.push({ id: Date.now(), text: v, group: 'Sonstiges', done: false }); $('#new').value = ''; $('#new').focus(); save(); }\n$('#new').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });",
  "jsInit": ["render()"],
  "data": { "items": [ { "text": "Skihelm", "group": "Ausrüstung" }, { "text": "Skibrille", "group": "Ausrüstung" }, { "text": "Thermounterwäsche", "group": "Kleidung" }, { "text": "Handschuhe", "group": "Kleidung" }, { "text": "Skipass-Reservierung", "group": "Unterlagen" } ] },
  "sources": []
}
```

## Example – counter per item, exportable

```json
{
  "title": "Inventur Lager B",
  "initialHeight": 300,
  "html": "<div class=\"t-stack\" id=\"app\"><div class=\"t-list\" id=\"rows\"></div><div class=\"t-spread\"><span>Gesamt <b class=\"t-num\" id=\"total\">0</b></span><button class=\"t-btn sm\" data-act=\"csv\">Als CSV speichern</button></div></div>",
  "js": "const D = window.TALOS_DATA;\nconst counts = talos.store.get('counts', Object.fromEntries(D.articles.map(a => [a, 0])));\nfunction render() {\n  document.getElementById('rows').innerHTML = D.articles.map(a => `<div><span>${a}</span><div class=\"t-stepper\"><button data-step=\"-1\" data-a=\"${a}\">−</button><input type=\"number\" min=\"0\" value=\"${counts[a]}\" data-a=\"${a}\"><button data-step=\"1\" data-a=\"${a}\">+</button></div></div>`).join('');\n  talos.kit.count('#total', Object.values(counts).reduce((x, y) => x + y, 0));\n}\ndocument.getElementById('app').addEventListener('input', e => { const a = e.target.dataset.a; if (a == null) return; counts[a] = Math.max(0, Number(e.target.value) || 0); talos.store.set('counts', counts); talos.kit.count('#total', Object.values(counts).reduce((x, y) => x + y, 0)); });\ndocument.getElementById('app').addEventListener('click', e => { if (e.target.closest('[data-act=csv]')) talos.download('inventur-lager-b.csv', 'Artikel;Anzahl\\n' + D.articles.map(a => `${a};${counts[a]}`).join('\\n')); });",
  "jsInit": ["render()"],
  "data": { "articles": ["Schrauben M6", "Muttern M6", "Unterlegscheiben", "Dübel 8 mm"] },
  "sources": [{ "kind": "user", "label": "Artikel aus deiner Nachricht" }]
}
```

## Example – live markdown preview

```json
{
  "title": "Release Notes – Entwurf",
  "initialHeight": 380,
  "html": "<div class=\"t-split\" style=\"grid-template-columns:1fr 1fr\"><div class=\"t-stack\"><textarea id=\"src\" rows=\"12\" style=\"width:100%;font-family:var(--talos-mono);font-size:13px\"></textarea><div class=\"t-row\"><span class=\"t-note\" id=\"stats\"></span><button class=\"t-btn sm\" id=\"copy\">Kopieren</button></div></div><div class=\"t-prose\" id=\"out\"></div></div>",
  "js": "const src = document.getElementById('src');\nsrc.value = talos.store.get('text', window.TALOS_DATA.text);\nfunction render() { document.getElementById('out').innerHTML = talos.md(src.value); const w = src.value.trim().split(/\\s+/).filter(Boolean).length; document.getElementById('stats').textContent = `${w} Wörter`; }\nsrc.addEventListener('input', () => { talos.store.set('text', src.value); render(); });\ndocument.getElementById('copy').addEventListener('click', () => talos.copy(src.value));",
  "jsInit": ["render()"],
  "data": { "text": "## Version 2.4\n\n- **Neu:** Export als CSV\n- Schnellere Suche\n- [ ] Doku aktualisieren" },
  "sources": []
}
```
