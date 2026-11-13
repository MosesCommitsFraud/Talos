import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Shared visual vocabulary for every place the app reports usage: the home
 *  screen's activity block (components/Welcome.tsx), the admin Users page and
 *  Settings → Usage. Flat and dense, in the manner of the settings dialog: a
 *  ruled ledger of numbers, headed sections straight on the page, thin bars.
 *  No cards. */

export function useNum() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return {
    num: (n: number) => Math.round(n).toLocaleString(lang),
    compact: (n: number) =>
      new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n),
    bytes: (n: number) => {
      if (!n) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
      const v = n / 1024 ** i;
      return `${v.toLocaleString(lang, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
    },
    hour: (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(lang, { hour: 'numeric' }),
    /** Milliseconds → "4.2s" / "3m 20s" / "5h 12m". Used for both a single
     *  turn's latency and a whole window's accumulated generation time. */
    duration: (ms: number) => {
      if (ms < 1000) return `${Math.round(ms)} ms`;
      const s = ms / 1000;
      if (s < 60) return `${s.toLocaleString(lang, { maximumFractionDigits: 1 })}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    },
    date: (iso: string) =>
      new Date(iso).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' }),
  };
}

/** Hover tooltip with the home screen's timing (components/Welcome.tsx): the
 *  first hover waits ~400ms, then moving between neighbouring cells updates it
 *  instantly until the pointer leaves the chart and it goes cold again.
 *
 *  Returns the props to spread on the positioned wrapper plus the rendered
 *  bubble, so any chart in this file gets identical behaviour. */
export function useHoverTip() {
  const [tip, setTip] = useState<{ x: number; y: number; label: string } | null>(null);
  const warm = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (next: { x: number; y: number; label: string }) => {
    if (timer.current) clearTimeout(timer.current);
    if (warm.current) {
      setTip(next);
    } else {
      timer.current = setTimeout(() => { warm.current = true; setTip(next); }, 400);
    }
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    warm.current = false;
    setTip(null);
  };

  const node = tip ? (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md"
      style={{ left: tip.x, top: tip.y - 4 }}
    >
      {tip.label}
    </div>
  ) : null;

  return { show, clear, node };
}

/** Wrapper every chart shares: relative positioning for the tooltip, and a
 *  mouse-leave that resets it to cold. */
function ChartFrame({ onLeave, children, tip, className }: {
  onLeave: () => void;
  children: React.ReactNode;
  tip: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)} onMouseLeave={onLeave}>
      {children}
      {tip}
    </div>
  );
}

export interface Stat {
  label: string;
  value: string;
  hint?: string;
  /** `warn` flags a number that deserves attention (errors, limit pressure). */
  tone?: 'warn';
}

/** Numbers as a ledger: cells ruled off by hairlines, no boxes around them.
 *  The same block wherever the app reports usage (home screen, the admin
 *  Users page, Settings → Usage), so a figure looks the same in all three.
 *  The rules are each cell's own top and left border; the outermost ones are
 *  pulled out of view, which leaves lines only *between* cells and lets the
 *  grid sit on any surface. */
export function StatGrid({ stats, columns = 4, className }: {
  stats: Stat[];
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div className={cn('@container/stats overflow-hidden border-y border-border', className)}>
      <dl
        className={cn(
          '-mt-px -ml-px grid',
          columns === 2 ? 'grid-cols-2' : columns === 3 ? 'grid-cols-3' : 'grid-cols-2 @lg/stats:grid-cols-4',
        )}
      >
        {stats.map((s) => (
          <div key={s.label} className="min-w-0 border-t border-l border-border px-3 py-2">
            <dt className="truncate text-[11px] text-muted-foreground">{s.label}</dt>
            <dd
              className={cn(
                'truncate text-[15px] leading-snug font-semibold tracking-[-0.01em] tabular-nums',
                s.tone === 'warn' ? 'text-destructive-foreground' : 'text-strong',
              )}
              title={s.value}
            >
              {s.value}
            </dd>
            {s.hint && <dd className="truncate text-[11px] leading-tight text-muted-foreground">{s.hint}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A titled block of a usage page: a heading with an optional note at the
 *  right, then content straight on the page. Blocks separate by the space
 *  between them, not by a frame each. */
export function Section({ title, action, children, className }: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A caption inside a section, for its second list ("Authored skills"). */
export function SubLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('text-[11px] font-medium tracking-wide text-muted-foreground uppercase', className)}>
      {children}
    </div>
  );
}

/** A quiet line standing in for a list that has nothing in it. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-xs text-muted-foreground">{children}</p>;
}

/** Horizontal bar list — the top-N breakdown used for tools, skills, modes.
 *  Name, a thin bar, the count: the bar is its own column so names never sit
 *  on a coloured ground and the counts line up. Bars are proportional to the
 *  largest entry, not the total, so a long tail stays visible. */
export function BarList({ rows, empty }: {
  rows: Array<{ key: string; label: string; value: number; sub?: string; tone?: 'warn' }>;
  empty: string;
}) {
  const { num } = useNum();
  if (rows.length === 0) return empty ? <Empty>{empty}</Empty> : null;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="grid grid-cols-[minmax(0,auto)_minmax(2rem,1fr)_auto] items-center gap-x-3 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="col-span-3 grid h-6 grid-cols-subgrid items-center">
          <span className="min-w-0 max-w-36 truncate" title={r.label}>{r.label}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max(2, (r.value / max) * 100)}%`,
                background: `color-mix(in srgb, var(--primary) ${r.tone === 'warn' ? 45 : 80}%, transparent)`,
              }}
            />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">
            {r.sub && <span className="mr-2 text-destructive-foreground">{r.sub}</span>}
            {num(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Avatar disc with the account's initial. */
export function UserAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary',
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A small label after a name: role, state. */
export function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'primary' | 'muted' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium',
        tone === 'primary' ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

export interface DailyPoint {
  date: string;
  turns: number;
  tokens: number;
  input: number;
  output: number;
  tools: number;
}

/** Daily bars for the selected window, each split into input (lower, muted)
 *  and output (upper, solid) tokens — output is the half that actually costs
 *  GPU time, so the stack shows where the load really is. */
export function DailyChart({ daily, days }: { daily: DailyPoint[]; days: number }) {
  const { t } = useTranslation();
  const { num, date } = useNum();
  const { show, clear, node } = useHoverTip();
  // The API always returns a fixed-length series; the range selector trims it
  // so switching to 7d doesn't render 91 near-empty columns.
  const rows = days > 0 ? daily.slice(-days) : daily;
  const max = Math.max(...rows.map((d) => d.tokens), 1);

  return (
    <ChartFrame onLeave={clear} tip={node}>
      <div className="flex h-24 items-end gap-px" role="img" aria-label={t('users.chart.label')}>
        {rows.map((d, i) => (
          <div
            key={d.date}
            className="flex min-w-px flex-1 flex-col justify-end self-stretch"
            onMouseEnter={(e) => show({
              // Anchor to the bar's centre within the frame, not the pointer,
              // so the bubble doesn't jitter as the mouse moves inside a bar.
              x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2,
              y: e.currentTarget.offsetTop,
              label: `${date(d.date)} — ${t('users.chart.tooltip', {
                tokens: num(d.tokens), turns: num(d.turns),
              })}${d.tokens ? ` · ${t('users.chart.split', {
                input: num(d.input), output: num(d.output),
              })}` : ''}${d.tools ? ` · ${t('users.chart.tools', { count: d.tools })}` : ''}`,
            })}
            aria-hidden={i > 0 || undefined}
          >
            {d.tokens === 0 ? (
              <div
                className="h-px rounded-[1px]"
                style={{ background: 'color-mix(in srgb, var(--foreground) 8%, transparent)' }}
              />
            ) : (
              <>
                <div
                  className="rounded-t-[2px]"
                  style={{
                    height: `${(d.output / max) * 100}%`,
                    minHeight: d.output ? 2 : 0,
                    background: 'color-mix(in srgb, var(--primary) 85%, transparent)',
                  }}
                />
                <div
                  style={{
                    height: `${(d.input / max) * 100}%`,
                    minHeight: d.input ? 2 : 0,
                    background: 'color-mix(in srgb, var(--primary) 35%, transparent)',
                  }}
                />
              </>
            )}
          </div>
        ))}
      </div>
    </ChartFrame>
  );
}

/** Key for the daily chart's two shades. Sits in the heading of the section
 *  that holds the chart, so the chart itself is nothing but bars. */
export function DailyLegend() {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <i className="size-2 rounded-[2px]" style={{ background: 'color-mix(in srgb, var(--primary) 85%, transparent)' }} />
        {t('users.chart.output')}
      </span>
      <span className="flex items-center gap-1">
        <i className="size-2 rounded-[2px]" style={{ background: 'color-mix(in srgb, var(--primary) 35%, transparent)' }} />
        {t('users.chart.input')}
      </span>
    </span>
  );
}

/** 24-column hour histogram — shows when this user actually loads the box,
 *  which is what tells you whose peaks overlap. */
export function HourStrip({ hours }: { hours: number[] }) {
  const { t } = useTranslation();
  const { hour } = useNum();
  const { show, clear, node } = useHoverTip();
  const max = Math.max(...hours, 1);
  return (
    <ChartFrame onLeave={clear} tip={node}>
      <div className="flex h-12 items-end gap-0.5">
        {hours.map((n, h) => (
          <div
            key={h}
            className="flex-1 self-stretch"
            onMouseEnter={(e) => show({
              x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2,
              y: e.currentTarget.offsetTop,
              label: `${hour(h)} — ${t('users.hours.tooltip', { count: n })}`,
            })}
          >
            <div className="flex h-full flex-col justify-end">
              <div
                className="rounded-t-[2px]"
                style={{
                  height: `${Math.max(n ? 4 : 2, (n / max) * 100)}%`,
                  background: n
                    ? 'color-mix(in srgb, var(--primary) 55%, transparent)'
                    : 'color-mix(in srgb, var(--foreground) 8%, transparent)',
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{hour(0)}</span><span>{hour(6)}</span><span>{hour(12)}</span><span>{hour(18)}</span><span>{hour(23)}</span>
      </div>
    </ChartFrame>
  );
}

/** Monday-first weekday histogram. Separates "works weekends" from "9-to-5",
 *  which the hour strip alone can't tell you. */
export function WeekdayStrip({ weekday }: { weekday: number[] }) {
  const { t, i18n } = useTranslation();
  const { show, clear, node } = useHoverTip();
  const max = Math.max(...weekday, 1);
  // Locale weekday names, Monday first (2024-01-01 was a Monday).
  const names = weekday.map((_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(i18n.language, { weekday: 'short' }));

  return (
    <ChartFrame onLeave={clear} tip={node}>
      <div className="flex h-12 items-end gap-1">
        {weekday.map((n, i) => (
          <div
            key={i}
            className="flex-1 self-stretch"
            onMouseEnter={(e) => show({
              x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2,
              y: e.currentTarget.offsetTop,
              label: `${names[i]} — ${t('users.hours.tooltip', { count: n })}`,
            })}
          >
            <div className="flex h-full flex-col justify-end">
              <div
                className="rounded-t-[2px]"
                style={{
                  height: `${Math.max(n ? 4 : 2, (n / max) * 100)}%`,
                  background: n
                    ? 'color-mix(in srgb, var(--primary) 55%, transparent)'
                    : 'color-mix(in srgb, var(--foreground) 8%, transparent)',
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground">
        {names.map((n, i) => <span key={i} className="flex-1 truncate text-center">{n}</span>)}
      </div>
    </ChartFrame>
  );
}

/** "2× the median" style comparison line. */
export function VersusMedian({ mine, median, label }: { mine: number; median: number; label: string }) {
  const { t, i18n } = useTranslation();
  const { num } = useNum();
  if (median <= 0) return <span className="text-muted-foreground">{label}: {num(mine)}</span>;
  const ratio = mine / median;
  return (
    <span className="text-muted-foreground">
      {label}: <span className="tabular-nums text-foreground">{num(mine)}</span>{' '}
      {t('users.vsMedian', {
        ratio: ratio.toLocaleString(i18n.language, { maximumFractionDigits: ratio < 10 ? 1 : 0 }),
      })}
    </span>
  );
}
