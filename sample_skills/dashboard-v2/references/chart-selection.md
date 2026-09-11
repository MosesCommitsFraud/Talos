# Select from the ECharts gallery

Search these families/terms in the offline index, then read candidate sources.
This is an orientation map, not an exhaustive list or a prescribed chart mix.
The generated categories.tsv and index.tsv are the complete snapshot catalog.

| Reader's question | Families and variations to investigate | Selection criterion |
| --- | --- | --- |
| How does it change over time? | line, area, step, time-axis, confidence band, themeRiver | Ordered observations; bands need defensible bounds, streamgraphs emphasize mix rather than exact levels. |
| Who leads and how does rank change? | sorted bar, lollipop/custom, polar bar, bar-race, slope | Race only when temporal ordering matters; keep a readable static state. |
| Where are the deviations? | waterfall/custom, dumbbell/custom, diverging bar, heatmap, markArea | Make baseline and sign explicit. |
| What is the composition? | stacked bar/area, pie/donut, rose, treemap, sunburst | Treemap for relative size; sunburst for hierarchical paths; pies for a few parts. |
| How is it organized? | tree, radial tree, sunburst, treemap drill-down | Tree shows parent-child links, treemap shows weight. |
| Who is connected? | graph force/circular, chord, adjacency heatmap | Graph for topology, chord for relationship volumes, matrix for dense pairwise comparisons. |
| Where does volume flow? | sankey, chord, lines/effectScatter over geo | Flow conservation and direction must be meaningful. |
| How do many variables relate? | scatter/bubble, parallel, scatter matrix, radar | Parallel with brushing for profiles; normalize radar axes deliberately. |
| What does the distribution look like? | boxplot, histogram/custom, violin/custom, scatter jitter | Use raw observations or documented summary statistics. |
| When is activity concentrated? | calendar heatmap/scatter/pie, punch-card, heatmap | Calendar for actual dates; heatmap for two categorical dimensions. |
| Where is it happening? | map, geo, SVG map, lines, effectScatter, geographic heatmap | Need inline geography; use rates when population/area would distort counts. |
| How do price and volume move? | candlestick/OHLC, linked grids, dataZoom, axisPointer | Check OHLC order in source; align dates and units. |
| How close are we to the target? | gauge, bullet/custom, progress ring, pictorialBar | A KPI may be clearer; target and denominator must be visible. |
| Which stage loses volume? | funnel, sankey | Funnel is an ordered conversion process, not a generic ranking. |
| How do phases overlap? | custom Gantt, interval series, timeline | ECharts timeline is an option-switching component, not a Gantt series. |
| How do charts fit a table-like arrangement? | matrix, multiple grids, calendar coordinates, small multiples | Coordinate systems can contain several charts; check version and alignment. |
| Is a special shape analytically useful? | custom renderItem, graphic, pictorialBar, rich labels | Custom series provides data-driven marks; graphic provides annotations. |
| Is a third spatial dimension real? | scatter3D, bar3D, line3D, surface, globe, map3D, graphGL, flowGL | Requires GL extension and WebGL. Avoid perspective merely for decoration. |

Also search interactions and compositions, not just series names:
`dataset`, `encode`, `transform`, `dataZoom`, `brush`, `visualMap`, `timeline`,
`universalTransition`, `drill-down`, `graphic`, `markLine`, `markPoint`,
`markArea`, linked axes, multiple grids, rich text and responsive `media`.
One series family has many useful variants; a new hardcoded shortlist would
recreate the original selection problem.
