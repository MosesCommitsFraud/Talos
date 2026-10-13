# Libraries for interactive answers

Served by Talos itself to the sandboxed frames of `render_ui` answers
(`src/interactive_ui.py`, `web/src/lib/uiFrame.ts`), so no public CDN is
contacted. Regenerate with `python scripts/vendor_ui_libs.py`; each tarball is
checked against the npm registry's sha512 integrity before extraction.

| Library | Version | License | Source |
|---|---|---|---|
| Apache ECharts | 5.5.1 | Apache-2.0 (`echarts@5.5.1/LICENSE`) | npm `echarts` |
| D3 | 7.9.0 | ISC (`d3@7.9.0/LICENSE`) | npm `d3` |
| Chart.js | 4.4.4 | MIT (`chart.js@4.4.4/LICENSE.md`) | npm `chart.js` |
| three.js | 0.169.0 | MIT (`three@0.169.0/LICENSE`) | npm `three` |
| Leaflet | 1.9.4 | BSD-2-Clause (`leaflet@1.9.4/LICENSE`) | npm `leaflet` |
| Mermaid | 11.15.0 | MIT | copied from `docs/javascripts/mermaid.min.js` |

Map tiles are not vendored: they come from the tile server configured in the
settings (OpenStreetMap by default, used under its tile usage policy —
https://operations.osmfoundation.org/policies/tiles/).
