# Design a decision-oriented composition

Use this before implementation; translate the brief into a concrete design.
The user has rejected uniform tile dashboards. Merely removing rounded corners
or recolouring a repeated grid does not address that feedback.

## Audience and evidence

Identify who reads the page, what decision it supports and how frequently the
information is used. Prioritize a main finding, contextual evidence and optional
detail. Give important metrics an honest comparison: target, prior period or
benchmark. If none exists, state the limitation instead of inventing a target.
Write titles that express supported findings, and show units, period, source
and data freshness. Status needs labels as well as colour. A quick glance should
reveal the most important message.

Adapted from [NickCrew's dashboard-designer](https://github.com/NickCrew/Claude-Cortex/blob/main/skills/dashboard-designer/SKILL.md).
Its KPI reasoning and information hierarchy are useful here; its stock tile
wireframes, BI-tool selection and rigid chart-count rules are not adopted.

## Art direction tied to the subject

Choose a visual character from the actual topic and audience. Describe the
reading path, the dominant element, type roles, colours and alignment before
writing CSS. Compare two spatial ideas instead of reaching for the same default.
Spend expressive detail in one place and keep supporting material restrained.
Borders, labels and decorative devices must communicate a relationship. Check
the first draft against the brief and revise choices that could have come from
any unrelated dashboard. Respect provided branding and accessibility.

Adapted from [Anthropic's frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md).
Use its deliberate direction and self-critique; do not replace the user's
requirements with arbitrary font bans, obligatory animation or a new fixed style.

## Work with the canvas

For 16:9 and A4, arrange the information as one balanced composition. Use scale,
spacing and alignment to express importance. Keep essential labels close to
their data. Refine crowding, overlaps and margins after viewing the actual page
and PNG rather than adding more decoration. Keep meaningful data legible.

Adapted from [Anthropic's canvas-design](https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md).
Only its composition and refinement principles apply: this remains an
interactive, truthful data artifact, not abstract artwork or a PNG-only output.

## Talos implementation choices

Use `td.compose` with authored `layout_html` and `css`. Select a structure that
follows the question, such as a dominant geographic view with margin notes,
a flow diagram with stage-specific annotations, a comparison across a shared
baseline, or a briefing with a large chart alongside interpretation. These are
directions to explore, not templates to cycle mechanically.

Keep related graphics on shared visual axes when useful. Let supporting numbers
sit within the explanation rather than isolating every number in a box. Use
panels only where enclosure clarifies grouping. If the user asks for a dense
operational grid, follow that brief; otherwise do not silently fall back to one.

Before delivery, ask of the rendered result: Is the main finding clear? Does the
layout communicate actual relationships? Are comparisons truthful? Can the
reader follow it without hovering? Is the PNG complete at the requested size?
Fix the design itself if these checks fail. Export controls are provided by
Talos and must not occupy the composition.
