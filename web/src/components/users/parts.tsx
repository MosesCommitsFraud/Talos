import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Shared visual vocabulary for the Users workspace. Deliberately matches the
 *  home screen's stat panel (components/Welcome.tsx) so the two read as the
 *  same product: muted tile, tabular numerals, primary-tinted bars. */

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
    date: (iso: string) =>
      new Date(iso).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' }),
  };
}

export function Tile({ label, value, hint, tone }: {
  label: string;
  value: string;
  hint?: string;
  /** `warn` flags a number that deserves attention (errors, limit pressure). */
  tone?: 'warn';
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn('truncate text-sm font-semibold tabular-nums', tone === 'warn' && 'text-destructive-foreground')}>
        {value}
      </div>
      {hint && <div className="truncate text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Card({ title, action, children }: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Horizontal bar list — the top-N breakdown used for tools, skills, modes.
 *  Bars are proportional to the largest entry, not the total, so a long tail
 *  stays visible. */
export function BarList({ rows, empty }: {
  rows: Array<{ key: string; label: string; value: number; sub?: string; tone?: 'warn' }>;
  empty: string;
}) {
  const { num } = useNum();
  if (rows.length === 0) return <p className="py-2 text-xs text-muted-foreground">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} className="relative overflow-hidden rounded-md px-2 py-1">
          <div
            className="absolute inset-y-0 left-0 rounded-md"
            style={{
              width: `${Math.max(2, (r.value / max) * 100)}%`,
              background: `color-mix(in srgb, var(--primary) ${r.tone === 'warn' ? 14 : 22}%, transparent)`,
            }}
            aria-hidden
          />
          <div className="relative flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate" title={r.label}>{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {r.sub && <span className="mr-2 text-destructive-foreground">{r.sub}</span>}
              {num(r.value)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Daily bars for the selected window. Values are token counts by default;
 *  the tooltip carries the exact figure since the bars are only ~4px wide. */
export function DailyChart({ daily, days }: {
  daily: Array<{ date: string; turns: number; tokens: number; tools: number }>;
  days: number;
}) {
  const { t } = useTranslation();
  const { num, date } = useNum();
  // The API always returns a fixed-length series; the range selector trims it
  // so switching to 7d doesn't render 91 near-empty columns.
  const rows = days > 0 ? daily.slice(-days) : daily;
  const max = Math.max(...rows.map((d) => d.tokens), 1);
  return (
    <div className="flex h-24 items-end gap-px" role="img" aria-label={t('users.chart.label')}>
      {rows.map((d) => (
        <div
          key={d.date}
          className="min-w-px flex-1 rounded-t-[2px] transition-colors hover:brightness-125"
          title={`${date(d.date)} — ${t('users.chart.tooltip', { tokens: num(d.tokens), turns: num(d.turns) })}`}
          style={{
            height: `${Math.max(d.tokens ? 3 : 1, (d.tokens / max) * 100)}%`,
            background: d.tokens
              ? 'color-mix(in srgb, var(--primary) 65%, transparent)'
              : 'color-mix(in srgb, var(--foreground) 8%, transparent)',
          }}
        />
      ))}
    </div>
  );
}

/** 24-column hour histogram — shows when this user actually loads the box,
 *  which is what tells you whose peaks overlap. */
export function HourStrip({ hours }: { hours: number[] }) {
  const { t } = useTranslation();
  const { num, hour } = useNum();
  const max = Math.max(...hours, 1);
  return (
    <div>
      <div className="flex h-12 items-end gap-0.5">
        {hours.map((n, h) => (
          <div
            key={h}
            className="flex-1 rounded-t-[2px]"
            title={`${hour(h)} — ${t('users.hours.tooltip', { count: num(n) })}`}
            style={{
              height: `${Math.max(n ? 4 : 2, (n / max) * 100)}%`,
              background: n
                ? 'color-mix(in srgb, var(--primary) 55%, transparent)'
                : 'color-mix(in srgb, var(--foreground) 8%, transparent)',
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{hour(0)}</span><span>{hour(6)}</span><span>{hour(12)}</span><span>{hour(18)}</span><span>{hour(23)}</span>
      </div>
    </div>
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
