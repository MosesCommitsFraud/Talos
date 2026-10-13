---
name: ui-diagrams
description: "Diagrams in the chat: processes, approval flows, architectures, system landscapes, org charts, sequences, state machines, entity relations, mind maps and timelines – as render_widget diagram (Mermaid) or timeline, or a custom SVG in render_ui when the layout matters. Use with interactive-answers whenever structure or flow is explained."
requires-tools: render_ui, render_widget
keywords: ablauf, ablaufdiagramm, flussdiagramm, prozess, prozesse, freigabe, workflow, architektur, organigramm, struktur, sequenz, zeitstrahl, meilensteine, flowchart, process, architecture, timeline, mermaid
---

# Diagrams in the chat

## Pick the form

| Explaining … | Use |
|---|---|
| a process, approval flow, decision path | `render_widget` `diagram`, Mermaid `flowchart LR` (TD for long chains) |
| who talks to whom, in which order | `diagram`, `sequenceDiagram` |
| states and transitions | `diagram`, `stateDiagram-v2` |
| data model / tables | `diagram`, `erDiagram` |
| a topic map / breakdown | `diagram`, `mindmap` |
| dates and milestones | `render_widget` `timeline` (not Mermaid) |
| a layout that must look a specific way (rack, floor plan, custom architecture with zones) | `render_ui` with an inline SVG |

Talos renders Mermaid in its own colours and font, at natural size (wide
diagrams scroll sideways) – never style Mermaid yourself (no `%%{init}`,
no `style`/`classDef` colours).

## Writing good Mermaid

- Short labels (2–4 words) in the user's language; details go in the text.
- IDs without spaces, labels in brackets: `A[Antrag stellen]`,
  decisions `B{Betrag > 5.000 €?}`, edge labels `-- ja -->`.
- Quote labels with special characters: `C["Freigabe (Leitung)"]`.
- ≤ 15 nodes per diagram; split bigger flows or group with `subgraph`.
- Left-to-right for processes, top-down for hierarchies.
- No HTML in labels, no click handlers.

## Custom SVG (render_ui)

Inline `<svg viewBox="0 0 W H" width="100%">`, shapes `fill:
var(--talos-surface)`, `stroke: var(--talos-accent)` or `var(--talos-border)`,
text `fill: var(--talos-fg)` (secondary `var(--talos-muted)`), font
`var(--talos-font)` at 12–14 px. Keep it readable at 360 px width or make the
container scroll (`overflow-x:auto`).

## Example – approval process

```json
{
  "type": "diagram",
  "title": "Freigabe einer Bestellung",
  "data": {"mermaid": "flowchart LR\n  A[Bedarf] --> B{Betrag > 5.000 €?}\n  B -- nein --> C[Einkauf bestellt]\n  B -- ja --> D[Freigabe Leitung]\n  D --> C\n  C --> E[(ERP)]"},
  "sources": [{"kind": "knowledge", "label": "Einkaufsrichtlinie", "ref": "Richtlinie_Einkauf.pdf, Kap. 3"}]
}
```

## Example – project timeline

```json
{
  "type": "timeline",
  "title": "Projektverlauf",
  "data": {"events": [
    {"date": "2025-01", "title": "Kick-off", "status": "done"},
    {"date": "2025-09", "title": "Rollout", "text": "Verzögert durch Lieferengpass.", "status": "risk"},
    {"date": "2026-01", "title": "Abnahme"}
  ]},
  "sources": [{"kind": "user", "label": "Projektplan aus deiner Nachricht"}]
}
```
