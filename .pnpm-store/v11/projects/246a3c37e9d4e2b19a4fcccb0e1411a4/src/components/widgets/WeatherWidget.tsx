import { useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDownIcon,
  CloudDrizzleIcon,
  CloudFogIcon,
  CloudHailIcon,
  CloudIcon,
  CloudLightningIcon,
  CloudMoonIcon,
  CloudRainIcon,
  CloudSnowIcon,
  CloudSunIcon,
  DropletsIcon,
  MoonIcon,
  SunIcon,
  SunriseIcon,
  SunsetIcon,
  WindIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WidgetProps } from './registry';

// ── payload narrowing ──
// Everything below arrives as `unknown`: off the SSE stream on a live turn, out
// of a `tool_events` row on a cold load. A turn persisted by an older backend is
// a normal input, not an error case, so every field is read defensively and a
// missing one renders as a gap rather than taking the message list down with it.

type Dict = Record<string, unknown>;

const asDict = (value: unknown): Dict => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {});
const asList = (value: unknown): Dict[] => (Array.isArray(value) ? value.filter((v): v is Dict => !!v && typeof v === 'object') : []);
const asNum = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const asStr = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Condition key -> icon. The keys are the backend's (`src/weather.py` maps WMO
 *  codes onto them); several codes share a key where the difference isn't
 *  visible on a card. `clear` and `mainly-clear` swap for their night variants —
 *  a sun over a 3 a.m. reading reads as a bug. */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  clear: SunIcon,
  'mainly-clear': CloudSunIcon,
  'partly-cloudy': CloudSunIcon,
  overcast: CloudIcon,
  fog: CloudFogIcon,
  drizzle: CloudDrizzleIcon,
  rain: CloudRainIcon,
  'freezing-rain': CloudHailIcon,
  snow: CloudSnowIcon,
  'snow-grains': CloudSnowIcon,
  showers: CloudRainIcon,
  'snow-showers': CloudSnowIcon,
  thunderstorm: CloudLightningIcon,
  'thunderstorm-hail': CloudLightningIcon,
  unknown: CloudIcon,
};

const NIGHT_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  clear: MoonIcon,
  'mainly-clear': CloudMoonIcon,
  'partly-cloudy': CloudMoonIcon,
};

function ConditionIcon({ condition, night = false, className }: { condition: string; night?: boolean; className?: string }) {
  const Icon = (night ? NIGHT_ICONS[condition] : undefined) ?? ICONS[condition] ?? ICONS.unknown;
  return <Icon className={className} />;
}

/** Open-Meteo timestamps are already in the LOCATION's local time and carry no
 *  offset ("2026-08-11T14:00"). Parsing them with `new Date()` would have the
 *  browser read them as the VIEWER's local time, which is wrong the moment the
 *  two differ — and someone asking about Tokyo from Germany is exactly the case
 *  the card exists for. So the fields are sliced out of the string instead. */
function hourOf(stamp: string): string {
  return stamp.slice(11, 16);
}

/** Weekday for a "YYYY-MM-DD" date, in the UI's language. Constructed from the
 *  parts rather than parsed, for the same reason as `hourOf`. */
function weekdayOf(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
}

const round = (value: number | undefined): string => (value == null ? '–' : `${Math.round(value)}`);

/** Probability of precipitation, shown only when it's worth looking at. A row of
 *  "0%" on a clear week is noise that makes the one rainy day harder to spot. */
function Pop({ value }: { value: number | undefined }) {
  if (value == null || value < 10) return null;
  return (
    <span className="flex items-center gap-0.5 text-xs tabular-nums text-sky-600 dark:text-sky-400">
      <DropletsIcon className="size-3" />
      {Math.round(value)}%
    </span>
  );
}

/** One reading in the expanded day's hourly strip. */
function HourCell({ hour, degree }: { hour: Dict; degree: string }) {
  return (
    <div className="flex min-w-11 flex-col items-center gap-1">
      <span className="text-[11px] tabular-nums text-muted-foreground">{hourOf(asStr(hour.time))}</span>
      <ConditionIcon condition={asStr(hour.condition) || 'unknown'} className="size-4 text-muted-foreground" />
      <span className="text-xs font-medium tabular-nums">
        {round(asNum(hour.temperature))}
        {degree.replace('C', '').replace('F', '')}
      </span>
      <Pop value={asNum(hour.precipitationProbability)} />
    </div>
  );
}

/** A single figure in the expanded day's stat grid. Rendered only when the value
 *  exists — a grid of dashes tells the reader nothing and costs a row. */
function Stat({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  );
}

/** What a day opens into: the numbers that don't fit on its one-line summary,
 *  plus its hourly curve where one exists.
 *
 *  Beyond a week the payload carries no hours — an hour-by-hour line that far out
 *  is fiction, and the backend deliberately stops sending it. The day still
 *  opens; it just shows its daily figures, which is the honest amount of detail
 *  available for it. */
function DayDetail({ day, degree, units }: { day: Dict; degree: string; units: Dict }) {
  const { t } = useTranslation();
  const hours = asList(day.hours);
  const windUnit = asStr(units.wind) || 'km/h';
  const precipUnit = asStr(units.precipitation) || 'mm';

  const num = (value: unknown, suffix: string) => {
    const parsed = asNum(value);
    return parsed == null ? null : `${Math.round(parsed * 10) / 10}${suffix}`;
  };

  return (
    <div className="bg-muted/30 px-4 py-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Stat label={t('weather.feels')} value={
          asNum(day.apparentMin) != null && asNum(day.apparentMax) != null
            ? `${round(asNum(day.apparentMin))}–${round(asNum(day.apparentMax))}${degree}`
            : null
        } />
        <Stat label={t('weather.precipitation')} value={num(day.precipitation, ` ${precipUnit}`)} />
        <Stat label={t('weather.wind')} value={num(day.wind, ` ${windUnit}`)} />
        <Stat label={t('weather.uvIndex')} value={num(day.uvIndex, '')} />
        <Stat label={t('weather.sunrise')} value={asStr(day.sunrise) ? hourOf(asStr(day.sunrise)) : null} />
        <Stat label={t('weather.sunset')} value={asStr(day.sunset) ? hourOf(asStr(day.sunset)) : null} />
      </div>
      {hours.length > 0 ? (
        <div className="mt-3 flex gap-1 overflow-x-auto border-t border-border/50 pt-2.5">
          {hours.map((hour, i) => (
            <HourCell key={asStr(hour.time) || i} hour={hour} degree={degree} />
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-muted-foreground">{t('weather.noHourly')}</div>
      )}
    </div>
  );
}

export function WeatherWidget({ data }: WidgetProps) {
  const { t, i18n } = useTranslation();
  const payload = asDict(data);
  const location = asDict(payload.location);
  const units = asDict(payload.units);
  const current = asDict(payload.current);
  const hourly = asList(payload.hourly);
  const daily = asList(payload.daily);
  // One day open at a time: the detail is tall, and several expanded at once
  // turns the card into a page you have to scroll to compare two days.
  const [openDay, setOpenDay] = useState<string | null>(null);

  const degree = asStr(units.temperature) || '°C';
  const condition = asStr(current.condition) || 'unknown';
  const isDay = current.isDay !== false;
  const label = (key: string) => t(`weather.conditions.${key}`, { defaultValue: t('weather.conditions.unknown') });

  // Lead with the name the user asked for. The geocoder answers in its own
  // canonical spelling — "Zurich" for "Zürich", "Munich" for "München" — and a
  // card headed by a name they did not type reads as the wrong city. The
  // resolved place stays underneath, and only when it actually says something
  // the heading doesn't: it is what confirms WHICH Springfield this is.
  const resolved = [asStr(location.name), asStr(location.country)].filter(Boolean).join(', ');
  const asked = asStr(location.query) || asStr(location.name);
  const heading = asked || resolved;
  const subtitle = resolved.toLowerCase() === heading.toLowerCase() ? '' : resolved;

  // One temperature scale for the whole week, so the range bars are comparable
  // between rows — scaling each row to itself would draw a 2-degree day and a
  // 15-degree day as the same bar.
  const lows = daily.map((day) => asNum(day.min)).filter((v): v is number => v != null);
  const highs = daily.map((day) => asNum(day.max)).filter((v): v is number => v != null);
  const weekMin = lows.length ? Math.min(...lows) : 0;
  const weekMax = highs.length ? Math.max(...highs) : 1;
  const span = Math.max(weekMax - weekMin, 1);

  const sunrise = asStr(asDict(daily[0]).sunrise);
  const sunset = asStr(asDict(daily[0]).sunset);

  // No outer margin here — `WidgetView` owns the spacing around every widget,
  // so the gap stays the same whichever card is rendered.
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* Current conditions */}
      <div className="flex items-start gap-4 p-4">
        <ConditionIcon condition={condition} night={!isDay} className="size-12 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{heading || t('weather.unknownPlace')}</div>
          {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tabular-nums">
              {round(asNum(current.temperature))}
              <span className="text-2xl text-muted-foreground">{degree}</span>
            </span>
            <span className="truncate text-sm text-muted-foreground">{label(condition)}</span>
          </div>
          {asNum(current.apparent) != null && (
            <div className="text-xs text-muted-foreground">
              {t('weather.feelsLike', { value: `${round(asNum(current.apparent))}${degree}` })}
            </div>
          )}
        </div>
      </div>

      {/* Wind / humidity / sun */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        {asNum(current.wind) != null && (
          <span className="flex items-center gap-1">
            <WindIcon className="size-3.5" />
            <span className="tabular-nums">{round(asNum(current.wind))} {asStr(units.wind) || 'km/h'}</span>
          </span>
        )}
        {asNum(current.humidity) != null && (
          <span className="flex items-center gap-1">
            <DropletsIcon className="size-3.5" />
            <span className="tabular-nums">{round(asNum(current.humidity))}%</span>
          </span>
        )}
        {sunrise && (
          <span className="flex items-center gap-1">
            <SunriseIcon className="size-3.5" />
            <span className="tabular-nums">{hourOf(sunrise)}</span>
          </span>
        )}
        {sunset && (
          <span className="flex items-center gap-1">
            <SunsetIcon className="size-3.5" />
            <span className="tabular-nums">{hourOf(sunset)}</span>
          </span>
        )}
      </div>

      {/* Next 24 hours. Scrolls inside its own track — the message column must
          never scroll sideways because a widget is wider than it is. */}
      {hourly.length > 0 && (
        <div className="flex gap-1 overflow-x-auto border-t px-3 py-2.5">
          {hourly.map((hour, i) => (
            <div key={asStr(hour.time) || i} className="flex min-w-11 flex-col items-center gap-1">
              <span className="text-[11px] tabular-nums text-muted-foreground">{hourOf(asStr(hour.time))}</span>
              <ConditionIcon condition={asStr(hour.condition) || 'unknown'} className="size-4 text-muted-foreground" />
              <span className="text-xs font-medium tabular-nums">{round(asNum(hour.temperature))}°</span>
              <Pop value={asNum(hour.precipitationProbability)} />
            </div>
          ))}
        </div>
      )}

      {/* Daily forecast */}
      {daily.length > 0 && (
        <div className="border-t">
          {daily.map((day, i) => {
            const min = asNum(day.min);
            const max = asNum(day.max);
            const left = min == null ? 0 : ((min - weekMin) / span) * 100;
            const width = min == null || max == null ? 0 : Math.max(((max - min) / span) * 100, 4);
            const date = asStr(day.date);
            const open = openDay === date;
            return (
              <div key={date || i} className={cn(i > 0 && 'border-t border-border/40')}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenDay(open ? null : date)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors hover:bg-accent/60',
                    open && 'bg-accent/40',
                  )}
                >
                  <span className="w-9 shrink-0 text-xs text-muted-foreground">
                    {i === 0 ? t('weather.today') : weekdayOf(date, i18n.language)}
                  </span>
                  <ConditionIcon
                    condition={asStr(day.condition) || 'unknown'}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="w-10 shrink-0">
                    <Pop value={asNum(day.precipitationProbability)} />
                  </span>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {round(min)}°
                  </span>
                  <span className="relative h-1 min-w-8 flex-1 rounded-full bg-muted">
                    <span
                      className="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-400 to-amber-400"
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 text-xs font-medium tabular-nums">{round(max)}°</span>
                  <ChevronDownIcon
                    className={cn('size-3.5 shrink-0 opacity-40 transition-transform', open && 'rotate-180')}
                  />
                </button>
                {/* Mounted only while open: sixteen days of hourly strips built
                    up front is a lot of DOM for detail nobody has asked to see. */}
                {open && <DayDetail day={day} degree={degree} units={units} />}
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">{t('weather.source')}</div>
    </div>
  );
}
