import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUsageStats, type UsageStats } from '@/api/client';
import { usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { useAuth } from './auth/AuthGate';
import { TalosLogo } from './TalosLogo';
import { Segmented } from './ui/segmented';
import { Section } from './users/parts';

function Logo() {
  return <TalosLogo className="size-10 shrink-0 text-primary" />;
}

const GREETING_COUNT = 6;

/** "moritz.schaefer" / "moritz@example.com" / "Moritz Schäfer" → "Moritz". */
function firstNameOf(name?: string | null): string | null {
  const first = (name ?? '').split(/[._\-\s@]+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Token totals compared against well-known works (rough token counts,
 *  ~1.33 tokens per word). Ordered ascending — funFact picks the largest
 *  one the user has comfortably outwritten. */
const BOOKS: { key: string; tokens: number }[] = [
  { key: 'hamlet', tokens: 40_000 },
  { key: 'gatsby', tokens: 63_000 },
  { key: 'harryPotter', tokens: 100_000 },
  { key: 'hobbit', tokens: 127_000 },
  { key: 'dune', tokens: 250_000 },
  { key: 'mobyDick', tokens: 285_000 },
  { key: 'lotr', tokens: 640_000 },
  { key: 'warAndPeace', tokens: 780_000 },
  { key: 'bible', tokens: 1_050_000 },
  { key: 'shakespeare', tokens: 1_200_000 },
  { key: 'wheelOfTime', tokens: 5_800_000 },
  { key: 'britannica', tokens: 58_000_000 },
];

function funFact(t: (k: string, o?: Record<string, unknown>) => string, stats: UsageStats): string | null {
  if (stats.total_tokens > 0) {
    // Largest book the user has "outwritten" — falls back to Gatsby with a
    // fractional multiple for small totals.
    const book = [...BOOKS].reverse().find((b) => stats.total_tokens >= b.tokens * 2) ?? BOOKS[0];
    const ratio = stats.total_tokens / book.tokens;
    const n = ratio >= 10 ? Math.round(ratio) : Math.max(0.1, Math.round(ratio * 10) / 10);
    return t('home.funTokens', { n, book: t(`home.books.${book.key}`) });
  }
  if (stats.messages > 0) return t('home.funMessages', { count: stats.messages });
  return null;
}

const RANGES = [
  { key: 'all', days: 0 },
  { key: '30d', days: 30 },
  { key: '7d', days: 7 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/** A figure's text whose characters roll into place when they change (the same
 *  odometer cells as the live token count, see RollingNumber): switching the
 *  range turns over only the digits that differ, instead of swapping the line. */
function RollingText({ text }: { text: string }) {
  return (
    <span aria-label={text} role="img">
      <span aria-hidden>
        {[...text].map((char, i) => (
          <span key={i} className="digit-cell">
            <span key={char} className="digit-roll">
              {char === ' ' ? ' ' : char}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** One figure of the block: the number large, its name under it. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xl leading-tight font-semibold tracking-tight text-strong tabular-nums" title={value}>
        <RollingText text={value} />
      </div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/** Weeks the heatmap spans: the backend's window (routes/stats_routes.py
 *  HEATMAP_DAYS). The weeks share the block's full width and every day is a
 *  square, so their number is what sets the size of a square: 39 weeks give
 *  squares of about 16 px in the chat column — between the 26 that came out
 *  too large and the 52 that were too many. A shorter history is led in by
 *  empty weeks, so the calendar keeps its shape. */
const HEAT_MIN_WEEKS = 39;

const HEAT_EMPTY = 'color-mix(in srgb, var(--foreground) 7%, transparent)';
/** A day's colour on a continuous scale, not in steps: neighbouring days shade
 *  into one another. A day with anything in it starts clearly above empty. */
const heatColor = (share: number) =>
  `color-mix(in srgb, var(--primary) ${Math.round(26 + 74 * Math.pow(share, 0.75))}%, transparent)`;

/** The activity calendar: one column per week (Monday on top), oldest→newest,
 *  every day a rounded square, across the full width. The columns arrive in a
 *  quick wave from the left; the day under the pointer lifts and is named
 *  under the grid. */
function Heatmap({ daily }: { daily: UsageStats['daily'] }) {
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  if (daily.length === 0) return null;

  const max = Math.max(1, ...daily.map((d) => d.count));
  // Pad the first column so rows are true weekdays, lead a short history in
  // with empty weeks, and pad the last column so the grid is a full rectangle.
  const weekdayLead = (new Date(`${daily[0].date}T00:00:00`).getDay() + 6) % 7;
  const dataCols = Math.ceil((weekdayLead + daily.length) / 7);
  const cols = Math.max(HEAT_MIN_WEEKS, dataCols);
  const lead = weekdayLead + (cols - dataCols) * 7;
  const trail = cols * 7 - lead - daily.length;

  const day = (iso: string, weekday = false) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(i18n.language, weekday
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short' });
  // A month's name goes over the first column that holds one of its days,
  // unless the previous label would run into it.
  const months: { col: number; label: string }[] = [];
  daily.forEach((d, i) => {
    const date = new Date(`${d.date}T00:00:00`);
    if (i !== 0 && date.getDate() !== 1) return;
    const col = Math.floor((i + lead) / 7);
    const last = months[months.length - 1];
    if (last && col - last.col < 3) return;
    months.push({ col, label: date.toLocaleDateString(i18n.language, { month: 'short' }) });
  });
  // Square whatever the width: the column sets the width, the ratio the height.
  const cell = 'aspect-square rounded-[28%] pop-in';
  const wave = (slot: number) => ({ animationDelay: `${Math.floor(slot / 7) * 10}ms` });
  const point = hover === null ? null : daily[hover];

  return (
    <div onMouseLeave={() => setHover(null)}>
      <div className="relative mb-1 h-3.5 text-[10px] leading-none text-muted-foreground" aria-hidden>
        {months.map((m) => (
          <span key={m.col} className="absolute top-0" style={{ left: `${(m.col / cols) * 100}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div
        className="grid grid-flow-col grid-rows-7 gap-[3px] @2xl/home:gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        role="img"
        aria-label={t('home.heatLabel')}
      >
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} className={cell} style={{ background: HEAT_EMPTY, ...wave(i) }} />
        ))}
        {daily.map((d, i) => (
          <span
            key={d.date}
            onMouseEnter={() => setHover(i)}
            className={cn(cell, 'transition-transform duration-100', hover === i && 'scale-125 ring-1 ring-foreground/50')}
            style={{ background: d.count === 0 ? HEAT_EMPTY : heatColor(d.count / max), ...wave(i + lead) }}
          />
        ))}
        {Array.from({ length: trail }, (_, i) => (
          <span key={`trail-${i}`} className={cell} style={{ background: HEAT_EMPTY, ...wave(lead + daily.length + i) }} />
        ))}
      </div>
      {/* The day under the pointer on the left, the key to the colours on the
          right; nothing floats over the grid. */}
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className={cn('min-w-0 truncate tabular-nums', point && 'text-foreground')}>
          {point
            ? `${day(point.date, true)} — ${t('home.heatmapCount', { count: point.count })}`
            : t('home.heatHint', { weeks: Math.round(daily.length / 7) })}
        </span>
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {t('home.less')}
          <i className="size-2.5 rounded-[28%]" style={{ background: HEAT_EMPTY }} />
          {[0.15, 0.45, 0.75, 1].map((share) => (
            <i key={share} className="size-2.5 rounded-[28%]" style={{ background: heatColor(share) }} />
          ))}
          {t('home.more')}
        </span>
      </div>
    </div>
  );
}

/** The home screen's activity block: a heading with the range switch, four
 *  figures, the activity calendar under them, and the rest as a quiet line.
 *  The switch scopes the figures; the calendar always shows the whole window
 *  the server sends. */
function StatsPanel() {
  const { t, i18n } = useTranslation();
  const [rangeKey, setRangeKey] = useState<RangeKey>('all');
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0];
  const { data: stats } = useQuery({
    queryKey: ['usage-stats', range.days],
    queryFn: () => fetchUsageStats(range.days),
    staleTime: 60_000,
    placeholderData: (prev) => prev, // keep the figures up while a new range loads
  });
  if (!stats || (range.days === 0 && stats.messages === 0)) return null;

  const lang = i18n.language;
  const num = (n: number) => n.toLocaleString(lang);
  const compact = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  const peakHour = stats.peak_hour === null
    ? null
    : new Date(2000, 0, 1, stats.peak_hour).toLocaleTimeString(lang, { hour: 'numeric' });
  const fact = funFact(t, stats);
  const rest = [
    `${t('home.stats.sessions')} ${num(stats.sessions)}`,
    `${t('home.stats.longestStreak')} ${t('home.stats.days', { count: stats.longest_streak })}`,
    peakHour ? `${t('home.stats.peakHour')} ${peakHour}` : null,
    stats.favorite_model ? `${t('home.stats.favoriteModel')} ${stats.favorite_model}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <Section
      className="w-full"
      title={t('home.activity')}
      action={
        <Segmented<RangeKey>
          size="sm"
          label={t('settings.usage.period')}
          value={rangeKey}
          onChange={setRangeKey}
          options={RANGES.map((r) => ({ value: r.key, label: t(`home.range.${r.key}`) }))}
        />
      }
    >
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 pt-1 @md/home:grid-cols-4">
        <Figure label={t('home.stats.messages')} value={num(stats.messages)} />
        <Figure label={t('home.stats.totalTokens')} value={compact.format(stats.total_tokens)} />
        <Figure label={t('home.stats.activeDays')} value={num(stats.active_days)} />
        <Figure label={t('home.stats.currentStreak')} value={t('home.stats.days', { count: stats.current_streak })} />
      </div>
      <div className="mt-4">
        <Heatmap daily={stats.daily} />
      </div>
      <p className="mt-3 truncate text-xs text-muted-foreground">{rest}</p>
      {fact && <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{fact}</p>}
    </Section>
  );
}

/** Empty-chat home screen: logo, a rotating "welcome back" greeting, and a
 *  fun usage-stats panel. Fills the message area; the composer stays at the
 *  bottom of the viewport. */
export function Welcome() {
  const { t } = useTranslation();
  const show = usePrefs((s) => s.visibility.welcomeText);
  const auth = useAuth();
  // Pick one greeting variant per mount so it doesn't flicker on re-renders.
  const [variant] = useState(() => Math.floor(Math.random() * GREETING_COUNT) + 1);

  const firstName = auth?.auth_enabled === false ? null : firstNameOf(auth?.display_name || auth?.username);
  const greeting = firstName ? t(`home.greeting${variant}`, { name: firstName }) : t('messages.welcome');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Same 800px column as the composer/messages, content left-aligned. */}
      <div className="@container/home mx-auto flex w-full max-w-[800px] flex-col items-start gap-6 px-4 py-10">
        {show && (
          <div className="flex select-none items-center gap-3">
            <Logo />
            <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
          </div>
        )}
        <StatsPanel />
      </div>
    </div>
  );
}
