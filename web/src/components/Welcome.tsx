import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUsageStats, type UsageStats } from '@/api/client';
import { usePrefs } from '@/state/prefs';
import { useAuth } from './auth/AuthGate';

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden>
      <path d="M16 4L16 22L6 22Z" fill="var(--primary)" />
      <path d="M16 8L16 22L24 22Z" fill="var(--primary)" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="var(--primary)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

const GREETING_COUNT = 6;

/** "moritz.schaefer" / "moritz_schaefer" / "Moritz Schäfer" → "Moritz". */
function firstNameOf(username?: string): string | null {
  const first = (username ?? '').split(/[._\-\s]+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Token totals compared against well-known books (rough token counts). */
const BOOKS: { key: string; tokens: number }[] = [
  { key: 'gatsby', tokens: 63_000 },
  { key: 'hobbit', tokens: 127_000 },
  { key: 'mobyDick', tokens: 285_000 },
  { key: 'warAndPeace', tokens: 750_000 },
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

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const CELL = 10; // px — fixed so the squares stay perfectly regular
const GAP = 3;

/** GitHub-style activity heatmap: one column per week (Monday-first),
 *  oldest→newest, with a shared hover tooltip showing date + count. */
function Heatmap({ daily }: { daily: UsageStats['daily'] }) {
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const max = Math.max(1, ...daily.map((d) => d.count));
  // Pad the first column so rows are true weekdays (Monday on top).
  const lead = daily.length ? (new Date(`${daily[0].date}T00:00:00`).getDay() + 6) % 7 : 0;

  return (
    <div className="relative w-fit" onMouseLeave={() => setHover(null)}>
      <div
        className="grid grid-flow-col"
        style={{ gridTemplateRows: `repeat(7, ${CELL}px)`, gridAutoColumns: `${CELL}px`, gap: GAP }}
        aria-hidden
      >
        {Array.from({ length: lead }, (_, i) => <div key={`pad-${i}`} />)}
        {daily.map((d, i) => (
          <div
            key={d.date}
            className="rounded-[2px]"
            onMouseEnter={() => {
              const cell = i + lead;
              const dateLabel = new Date(`${d.date}T00:00:00`).toLocaleDateString(i18n.language, {
                weekday: 'short', day: 'numeric', month: 'short',
              });
              setHover({
                x: Math.floor(cell / 7) * (CELL + GAP) + CELL / 2,
                y: (cell % 7) * (CELL + GAP),
                label: `${dateLabel} — ${t('home.heatmapCount', { count: d.count })}`,
              });
            }}
            style={{
              background: d.count === 0
                ? 'color-mix(in srgb, var(--foreground) 8%, transparent)'
                : `color-mix(in srgb, var(--primary) ${Math.round(35 + 65 * (d.count / max))}%, transparent)`,
            }}
          />
        ))}
      </div>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: hover.x, top: hover.y - 4 }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

const RANGES = [
  { key: 'all', days: 0 },
  { key: '30d', days: 30 },
  { key: '7d', days: 7 },
] as const;

function StatsPanel() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[0]);
  const { data: stats } = useQuery({
    queryKey: ['usage-stats', range.days],
    queryFn: () => fetchUsageStats(range.days),
    staleTime: 60_000,
    placeholderData: (prev) => prev, // keep tiles up while a new range loads
  });
  if (!stats || (range.days === 0 && stats.messages === 0)) return null;

  const lang = i18n.language;
  const num = (n: number) => n.toLocaleString(lang);
  const compact = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  const peakHour = stats.peak_hour === null
    ? '—'
    : new Date(2000, 0, 1, stats.peak_hour).toLocaleTimeString(lang, { hour: 'numeric' });
  const fact = funFact(t, stats);

  return (
    <div className="w-full max-w-[560px] rounded-xl border bg-card p-4">
      <div className="mb-3 flex justify-end">
        <div className="flex gap-1 rounded-lg bg-muted/50 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                range.key === r.key
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`home.range.${r.key}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label={t('home.stats.sessions')} value={num(stats.sessions)} />
        <StatTile label={t('home.stats.messages')} value={num(stats.messages)} />
        <StatTile label={t('home.stats.totalTokens')} value={compact.format(stats.total_tokens)} />
        <StatTile label={t('home.stats.activeDays')} value={num(stats.active_days)} />
        <StatTile label={t('home.stats.currentStreak')} value={t('home.stats.days', { count: stats.current_streak })} />
        <StatTile label={t('home.stats.longestStreak')} value={t('home.stats.days', { count: stats.longest_streak })} />
        <StatTile label={t('home.stats.peakHour')} value={peakHour} />
        <StatTile label={t('home.stats.favoriteModel')} value={stats.favorite_model ?? '—'} />
      </div>
      {/* No overflow-hidden here — the hover tooltip extends past the grid. */}
      <div className="mt-3 flex justify-center">
        <Heatmap daily={stats.daily} />
      </div>
      {fact && <p className="mt-3 text-xs text-muted-foreground">{fact}</p>}
    </div>
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

  const firstName = auth?.auth_enabled === false ? null : firstNameOf(auth?.username);
  const greeting = firstName ? t(`home.greeting${variant}`, { name: firstName }) : t('messages.welcome');

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-8">
      {show && (
        <div className="flex select-none flex-col items-center gap-3">
          <Logo />
          <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
        </div>
      )}
      <StatsPanel />
    </div>
  );
}
