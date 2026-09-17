# Design, formats and downloads

HTML is always the deliverable, with working charts and interactions. Use
`td.compose(...)`; it enables PNG rendering without inserting controls.
HTML and PNG download buttons belong to the Talos preview toolbar. Never author
download controls in the HTML. PNG includes the entire composition, not just
one ECharts canvas. Standalone HTML stays interactive; reopen it in Talos to use
the UI export, or call `window.TALOS_EXPORT.png()` in a rendering/test workflow.

## Choose a canvas

| `page_format` | Layout dimensions (CSS px) | PNG pixels | Use |
| --- | --- | --- | --- |
| `web` | Responsive width and full content height | 2× current layout size | Interactive scrolling HTML, default |
| `16:9` | 1280 × 720 | 1920 × 1080 | Presentation or widescreen dashboard |
| `a4` | 794 × 1123 | 2480 × 3508 | A4 portrait, pixel dimensions for 300 dpi printing |
| `a4-landscape` | 1123 × 794 | 3508 × 2480 | A4 landscape |

Fixed formats retain their composition and scale down as a whole in a narrow
preview; they do not reflow into a long page. PNG output stays at the specified
resolution regardless of preview zoom. These are single canvases. If the story
needs more space, reduce the content or create additional HTML pages, each
exportable through Talos. The exporter rejects overflowing fixed pages instead of silently
cropping. A4 pixel dimensions do not imply embedded printer DPI metadata.

## Composition

The page structure, rules and complete example are in SKILL.md. For fixed
formats (`16:9`, A4) the canvas does not reflow: give panels explicit sizes
with format-specific selectors such as
`body[data-page-format="a4"] #td-artboard .panels {grid-template-columns: 1fr}`
and keep the content short enough to fit.

## Export fidelity

PNG captures the current theme and chart selection. Keep meaningful labels and
units visible without hover. Embed images as data URIs and fonts locally/inline;
remote resources are unavailable. The exporter rasterizes HTML/CSS through SVG, so exotic
filters, blending, masks and some CSS effects can differ from the live page.
Use straightforward CSS for export-critical designs and inspect the downloaded
PNG, not only the browser preview. ECharts charts are captured through their
own image export, including GL when supported by the browser. GL graphics are
captured at the browser's native resolution and scaled within the final PNG.

Fix blank graphics, cropped text, overlaps or overflow before delivering.
The HTML download remains interactive; PNG does not preserve tooltips or links.
Do not substitute PNG for HTML unless the user explicitly requests that.
