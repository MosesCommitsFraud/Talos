# Design a BI report that supports a decision

Use this before implementation; translate the brief into a concrete design.
The target look is a professional BI dashboard (Power BI style) in macs colours
— see macs-brand.md. The grid of tiles is the right structure; quality comes
from hierarchy, consistent colour meaning, honest comparisons and clean detail.

## Audience and evidence

Identify who reads the page, what decision it supports and how frequently the
information is used. Prioritize a main finding, contextual evidence and optional
detail. Give important metrics an honest comparison: target, prior period or
benchmark. If none exists, state the limitation instead of inventing a target.
Write tile titles that name measure and dimension, and show units, period,
source and data freshness. Status needs labels as well as colour.

Adapted from [NickCrew's dashboard-designer](https://github.com/NickCrew/Claude-Cortex/blob/main/skills/dashboard-designer/SKILL.md).
Its KPI reasoning and information hierarchy apply here.

## Layout hierarchy

Read top-left to bottom-right: header → filter context → KPIs → main visual →
supporting visuals → detail table. Size tiles by importance instead of making
every tile equal: the most important visual gets the largest tile in the first
row below the KPIs. Group related visuals next to each other and align their
axes where they share a dimension (e.g. two monthly charts on the same x-range).
Keep 3–5 KPIs and roughly 3–6 visuals per page; split into several pages if more
is needed rather than shrinking everything.

## Work with the canvas

For 16:9 and A4 fit header, KPIs and visuals exactly into the canvas with no
scrolling. For `web`, use a responsive grid. Keep essential labels close to
their data. Refine crowding, overlaps and margins after viewing the actual page
and PNG. Keep meaningful data legible (min. 11px).

## Talos implementation choices

Use `td.compose` with authored `layout_html` and `css`. Build the grid with CSS
grid; tiles are plain HTML elements around `{{chart:id}}`. KPI cards are HTML
(value, label, comparison), optionally with a small sparkline chart.

Before delivery, ask of the rendered result: Is the main finding visible at a
glance? Does each measure keep its colour everywhere? Are comparisons truthful?
Can the reader follow it without hovering? Is the PNG complete at the requested
size? Export controls are provided by Talos and must not occupy the page.
