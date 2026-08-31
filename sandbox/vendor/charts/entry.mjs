/* Talos dashboard chart runtime — the browser half of talos_dash.py.
 *
 * esbuild bundles this file together with TanStack Charts into one IIFE
 * (`window.TalosCharts`) at sandbox image build time. The generated dashboard
 * inlines that bundle: the workspace has no network and the preview iframe runs
 * under a CSP that blocks every outbound request, so a <script src> is a
 * permanently blank page.
 *
 * Python emits a declarative spec per chart — `{"type": "hbar", "categories":
 * [...], "values": [...], ...}` — and `mount()` translates it into a TanStack
 * chart definition. The split exists because a chart definition is made of
 * functions (scale factories, formatters, channel accessors) and JSON cannot
 * carry a function. Everything that has to be a function lives here; everything
 * that varies per dashboard stays data.
 */

import {
  areaY,
  barX,
  barY,
  cell,
  colorGradientLegend,
  colorLegend,
  d3Curve,
  defineChart,
  dot,
  group,
  lineY,
  linearRegressionY,
  link,
  mosaicY,
  mountChart,
  rect,
  rollingWindow,
  ruleY,
  stack,
  text,
  violinY,
  waffleY,
  boxY,
  binY,
  normalize,
} from '@tanstack/charts'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { scalePoint } from '@tanstack/charts/scales/point'
import { tooltip } from '@tanstack/charts/tooltip'
import {
  angleGrid,
  pie as pieAngles,
  polar,
  radialArc,
  radialArea,
  radialGrid,
  radialLine,
  radialText,
} from '@tanstack/charts/polar'
import { treemap as treemapMark } from '@tanstack/charts/hierarchy/treemap'
import { sankeyDiagram } from '@tanstack/charts/network/sankey'
import { scaleQuantize, scaleUtc } from 'd3-scale'
import { curveLinearClosed, curveMonotoneX } from 'd3-shape'

/* ── Colour ──────────────────────────────────────────────────────────────
 * Colours arrive as tokens ("@series1", "@good") and leave as CSS custom
 * properties. The page defines each variable twice — once for a light card,
 * once for a dark one — so the *browser* picks the step that matches the
 * surface the chart is actually being viewed on, and a theme toggle repaints
 * without the page rebuilding a single chart definition. Resolving to hex here
 * would move that decision to render time, where the answer is not yet known.
 */
const VAR = {
  muted: 'var(--td-muted)',
  good: 'var(--td-good)',
  warning: 'var(--td-warning)',
  critical: 'var(--td-critical)',
  surface: 'var(--td-surface)',
  ink: 'var(--td-ink)',
  ink2: 'var(--td-ink2)',
  grid: 'var(--td-grid)',
  base: 'var(--td-base)',
}

const SERIES = Array.from({ length: 8 }, (_, i) => `var(--td-s${i + 1})`)
const SEQ = Array.from({ length: 5 }, (_, i) => `var(--td-q${i + 1})`)

function color(token) {
  if (typeof token !== 'string' || token.charAt(0) !== '@') return token
  const key = token.slice(1)
  let m = /^series(\d+)$/.exec(key)
  if (m) return SERIES[(parseInt(m[1], 10) - 1) % SERIES.length]
  m = /^seq(\d+)$/.exec(key)
  if (m) return SEQ[Math.min(parseInt(m[1], 10) - 1, SEQ.length - 1)]
  return key in VAR ? VAR[key] : token
}

/** Scene text, gridlines and the transparent plot background. The card behind
 *  the chart is the surface — a painted chart background would double it. */
const THEME = {
  foreground: VAR.ink2,
  muted: VAR.muted,
  grid: VAR.grid,
  background: 'transparent',
  palette: SERIES,
}

/* ── Number formatting ───────────────────────────────────────────────────
 * A format spec is `{unit, decimals, compact, percent, locale}`. It exists so
 * axis and label formatting survives the trip through JSON: `Intl` lives here,
 * the choice lives in Python.
 */
function formatter(spec, locale) {
  const f = spec || {}
  const loc = f.locale || locale || 'de-DE'
  const opts = { maximumFractionDigits: f.decimals == null ? 2 : f.decimals }
  if (f.decimals != null) opts.minimumFractionDigits = f.decimals
  if (f.compact) {
    opts.notation = 'compact'
    opts.maximumFractionDigits = f.decimals == null ? 1 : f.decimals
    delete opts.minimumFractionDigits
  }
  const nf = new Intl.NumberFormat(loc, opts)
  const unit = f.percent ? '%' : f.unit || ''
  return (value) => {
    if (value == null || !Number.isFinite(Number(value))) return ''
    const text = nf.format(Number(value))
    return unit ? `${text} ${unit}` : text
  }
}

const fmtDate = (value, locale) =>
  value instanceof Date ? value.toLocaleDateString(locale) : String(value)

/** Tick text for a date axis, at the granularity the span deserves. */
function dateTicks(rows, locale) {
  const times = rows.flatMap((r) => [r.start.getTime(), r.end.getTime()])
  const days = (Math.max(...times) - Math.min(...times)) / 86400000
  const opts =
    days > 730
      ? { year: 'numeric', month: 'short' }
      : days > 45
        ? { month: 'short', year: '2-digit' }
        : { day: '2-digit', month: 'short' }
  const df = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' })
  return (value) => (value instanceof Date ? df.format(value) : String(value))
}

/** The axis a reader can hold in their head: one unit for the whole axis,
 *  short ticks, and no "0 · 5.000 · 10k" mixture of magnitudes — `compact`
 *  notation is applied to every tick or to none. */
function axisFrom(spec, locale, fallbackFormat) {
  const s = spec || {}
  const axis = { line: false }
  const fmt = s.format || fallbackFormat
  axis.ticks = fmt ? { format: formatter(fmt, locale) } : {}
  if (s.ticks) axis.ticks.count = s.ticks
  if (s.label) axis.label = s.label
  if (s.rotate) axis.tickLabels = { rotate: s.rotate }
  else axis.tickLabels = { thin: { minGap: s.min_gap || 8, priority: 'ends' } }
  return axis
}

/** The quantitative scale for one axis.
 *
 *  `min`/`max` pin the domain — `min: 0` above all. Charts infers a domain from
 *  the data otherwise, which is right for a scatter and wrong for a bar chart
 *  read as magnitude: a baseline at the smallest observed value turns a 4%
 *  spread into a cliff. A pinned domain must be a configured instance; a
 *  factory hands inference back to the chart. */
function linearScale(spec, values) {
  const s = spec || {}
  if (s.min == null && s.max == null) return { scale: scaleLinear, nice: true }
  const finite = (values || []).filter((v) => v != null && Number.isFinite(v))
  const lo = s.min != null ? s.min : Math.min(...finite, 0)
  const hi = s.max != null ? s.max : Math.max(...finite, lo + 1)
  return { scale: scaleLinear().domain([lo, hi]).nice() }
}

/* ── Row shaping ─────────────────────────────────────────────────────────
 * Every mark here consumes rows of objects, while the Python API takes the
 * shape a query result actually has: a list of categories and one or more
 * parallel lists of numbers. These two helpers are the whole bridge.
 */
const longRows = (categories, series) => {
  const rows = []
  categories.forEach((c, i) => {
    series.forEach((s) => {
      rows.push({ c, s: s.name, v: s.data[i] == null ? null : s.data[i], i })
    })
  })
  return rows
}

const wideRows = (categories, values) =>
  categories.map((c, i) => ({ c, v: values[i] == null ? null : values[i], i }))

/** Categorical identity for a discrete scale.
 *
 *  Band and point domains de-duplicate, so two rows sharing a label collapse
 *  into one mark. Every categorical domain here is therefore built from the
 *  authored order and passed as a configured instance — which also fixes the
 *  order, and for a sorted bar chart the order *is* the ranking. */
const bandScale = (domain, padding) =>
  scaleBand().domain(domain).padding(padding == null ? 0.2 : padding)

const legendFor = (spec, count, label) =>
  count > 1 && spec.legend !== false ? colorLegend({ label: label || '' }) : undefined

const seriesList = (spec) =>
  (spec.series || []).map((s) => ({ name: String(s.name), data: s.data || [] }))

/** The numbers on the quantitative axis, whatever shape the spec carries them
 *  in. Only used to complete a half-pinned domain (`min: 0` and nothing else),
 *  so it wants the plotted measure and not every number in the spec. */
function numbersOf(spec) {
  if (spec.values) return spec.values
  if (spec.low && spec.high) return spec.low.concat(spec.high)
  if (spec.before && spec.after) return spec.before.concat(spec.after)
  if (spec.series) return spec.series.flatMap((s) => s.data || [])
  if (spec.bars) return spec.bars.flatMap((b) => [b.y1, b.y2])
  if (spec.cells) return spec.cells.map((c) => c[2])
  if (spec.days) return spec.days.map((d) => d[2])
  if (spec.bins) return spec.bins.map((b) => b[2])
  if (spec.points) return spec.points.map((p) => p[1])
  if (spec.groups) return spec.groups.flat()
  return []
}

/* ── Builders ────────────────────────────────────────────────────────────
 * One per spec type. Each returns a complete chart definition. They are kept
 * flat and repetitive on purpose: a shared "cartesian base" that every type
 * bends around costs more to read than the four lines it saves.
 */
const BUILD = {}

BUILD.line = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const series = seriesList(spec)
  const rows = longRows(cats, series)
  const marks = []
  if (spec.area_first && series.length) {
    const first = rows.filter((r) => r.s === series[0].name)
    marks.push(
      areaY(first, {
        x: 'c',
        y: 'v',
        fill: color('@series1'),
        fillOpacity: 0.14,
        curve: d3Curve(curveMonotoneX),
      }),
    )
  }
  marks.push(
    lineY(rows, {
      x: 'c',
      y: 'v',
      z: 's',
      color: 's',
      strokeWidth: 2,
      // A rolling mean is drawn over the raw line, never instead of it: the
      // point of the smoothing is the contrast between the two.
      strokeOpacity: spec.rolling ? 0.35 : 1,
      curve: spec.smooth === false ? undefined : d3Curve(curveMonotoneX),
    }),
  )
  if (spec.rolling) {
    const smoothed = rollingWindow(rows, {
      by: 's',
      size: spec.rolling,
      anchor: 'end',
      partial: true,
      outputs: { mean: { reduce: 'mean', value: 'v' } },
    })
    marks.push(
      lineY(smoothed, {
        x: 'c',
        y: 'mean',
        z: 's',
        color: 's',
        strokeWidth: 2.5,
        curve: d3Curve(curveMonotoneX),
      }),
    )
  }
  return definition(spec, ctx, {
    marks,
    scales: {
      x: { scale: scalePoint().domain(cats).padding(0.06), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
    color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, series.length) },
    focus: 'group-x',
  })
}

BUILD.area = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const rows = wideRows(cats, spec.values)
  return definition(spec, ctx, {
    marks: [
      areaY(rows, {
        x: 'c',
        y: 'v',
        fill: color('@series1'),
        fillOpacity: 0.18,
        curve: d3Curve(curveMonotoneX),
      }),
      lineY(rows, { x: 'c', y: 'v', stroke: color('@series1'), strokeWidth: 2, curve: d3Curve(curveMonotoneX) }),
    ],
    scales: {
      x: { scale: scalePoint().domain(cats).padding(0.02), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
    focus: 'group-x',
  })
}

BUILD.bar = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const rows = wideRows(cats, spec.values)
  const hi = spec.highlight
  const paint = (row) =>
    hi == null || row.c === hi || row.i === hi ? color('@series1') : color('@muted')
  const marks = [barY(rows, { x: 'c', y: 'v', fill: paint, radius: 4, maxThickness: 44 })]
  if (spec.label !== false) {
    // Direct labels are the relief for the palette slots that sit under 3:1
    // against a light card: identity must not rest on colour alone.
    marks.push(
      text(rows, {
        x: 'c',
        y: 'v',
        text: (row) => ctx.value(row.v),
        anchor: 'middle',
        dy: -8,
        fontSize: 11,
        fill: VAR.ink2,
      }),
    )
  }
  return definition(spec, ctx, {
    marks,
    scales: {
      x: { scale: bandScale(cats, 0.24), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.hbar = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const rows = wideRows(cats, spec.values)
  return definition(spec, ctx, {
    marks: [
      barX(rows, { x: 'v', y: 'c', fill: color('@series1'), radius: 3, maxThickness: 22 }),
      text(rows, {
        x: 'v',
        y: 'c',
        text: (row) => ctx.value(row.v),
        anchor: 'start',
        dx: 6,
        fontSize: 11,
        fill: VAR.ink2,
      }),
    ],
    scales: {
      y: { scale: bandScale(cats, 0.3), axis: axisFrom(spec.y, ctx.locale) },
      x: { ...linearScale(spec.x, ctx.numbers), grid: true, axis: axisFrom(spec.x, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.grouped_bar = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const series = seriesList(spec)
  const rows = longRows(cats, series)
  return definition(spec, ctx, {
    marks: [
      barY(rows, { x: 'c', y: 'v', z: 's', color: 's', layout: group({ padding: 0.08 }), radius: 3 }),
    ],
    scales: {
      x: { scale: bandScale(cats, 0.2), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
    color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, series.length) },
  })
}

BUILD.stacked_bar = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const series = seriesList(spec)
  const rows = longRows(cats, series)
  const order = series.map((s) => s.name)
  return definition(spec, ctx, {
    marks: [
      barY(rows, {
        x: 'c',
        y: 'v',
        z: 's',
        color: 's',
        layout: stack({ order }),
        // A 2px ring in the surface colour separates adjacent segments, so the
        // boundary is structural rather than a hue change the eye has to find.
        stroke: VAR.surface,
        strokeWidth: 2,
      }),
    ],
    scales: {
      x: { scale: bandScale(cats, 0.24), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
    color: { domain: order, range: SERIES, legend: legendFor(spec, series.length) },
  })
}

BUILD.waterfall = (spec, ctx) => {
  // Python has already resolved every bar into an explicit [y1, y2] interval
  // and a role, so the browser draws exactly what was computed — no transparent
  // spacer series, and no running total recomputed twice in two languages.
  const rows = spec.bars.map((b, i) => ({ ...b, i }))
  const cats = rows.map((r) => String(r.label))
  const paint = (row) =>
    row.role === 'total' ? color('@series1') : row.role === 'rise' ? color('@good') : color('@critical')
  return definition(spec, ctx, {
    marks: [
      barY(rows, { x: 'label', y1: 'y1', y2: 'y2', fill: paint, radius: 2, maxThickness: 46 }),
      ruleY([0], { stroke: VAR.base }),
      text(rows, {
        x: 'label',
        y: (row) => Math.max(row.y1, row.y2),
        text: (row) => ctx.value(row.delta),
        anchor: 'middle',
        dy: -8,
        fontSize: 11,
        fill: VAR.ink2,
      }),
    ],
    scales: {
      x: { scale: bandScale(cats, 0.22), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.scatter = (spec, ctx) => {
  const rows = spec.points.map((p, i) => ({
    x: p[0],
    y: p[1],
    r: spec.sizes ? spec.sizes[i] : undefined,
    label: spec.labels ? spec.labels[i] : undefined,
    i,
  }))
  const marks = [
    dot(rows, {
      x: 'x',
      y: 'y',
      r: spec.sizes ? 'r' : 6,
      fill: color('@series1'),
      fillOpacity: 0.85,
      // A surface-coloured ring keeps overlapping dots countable.
      stroke: VAR.surface,
      strokeWidth: 2,
    }),
  ]
  if (spec.trend) {
    // The fit goes *under* nothing and over the dots: it is a claim about the
    // cloud, and the reader has to be able to see the cloud disagree with it.
    marks.push(
      linearRegressionY(rows, {
        x: 'x',
        y: 'y',
        ci: 0.95,
        stroke: color('@series2'),
        strokeWidth: 2,
      }),
    )
  }
  return definition(spec, ctx, {
    marks,
    scales: {
      x: { scale: scaleLinear, nice: true, grid: true, axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.heatmap = (spec, ctx) => {
  const rows = spec.cells.map((c) => ({
    x: String(spec.x_labels[c[0]]),
    y: String(spec.y_labels[c[1]]),
    v: c[2],
  }))
  const values = rows.map((r) => r.v).filter((v) => v != null)
  const low = spec.low != null ? spec.low : Math.min(...values, 0)
  const high = spec.high != null ? spec.high : Math.max(...values, 1)
  const marks = [cell(rows, { x: 'x', y: 'y', color: 'v', inset: 1, radius: 2 })]
  if (rows.length <= 60) {
    marks.push(
      text(rows, {
        x: 'x',
        y: 'y',
        text: (row) => ctx.value(row.v),
        fontSize: 10,
        // The ramp runs light-to-dark on a white card and dark-to-light on a
        // black one, so a fixed ink colour is unreadable in exactly one of the
        // two modes. The top half of the ramp always takes the card colour and
        // the bottom half always takes the ink — one rule, correct in both.
        fill: (row) =>
          row.v != null && high > low && (row.v - low) / (high - low) >= 0.5 ? VAR.surface : VAR.ink,
      }),
    )
  }
  return definition(spec, ctx, {
    marks,
    scales: {
      x: { scale: bandScale(spec.x_labels.map(String), 0.02), axis: axisFrom(spec.x, ctx.locale) },
      y: { scale: bandScale(spec.y_labels.map(String), 0.02), axis: axisFrom(spec.y, ctx.locale) },
    },
    color: {
      // Magnitude is one hue, light to dark. A rainbow ramp invents category
      // boundaries the data does not have.
      scale: scaleQuantize().domain([low, high]).range(SEQ),
      legend: spec.legend === false ? undefined : colorGradientLegend({ label: spec.unit || '' }),
    },
  })
}

const pieDefinition = (spec, ctx, inner) => {
  const rows = spec.labels.map((label, i) => ({ label: String(label), v: spec.values[i] }))
  const slices = pieAngles(rows, { value: 'v', gapAngle: 0.012 })
  const total = rows.reduce((sum, r) => sum + (r.v || 0), 0) || 1
  return definition(spec, ctx, {
    marks: [
      polar({
        inset: 8,
        radiusRatio: 0.86,
        // `radialArc` carries its own authored geometry, but the slice labels
        // are positioned through the angle and radius channels, and a channel
        // without a scale has nothing to map through. Radians in, radians out;
        // radius is expressed as a fraction of the resolved outer radius.
        scales: {
          angle: { scale: scaleLinear().domain([0, Math.PI * 2]) },
          radius: { scale: scaleLinear().domain([0, 1]) },
        },
        marks: [
          radialArc(slices, {
            innerRadius: inner ? ({ radius }) => radius * 0.58 : 0,
            cornerRadius: 3,
            color: 'label',
            key: 'label',
            stroke: VAR.surface,
            strokeWidth: 2,
          }),
          radialText(slices, {
            angle: (row) => row.angle,
            radius: () => (inner ? 0.79 : 0.7),
            // The share only. A scene text node is one line — a name and a
            // percentage in the same label run off the slice on one side and
            // out of the card on the other — and the legend already names the
            // slices.
            text: (row) => (row.value / total >= 0.04 ? `${Math.round((row.value / total) * 100)} %` : ''),
            key: 'label',
            fill: VAR.ink,
            fontSize: 12,
            fontWeight: 600,
          }),
        ],
      }),
    ],
    scales: { x: null, y: null },
    color: { domain: rows.map((r) => r.label), range: SERIES, legend: legendFor(spec, rows.length) },
  })
}

BUILD.pie = (spec, ctx) => pieDefinition(spec, ctx, false)
BUILD.donut = (spec, ctx) => pieDefinition(spec, ctx, true)

BUILD.radar = (spec, ctx) => {
  const axes = spec.indicators.map(String)
  const series = seriesList(spec)
  // Each metric is normalised against its own maximum before it reaches the
  // radius scale: a radar over raw units compares millimetres with millions and
  // draws a spike that means nothing.
  const rows = []
  series.forEach((s) => {
    axes.forEach((axis, i) => {
      const max = spec.maxes[i] || 1
      rows.push({ axis, s: s.name, r: s.data[i] == null ? null : s.data[i] / max, raw: s.data[i] })
    })
  })
  return definition(spec, ctx, {
    marks: [
      polar({
        radiusRatio: 0.74,
        scales: {
          angle: { scale: scalePoint().domain(axes), wrap: true },
          radius: { scale: scaleLinear().domain([0, 1]) },
        },
        guides: [
          radialGrid({ values: [0.25, 0.5, 0.75, 1], shape: 'polygon' }),
          angleGrid({ labels: true }),
        ],
        marks: series.flatMap((s, i) => {
          const own = rows.filter((r) => r.s === s.name)
          return [
            radialArea(own, {
              angle: 'axis',
              radius: 'r',
              curve: curveLinearClosed,
              fill: SERIES[i % SERIES.length],
              fillOpacity: 0.15,
            }),
            radialLine(own, {
              angle: 'axis',
              radius: 'r',
              curve: curveLinearClosed,
              stroke: SERIES[i % SERIES.length],
              strokeWidth: 2,
            }),
          ]
        }),
      }),
    ],
    scales: { x: null, y: null },
    color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, series.length) },
  })
}

BUILD.gauge = (spec, ctx) => {
  const value = Math.max(0, Math.min(spec.target, spec.value))
  const parts = [
    { id: 'value', v: value },
    { id: 'rest', v: Math.max(spec.target - value, 0) },
  ]
  // Three quarters of a circle, opening downward: the reading is the arc's
  // length against a track the eye can see the end of.
  const slices = pieAngles(parts, {
    value: 'v',
    startAngle: -Math.PI * 0.75,
    endAngle: Math.PI * 0.75,
  })
  return definition(spec, ctx, {
    marks: [
      polar({
        radiusRatio: 0.86,
        scales: {
          angle: { scale: scaleLinear().domain([0, 1]) },
          radius: { scale: scaleLinear().domain([0, 1]) },
        },
        marks: [
          radialArc(slices, {
            innerRadius: ({ radius }) => radius * 0.7,
            cornerRadius: 999,
            color: 'id',
            key: 'id',
          }),
          radialText([{ id: 'reading' }], {
            angle: 0,
            radius: 0,
            text: () => `${ctx.value(spec.value)}${spec.unit || ''}`,
            key: 'id',
            fill: VAR.ink,
            fontSize: 26,
            fontWeight: 650,
          }),
          radialText([{ id: 'name' }], {
            angle: 0,
            radius: 0.42,
            text: () => spec.name || '',
            key: 'id',
            fill: VAR.muted,
            fontSize: 12,
          }),
        ],
      }),
    ],
    scales: { x: null, y: null },
    color: { domain: ['value', 'rest'], range: [color('@series1'), VAR.grid] },
  })
}

BUILD.funnel = (spec, ctx) => {
  // A centred bar per stage rather than ECharts' trapezoid stack: the trapezoid
  // encodes each stage's volume as an area whose width the reader cannot
  // measure, and the stage-to-stage drop — the only thing a funnel is for — is
  // read off the widths anyway.
  const rows = spec.stages.map((label, i) => {
    const v = spec.values[i] || 0
    const first = spec.values[0] || 1
    return { label: String(label), v, half: v / 2, share: v / first }
  })
  const cats = rows.map((r) => r.label)
  const span = Math.max(...rows.map((r) => r.half), 1)
  return definition(spec, ctx, {
    marks: [
      rect(rows, {
        y: 'label',
        x1: (row) => -row.half,
        x2: 'half',
        fill: color('@series1'),
        radius: 3,
        inset: 3,
      }),
      // Outside the bar, never inside it: the last stage of a funnel is the
      // narrowest bar on the chart and the one whose number matters most, and
      // an inside label is exactly the one that gets clipped there.
      text(rows, {
        y: 'label',
        x: 'half',
        text: (row) => `${ctx.value(row.v)} (${Math.round(row.share * 100)} %)`,
        anchor: 'start',
        dx: 8,
        fill: VAR.ink2,
        fontSize: 11,
      }),
    ],
    scales: {
      y: { scale: bandScale(cats, 0.14), axis: { line: false, ticks: { size: 0 } } },
      x: { scale: scaleLinear().domain([-span, span]), axis: false },
    },
  })
}

BUILD.boxplot = (spec, ctx) => {
  const rows = []
  spec.groups.forEach((values, i) => {
    values.forEach((v, j) => rows.push({ c: String(spec.categories[i]), v, k: `${i}-${j}` }))
  })
  return definition(spec, ctx, {
    marks: [
      boxY(rows, {
        x: 'c',
        y: 'v',
        key: 'k',
        // The interquartile box is a filled shape, not an outline: filling it
        // with the card colour leaves whiskers and a median floating in space.
        fill: color('@seq1'),
        stroke: color('@series1'),
      }),
    ],
    scales: {
      x: { scale: bandScale(spec.categories.map(String), 0.3), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.histogram = (spec, ctx) => {
  const rows = spec.bins.map((b, i) => ({ x1: b[0], x2: b[1], count: b[2], i }))
  return definition(spec, ctx, {
    marks: [rect(rows, { x1: 'x1', x2: 'x2', y1: () => 0, y2: 'count', inset: 1, fill: color('@series1'), radius: 2 })],
    scales: {
      x: { scale: scaleLinear, nice: true, axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.treemap = (spec, ctx) =>
  definition(spec, ctx, {
    marks: [
      treemapMark(spec.nodes, {
        path: 'path',
        delimiter: '/',
        value: 'value',
        color: (node) => node.ancestorIds.at(-1) ?? node.id,
        label: 'name',
        inset: 1,
        stroke: VAR.surface,
        strokeWidth: 2,
        radius: 3,
      }),
    ],
    scales: { x: null, y: null },
    color: { range: SERIES },
    guides: false,
    margin: 0,
  })

BUILD.sankey = (spec, ctx) =>
  definition(spec, ctx, {
    marks: [
      sankeyDiagram({
        nodes: spec.nodes,
        links: spec.links,
        nodeKey: 'id',
        source: 'source',
        target: 'target',
        value: 'value',
        align: 'left',
        nodePadding: 22,
        inset: { left: 8, right: 8, top: 20, bottom: 10 },
        marks: ({ nodes, links }) => [
          link(links, {
            x1: 'x1',
            y1: 'y1',
            x2: 'x2',
            y2: 'y2',
            key: 'key',
            strokeWidth: (flow) => flow.width,
            strokeOpacity: 0.4,
            stroke: color('@series1'),
            // Default round caps on a band a hundred pixels wide bulge past
            // both node columns and read as a shape rather than a flow.
            lineCap: 'butt',
          }),
          rect(nodes, { x1: 'x0', x2: 'x1', y1: 'y0', y2: 'y1', key: 'key', inset: 0, fill: color('@series1') }),
          text(nodes, {
            x: 'x',
            y: (node) => node.y0 - 7,
            text: (node) => node.data.label,
            key: 'key',
            fill: VAR.ink2,
            fontSize: 11,
            fontWeight: 600,
          }),
        ],
      }),
    ],
    scales: { x: null, y: null },
    guides: false,
    margin: 0,
  })

BUILD.lollipop = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const rows = wideRows(cats, spec.values)
  return definition(spec, ctx, {
    marks: [
      // The stem keeps the common baseline that makes lengths comparable; the
      // dot carries the value. Far less ink than a bar for the same reading,
      // which is what makes forty categories survivable.
      link(rows, { x1: () => 0, x2: 'v', y1: 'c', y2: 'c', stroke: VAR.base, strokeWidth: 1.5 }),
      dot(rows, { x: 'v', y: 'c', r: 5, fill: color('@series1') }),
      text(rows, {
        x: 'v',
        y: 'c',
        text: (row) => ctx.value(row.v),
        anchor: 'start',
        dx: 10,
        fontSize: 11,
        fill: VAR.ink2,
      }),
    ],
    scales: {
      y: { scale: bandScale(cats, 0.3), axis: { line: false, ticks: { size: 0 } } },
      x: { ...linearScale(spec.x, ctx.numbers), grid: true, axis: axisFrom(spec.x, ctx.locale, ctx.numberFormat) },
    },
  })
}

BUILD.dumbbell = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const series = seriesList(spec)
  const [a, b] = series
  const pairs = cats.map((c, i) => ({ c, a: a.data[i], b: b.data[i] }))
  const points = longRows(cats, series)
  return definition(spec, ctx, {
    marks: [
      // The connector is the chart: its length is the gap, which is the number
      // the reader came for. Two bars side by side make them measure it twice.
      link(pairs, { x1: 'a', x2: 'b', y1: 'c', y2: 'c', stroke: VAR.base, strokeWidth: 2 }),
      dot(points, { x: 'v', y: 'c', color: 's', r: 6, stroke: VAR.surface, strokeWidth: 2 }),
    ],
    scales: {
      y: { scale: bandScale(cats, 0.4), axis: { line: false, ticks: { size: 0 } } },
      x: { ...linearScale(spec.x, ctx.numbers), grid: true, axis: axisFrom(spec.x, ctx.locale, ctx.numberFormat) },
    },
    color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, 2) },
  })
}

BUILD.slope = (spec, ctx) => {
  const ends = [String(spec.before_name), String(spec.after_name)]
  const rows = []
  spec.labels.forEach((label, i) => {
    rows.push({ e: ends[0], label: String(label), v: spec.before[i] })
    rows.push({ e: ends[1], label: String(label), v: spec.after[i] })
  })
  return definition(spec, ctx, {
    marks: [
      lineY(rows, { x: 'e', y: 'v', z: 'label', color: 'label', strokeWidth: 2 }),
      dot(rows, { x: 'e', y: 'v', z: 'label', color: 'label', r: 4 }),
      // Names live at the ends of their own line, so a slopegraph needs no
      // legend: crossing lines are the message, and a legend would make the
      // reader match colours across the crossings.
      text(rows, {
        x: 'e',
        y: 'v',
        text: (row) => `${row.label}  ${ctx.value(row.v)}`,
        anchor: (row) => (row.e === ends[0] ? 'end' : 'start'),
        dx: (row) => (row.e === ends[0] ? -8 : 8),
        fontSize: 11,
        fill: VAR.ink2,
      }),
    ],
    scales: {
      x: { scale: scalePoint().domain(ends).padding(0.5), axis: { line: false, ticks: { size: 0 } } },
      y: { ...linearScale(spec.y, ctx.numbers), grid: false, axis: false },
    },
    color: { domain: spec.labels.map(String), range: SERIES },
    legend: false,
  })
}

BUILD.stacked_area = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const series = seriesList(spec)
  const rows = longRows(cats, series)
  const order = series.map((s) => s.name)
  // A streamgraph gives up the shared baseline for readable band thicknesses:
  // right when the question is "how did the mix evolve", wrong when any single
  // band's level has to be read off an axis.
  const layout = spec.stream
    ? stack({ offset: 'wiggle', order: 'inside-out' })
    : stack({ order, offset: spec.percent ? 'normalize' : undefined })
  return definition(spec, ctx, {
    marks: [
      areaY(rows, {
        x: 'c',
        y: 'v',
        z: 's',
        color: 's',
        layout,
        fillOpacity: 0.9,
        curve: d3Curve(curveMonotoneX),
      }),
    ],
    scales: {
      x: { scale: scalePoint().domain(cats).padding(0.02), axis: axisFrom(spec.x, ctx.locale) },
      y: {
        ...linearScale(spec.y, ctx.numbers),
        grid: !spec.stream,
        axis: spec.stream ? false : axisFrom(spec.y, ctx.locale, ctx.numberFormat),
      },
    },
    color: { domain: order, range: SERIES, legend: legendFor(spec, series.length) },
    focus: 'group-x',
  })
}

BUILD.range_area = (spec, ctx) => {
  const cats = spec.categories.map(String)
  const rows = cats.map((c, i) => ({
    c,
    low: spec.low[i],
    high: spec.high[i],
    v: spec.line ? spec.line[i] : null,
  }))
  const marks = [
    areaY(rows, {
      x: 'c',
      y1: 'low',
      y2: 'high',
      fill: color('@series1'),
      fillOpacity: 0.18,
      curve: d3Curve(curveMonotoneX),
    }),
  ]
  if (spec.line) {
    marks.push(
      lineY(rows, { x: 'c', y: 'v', stroke: color('@series1'), strokeWidth: 2, curve: d3Curve(curveMonotoneX) }),
    )
  }
  return definition(spec, ctx, {
    marks,
    scales: {
      x: { scale: scalePoint().domain(cats).padding(0.02), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
    focus: 'group-x',
  })
}

BUILD.timeline = (spec, ctx) => {
  const rows = spec.tasks.map((t, i) => ({
    label: String(t.label),
    start: new Date(t.start),
    end: new Date(t.end),
    group: t.group == null ? String(t.label) : String(t.group),
    i,
  }))
  const lanes = []
  rows.forEach((r) => {
    if (!lanes.includes(r.label)) lanes.push(r.label)
  })
  return definition(spec, ctx, {
    marks: [
      rect(rows, {
        y: 'label',
        x1: 'start',
        x2: 'end',
        color: 'group',
        key: (row) => `${row.label}-${row.i}`,
        radius: 3,
        inset: 4,
      }),
    ],
    scales: {
      // A real time scale, not a category per bar: the gap between two phases
      // is information, and evenly spaced bands would erase it.
      x: {
        scale: scaleUtc,
        nice: true,
        grid: true,
        // The library's default tick text is English. Granularity follows the
        // span, so a two-week plan reads in days and a three-year programme in
        // months, both in the reader's locale.
        axis: { line: false, ticks: { format: dateTicks(rows, ctx.locale) } },
      },
      y: { scale: bandScale(lanes, 0.25), axis: { line: false, ticks: { size: 0 } } },
    },
    color: { range: SERIES, legend: spec.legend === false ? undefined : colorLegend({}) },
  })
}

BUILD.calendar = (spec, ctx) => {
  const rows = spec.days.map((d) => ({
    week: String(d[0]),
    day: WEEKDAYS[d[1]],
    v: d[2],
    date: d[3],
  }))
  const weeks = []
  // Week -> month name, taken from the first day seen in that week. The domain
  // has to stay one entry per week (that is the column), but "2026-07" as a
  // tick label is a week number nobody counts in; the month is what a reader
  // navigates a calendar by.
  const months = new Map()
  rows.forEach((r) => {
    if (!weeks.includes(r.week)) weeks.push(r.week)
    if (!months.has(r.week)) {
      months.set(r.week, new Date(`${r.date}T00:00:00Z`))
    }
  })
  const monthName = new Intl.DateTimeFormat(ctx.locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
  // Only the first week of each month carries the name. Without this every
  // surviving tick in a month repeats it — "März 26 · März 26 · März 26" reads
  // as three months rather than one.
  const labelled = new Set()
  let lastMonth = null
  weeks.forEach((week) => {
    const key = monthName.format(months.get(week))
    if (key !== lastMonth) {
      labelled.add(week)
      lastMonth = key
    }
  })
  const values = rows.map((r) => r.v).filter((v) => v != null)
  const low = spec.low != null ? spec.low : Math.min(...values, 0)
  const high = spec.high != null ? spec.high : Math.max(...values, 1)
  return definition(spec, ctx, {
    marks: [cell(rows, { x: 'week', y: 'day', color: 'v', inset: 1, radius: 2 })],
    scales: {
      x: {
        scale: bandScale(weeks, 0.06),
        // Thinned month names, not 52 week numbers: a grey band of "2026-07"
        // under a year of cells is something nobody reads.
        axis: {
          line: false,
          ticks: {
            size: 0,
            format: (week) => (labelled.has(week) ? monthName.format(months.get(week)) : ''),
          },
          tickLabels: { thin: { minGap: 12, priority: 'ends' } },
        },
      },
      y: { scale: bandScale(WEEKDAYS, 0.06), axis: { line: false, ticks: { size: 0 } } },
    },
    color: {
      scale: scaleQuantize().domain([low, high]).range(SEQ),
      legend: spec.legend === false ? undefined : colorGradientLegend({ label: spec.unit || '' }),
    },
  })
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

BUILD.mosaic = (spec, ctx) => {
  const rows = spec.cells.map((c) => ({ x: String(c[0]), y: String(c[1]), v: c[2] }))
  const cells = mosaicY(rows, { x: 'x', y: 'y', value: 'v', yOrder: spec.y_order })
  return definition(spec, ctx, {
    marks: [
      // Column width is the segment's size and segment height is its share, so
      // one rectangle's area is its absolute contribution — the thing a
      // 100 % stacked bar deliberately throws away.
      // `color: 'yValue'`, not `'y'`: the transform's `y` is the normalised
      // centre of the cell, so colouring by it gives every rectangle its own
      // hue instead of one hue per part.
      rect(cells, {
        x: 'x',
        x1: 'x1',
        x2: 'x2',
        y: 'y',
        y1: 'y1',
        y2: 'y2',
        color: 'yValue',
        inset: 1,
        stroke: VAR.surface,
        strokeWidth: 1,
      }),
    ],
    scales: {
      x: { scale: scaleLinear().domain([0, 1]), axis: false },
      y: { scale: scaleLinear().domain([0, 1]), axis: false },
    },
    color: { domain: spec.y_order, range: SERIES, legend: legendFor(spec, 2) },
  })
}

BUILD.waffle = (spec, ctx) => {
  const rows = spec.labels.map((label, i) => ({ label: String(label), v: spec.values[i] }))
  return definition(spec, ctx, {
    marks: [
      // Countable squares instead of angles: a reader can see "roughly one in
      // five" without estimating an arc, which is the one thing a pie is bad at.
      waffleY(rows, { y: 'v', color: 'label', unit: spec.unit, round: true, gap: 2, radius: 2 }),
    ],
    scales: { x: null, y: null },
    color: { domain: rows.map((r) => r.label), range: SERIES, legend: legendFor(spec, rows.length) },
    // `guides: false` but no `margin: 0`: the cells should fill the card, and
    // the legend still needs its own band above them or it prints over the
    // first row of squares.
    guides: false,
  })
}

BUILD.violin = (spec, ctx) => {
  const rows = []
  spec.groups.forEach((values, i) => {
    values.forEach((v, j) => rows.push({ c: String(spec.categories[i]), v, k: `${i}-${j}` }))
  })
  // `violinY` mirrors *prepared* widths — it does not estimate a density. The
  // binning and the per-category normalisation are the caller's job, and doing
  // them here is what keeps the Python side able to hand over raw observations.
  const all = rows.map((r) => r.v)
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const step = (hi - lo) / 18 || 1
  const thresholds = Array.from({ length: 19 }, (_, i) => lo + i * step)
  const profiles = normalize(
    binY(rows, { value: 'v', by: 'c', thresholds, outputs: { count: { reduce: 'count' } } }),
    { value: 'count', by: 'c', basis: 'max', as: 'width' },
  )
  return definition(spec, ctx, {
    marks: [
      violinY(profiles, {
        x: 'c',
        y: 'y',
        width: 'width',
        span: 0.8,
        fill: color('@seq2'),
        stroke: color('@series1'),
        strokeWidth: 1.5,
      }),
    ],
    scales: {
      x: { scale: bandScale(spec.categories.map(String), 0.2), axis: axisFrom(spec.x, ctx.locale) },
      y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) },
    },
  })
}

/** Everything every chart shares: the theme, the tooltip, and the animation
 *  policy. `svgAnimation` stays off — the first paint of an animated scene is
 *  driven by animation frames, and a hidden iframe or a background tab suspends
 *  those, which is exactly where a dashboard preview lives. */
function definition(spec, ctx, base) {
  return defineChart({
    ...base,
    theme: THEME,
    tooltip: {
      use: tooltip,
      format: (point) => ctx.tip(point),
    },
  })
}

/* ── Mounting ────────────────────────────────────────────────────────────*/

/** Render one spec into one container.
 *
 *  Failures are contained: a spec the runtime cannot build must leave a visible
 *  message in its own card and let every later chart on the page draw. A blank
 *  card under a clean-looking layout is the failure a reader cannot detect. */
export function mount(el, spec, options) {
  const opts = options || {}
  const locale = opts.locale || 'de-DE'
  // One format for the measure: the bar's own label, the axis it is read
  // against and the tooltip all speak the same units, so "412.000 €" on the
  // label never sits over a "400000" gridline.
  const numberFormat = spec.value_format || (spec.y && spec.y.format) || (spec.x && spec.x.format)
  const value = formatter(numberFormat, locale)
  const ctx = {
    locale,
    value,
    numberFormat,
    numbers: numbersOf(spec),
    tip: (point) => {
      const d = point.datum || {}
      const label = d.label ?? d.c ?? d.axis ?? d.day ?? d.x ?? point.xValue
      const series = d.s ? `${d.s} · ` : ''
      // A band has no single value — reporting one endpoint as "the" number is
      // worse than reporting neither.
      if (d.low != null && d.high != null) {
        const mid = d.v != null ? `${value(d.v)} ` : ''
        return `${label ?? ''}: ${mid}(${value(d.low)} – ${value(d.high)})`
      }
      if (d.start && d.end) {
        return `${label ?? ''}: ${fmtDate(d.start, locale)} – ${fmtDate(d.end, locale)}`
      }
      const number = d.v ?? d.mean ?? d.value ?? d.count ?? point.yValue
      const when = d.date ? ` (${d.date})` : ''
      return `${series}${label ?? ''}${when}: ${value(number)}`
    },
  }
  const build = BUILD[spec.type]
  if (!build) throw new Error(`unknown chart type ${JSON.stringify(spec.type)}`)
  return mountChart(el, {
    definition: build(spec, ctx),
    height: opts.height || 340,
    initialWidth: opts.initialWidth || 640,
    ariaLabel: opts.ariaLabel || spec.type,
  })
}

/** Draw every chart on the page, each isolated from the others. */
export function mountAll(specs, options) {
  const hosts = {}
  specs.forEach((entry) => {
    const el = document.getElementById(entry.id)
    if (!el) return
    try {
      hosts[entry.id] = mount(el, entry.spec, {
        ...options,
        height: entry.height,
        ariaLabel: entry.title,
      })
    } catch (error) {
      console.error(entry.id, error)
      el.innerHTML = ''
      const p = document.createElement('p')
      p.className = 'chart-error'
      p.textContent = `Chart ${entry.id} failed: ${error && error.message ? error.message : error}`
      el.appendChild(p)
    }
  })
  return hosts
}

export const types = Object.keys(BUILD).sort()
