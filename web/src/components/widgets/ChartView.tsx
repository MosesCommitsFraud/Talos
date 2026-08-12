import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type Cell = string | number | boolean | null;

/** Bars stay one hue — the app's accent — for every category.
 *
 *  Not a darker-where-bigger ramp: that double-encodes bar length as colour,
 *  spends the only free channel on information the chart already shows, and is
 *  wrong outright when the categories have no natural order (customers, tables,
 *  products), which is what a SQL GROUP BY usually returns. One series, one
 *  colour. Both light and dark steps of `--primary` were checked against their
 *  own card surface for lightness band, chroma and 3:1 contrast. */
const SERIES = 'var(--primary)';

/** Bars drawn before the chart switches to "top N". Past this the bars are
 *  thinner than the gap between them and the labels stop being readable, so
 *  more bars means less chart, not more. */
const MAX_BARS = 25;

const isNum = (value: Cell): value is number => typeof value === 'number' && Number.isFinite(value);

/** Does this column read as a point in time? Decides bar vs line: a time axis
 *  makes the reader's job "trend", and a row of dated bars answers that worse
 *  than a line does. Deliberately strict — an ISO-ish prefix, nothing cleverer,
 *  because a false positive turns unordered categories into a fake trend. */
function looksTemporal(values: Cell[]): boolean {
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (strings.length < 3) return false;
  return strings.every((v) => /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2})?/.test(v.trim()));
}

/** Axis ticks on clean numbers — 0 / 500 / 1,000 — rather than the data's own
 *  ragged min and max. They carry the values that aren't directly labelled. */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(value);
  return ticks;
}

function formatNumber(value: number, locale: string): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })}M`;
  if (abs >= 10_000) return `${(value / 1_000).toLocaleString(locale, { maximumFractionDigits: 1 })}k`;
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/** One unit for the whole axis, chosen from its largest tick.
 *
 *  Formatting each tick on its own magnitude gives an axis reading "0 · 5.000 ·
 *  10k · 15k" — the same quantity spelled two ways, four pixels apart. The
 *  reader then has to convert in their head to compare gridlines, which is
 *  exactly the work an axis exists to remove. */
function axisFormatter(max: number, locale: string): (value: number) => string {
  const abs = Math.abs(max);
  const [divisor, suffix] = abs >= 1_000_000 ? [1_000_000, 'M'] : abs >= 10_000 ? [1_000, 'k'] : [1, ''];
  return (value) =>
    // Zero is the one tick that keeps its bare form: "0k" is a unit on nothing,
    // and the baseline should read as the baseline.
    value === 0
      ? '0'
      : `${(value / divisor).toLocaleString(locale, { maximumFractionDigits: divisor === 1 ? 2 : 1 })}${suffix}`;
}

export interface ChartSource {
  columns: string[];
  rows: Cell[][];
  numeric: boolean[];
}

/** Can this result set be charted at all, and with which columns?
 *
 *  Needs one column to name the bars and one to size them. A result set of pure
 *  numbers (an id column and three measures) has nothing to label an axis with,
 *  and a result set of pure text has nothing to plot — in both cases the table
 *  is the answer and the chart tab stays hidden rather than rendering nonsense.
 */
export function chartable(source: ChartSource): { label: number; values: number[] } | null {
  const values = source.numeric.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);
  const label = source.numeric.findIndex((n) => !n);
  if (label < 0 || values.length === 0 || source.rows.length < 2) return null;
  // Identifiers are numbers that are not quantities. A SELECT almost always
  // leads with one, so plotting the first numeric column by default would open
  // the chart on a bar per row id — a staircase that means nothing. They stay
  // selectable (someone may want to see an id gap), just never the default.
  const ordered = [...values].sort((a, b) => idLike(source.columns[a]) - idLike(source.columns[b]));
  return { label, values: ordered };
}

const idLike = (name: string): number =>
  /^(id|nr|no|num|index|key|pk)$|_(id|nr|no|key)$|^(id|key)_/i.test((name || '').trim()) ? 1 : 0;

export function ChartView({ source }: { source: ChartSource }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const spec = chartable(source);
  const [valueColumn, setValueColumn] = useState<number | null>(null);

  const active = valueColumn ?? spec?.values[0] ?? -1;

  const points = useMemo(() => {
    if (!spec || active < 0) return [];
    return source.rows
      .map((row) => ({ label: String(row[spec.label] ?? ''), value: row[active] }))
      .filter((p): p is { label: string; value: number } => isNum(p.value));
  }, [source.rows, spec, active]);

  if (!spec || points.length === 0) return null;

  const temporal = looksTemporal(points.map((p) => p.label));
  const max = Math.max(...points.map((p) => p.value), 0);
  const min = Math.min(...points.map((p) => p.value), 0);

  const picker =
    spec.values.length > 1 ? (
      <div className="flex flex-wrap items-center gap-1">
        {spec.values.map((index) => (
          <button
            key={index}
            type="button"
            onClick={() => setValueColumn(index)}
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] transition-colors',
              index === active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60',
            )}
          >
            {source.columns[index]}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {/* A single series needs no legend box — one colour, and this line
            already names what is plotted. */}
        <span className="text-xs text-muted-foreground">
          {source.columns[active]} {t('chart.by')} {source.columns[spec.label]}
        </span>
        {picker}
      </div>
      {temporal ? (
        <LineChart points={points} max={max} min={min} locale={locale} />
      ) : (
        <BarChart points={points} max={max} locale={locale} />
      )}
    </div>
  );
}

/** Horizontal bars, laid out in HTML rather than SVG.
 *
 *  Category names out of a database are long and arbitrary ("Sammelrechnung über
 *  mehrere Positionen…"), which is the case that breaks a column chart: rotated
 *  x-labels, or clipped ones. Horizontally the label is ordinary text in an
 *  ordinary box that can truncate honestly, and the value sits at the bar's tip
 *  where it is always readable — so no value is gated behind a tooltip. */
function BarChart({
  points,
  max,
  locale,
}: {
  points: { label: string; value: number }[];
  max: number;
  locale: string;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  // Biggest first: the reader's question at a bar chart is almost always "which
  // is largest", and it makes the "top N" cut meaningful rather than arbitrary.
  const ordered = useMemo(() => [...points].sort((a, b) => b.value - a.value), [points]);
  const visible = showAll ? ordered : ordered.slice(0, MAX_BARS);
  const ticks = niceTicks(max);
  const scale = ticks[ticks.length - 1] || 1;
  const axisLabel = axisFormatter(scale, locale);

  return (
    <div>
      <div className="flex flex-col gap-1">
        {visible.map((point, i) => (
          <div key={`${point.label}-${i}`} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate text-muted-foreground" title={point.label}>
              {point.label}
            </span>
            <span className="relative h-2.5 min-w-4 flex-1">
              <span
                // Square where it leaves the baseline, rounded at the data end —
                // the end is the value, the baseline is not.
                className="absolute inset-y-0 left-0 rounded-r"
                style={{
                  width: `${Math.max((point.value / scale) * 100, point.value > 0 ? 0.5 : 0)}%`,
                  background: SERIES,
                }}
              />
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums">{formatNumber(point.value, locale)}</span>
          </div>
        ))}
      </div>

      {/* The axis band is inside the flow, so it can never be cut off by a fixed
          container height the way a nested-scroll chart card is. */}
      <div className="mt-1.5 flex items-center gap-2 border-t pt-1 text-[10px] text-muted-foreground">
        <span className="w-28 shrink-0" />
        <span className="relative flex-1">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute -translate-x-1/2 tabular-nums"
              style={{ left: `${(tick / scale) * 100}%` }}
            >
              {axisLabel(tick)}
            </span>
          ))}
          &nbsp;
        </span>
        <span className="w-16 shrink-0" />
      </div>

      {ordered.length > MAX_BARS && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 rounded px-1 py-0.5 text-[11px] text-muted-foreground underline underline-offset-2 transition-colors hover:bg-accent hover:text-foreground"
        >
          {showAll
            ? t('chart.showTop', { count: MAX_BARS })
            : t('chart.showAllBars', { count: ordered.length })}
        </button>
      )}
    </div>
  );
}

/** Line chart for a time axis.
 *
 *  SVG here, not HTML: a line is a shape, and the crosshair needs the same
 *  coordinate space as the path. Values are not readable off the line the way
 *  they are off a labelled bar, so the hover layer is not optional — it is how
 *  the reader gets a number. The table tab is still the ungated twin. */
function LineChart({
  points,
  max,
  min,
  locale,
}: {
  points: { label: string; value: number }[];
  max: number;
  min: number;
  locale: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const width = 600;
  const height = 160;
  const padding = { top: 8, right: 8, bottom: 18, left: 44 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const bottom = Math.min(min, 0);
  const span = top - bottom || 1;
  const axisLabel = axisFormatter(top, locale);

  const x = (i: number) => padding.left + (points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
  const y = (value: number) => padding.top + plotHeight - ((value - bottom) / span) * plotHeight;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  const track = (event: React.MouseEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round(((ratio - padding.left) / plotWidth) * (points.length - 1));
    setHover(index >= 0 && index < points.length ? index : null);
  };

  const active = hover != null ? points[hover] : null;

  return (
    <div ref={box} className="relative" onMouseMove={track} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img">
        {/* Hairline, solid, one step off the surface — never dashed: a dashed
            rule reads as a threshold or a projection when it is just a grid. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={padding.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px] tabular-nums"
            >
              {axisLabel(tick)}
            </text>
          </g>
        ))}

        <path d={path} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {active && hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padding.top}
              y2={padding.top + plotHeight}
              stroke="var(--border)"
              strokeWidth="1"
            />
            {/* 2px ring in the surface colour so the marker stays legible where
                it sits on the line. */}
            <circle cx={x(hover)} cy={y(active.value)} r="4" fill={SERIES} stroke="var(--card)" strokeWidth="2" />
          </>
        )}

        {/* First and last labels only. A date under every point is chaos and
            goes unread; the tooltip carries the rest. */}
        <text x={padding.left} y={height - 4} className="fill-muted-foreground text-[9px]">
          {points[0].label.slice(0, 10)}
        </text>
        <text x={width - padding.right} y={height - 4} textAnchor="end" className="fill-muted-foreground text-[9px]">
          {points[points.length - 1].label.slice(0, 10)}
        </text>
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-sm"
          style={{ left: `${(x(hover!) / width) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <div className="text-muted-foreground">{active.label.slice(0, 16)}</div>
          <div className="font-medium tabular-nums">{formatNumber(active.value, locale)}</div>
        </div>
      )}
    </div>
  );
}
