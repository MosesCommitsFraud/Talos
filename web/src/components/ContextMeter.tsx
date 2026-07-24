import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextCategory } from '@/api/types';
import { useChat } from '@/state/chat';
import { Tooltip } from './ui/misc';

/* t3code's ContextWindowMeter, bridged to Talos metrics: a small ring in the
 * composer showing how full the model's context window is, with the detail
 * panel (percent · used/max tokens, stacked category bar + legend) on hover. */

// Display order + segment color per breakdown category. Colors come from the
// --ctx-* ramp (styles/index.css): one accent hue fading to lighter tints, so
// the stacked bar reads as one quantity split into parts. Ordered from the most
// fixed part of the prompt (system) to the most volatile (messages), which also
// means the ramp darkest→lightest tracks "always there"→"grows as you chat".
const BREAKDOWN_CATEGORIES: ReadonlyArray<{ key: ContextCategory; color: string }> = [
  { key: 'system', color: 'var(--ctx-1)' },
  { key: 'tools', color: 'var(--ctx-2)' },
  { key: 'mcpTools', color: 'var(--ctx-3)' },
  { key: 'skills', color: 'var(--ctx-4)' },
  { key: 'knowledge', color: 'var(--ctx-5)' },
  { key: 'documents', color: 'var(--ctx-6)' },
  { key: 'toolResults', color: 'var(--ctx-7)' },
  { key: 'messages', color: 'var(--ctx-8)' },
];

function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '0';
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

function formatPercent(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(value)}%`;
}

export function ContextMeter() {
  const { t } = useTranslation();
  const messages = useChat((s) => s.messages);
  const [open, setOpen] = useState(false);

  // Latest assistant metrics carry the running context state of the session.
  // Before any metrics exist (fresh chat) the ring still renders, at 0%.
  const metrics = [...messages].reverse().find((m) => m.metrics?.context_percent != null)?.metrics;

  const maxTokens = metrics?.context_length ?? null;
  // context_tokens is the true context-window occupancy (the last round's full
  // prompt). We deliberately do NOT fall back to input_tokens: that figure sums
  // every agent round, so a tool-using turn inflates it to many times the real
  // window size (e.g. showing 1m used against a 262k window). When context_tokens
  // is missing (older/estimated turns), derive the count from the backend
  // percentage so the number and the ring stay consistent.
  const usedTokens =
    metrics?.context_tokens != null
      ? metrics.context_tokens
      : maxTokens != null && metrics?.context_percent != null
        ? Math.round((metrics.context_percent / 100) * maxTokens)
        : null;
  // Derive the percentage from the same figure we display so the number and
  // the ring never disagree; fall back to the backend's context_percent.
  const rawPercent =
    usedTokens != null && maxTokens != null && maxTokens > 0
      ? (usedTokens / maxTokens) * 100
      : (metrics?.context_percent ?? 0);
  const percent = Math.max(0, Math.min(100, rawPercent));
  const isExact = metrics?.usage_source === 'real';

  // Category breakdown (present on final metrics; mid-turn live updates only
  // carry the total, so the panel degrades to the plain bar until it lands).
  const breakdown = metrics?.context_breakdown;
  const breakdownEntries = breakdown
    ? BREAKDOWN_CATEGORIES.filter((c) => (breakdown[c.key] ?? 0) > 0).map((c) => ({
        ...c,
        value: breakdown[c.key] as number,
      }))
    : [];
  const breakdownTotal = breakdownEntries.reduce((sum, e) => sum + e.value, 0);
  // Segment widths are fractions of the WINDOW, not of the used part, so the
  // stacked bar's filled extent equals the ring's percentage.
  const barDenominator = maxTokens != null && maxTokens > 0 ? Math.max(maxTokens, breakdownTotal) : null;
  const hasBreakdown = breakdownEntries.length > 0 && barDenominator != null;
  const freeTokens = hasBreakdown ? Math.max(0, (barDenominator as number) - breakdownTotal) : null;

  // Leaves room in the 24px viewBox for the 4-wide stroke (9.5 + 2 < 12).
  const radius = 9.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percent / 100) * circumference;
  // The ring stays on the accent hue for the normal range and only breaks to a
  // warning/danger color when the window is genuinely close to compacting —
  // a colored ring should mean something, not just decorate.
  const usageColor =
    percent > 90 ? 'var(--destructive)' : percent > 75 ? 'var(--warning)' : 'var(--primary)';

  return (
    <Tooltip
      side="top"
      open={open}
      onOpenChange={setOpen}
      label={
        <div className="flex w-64 flex-col gap-2 p-1.5">
          {/* Title and the numbers sit on separate rows: crammed onto one line
            * the token counts ("262k/262k") collide with the title and the
            * badge as soon as the window is large or nearly full. */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('contextMeter.title')}</span>
            <span
              className="shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60 ring-1 ring-inset ring-border"
              title={isExact ? t('contextMeter.exactHint') : t('contextMeter.estimatedHint')}
            >
              {isExact ? t('contextMeter.exact') : t('contextMeter.estimated')}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-sm font-medium text-foreground/90">{formatPercent(percent)}</span>
            {usedTokens != null && maxTokens != null && (
              <span className="whitespace-nowrap text-[11px] text-muted-foreground/70">
                {t('contextMeter.usedOf', {
                  used: formatTokens(usedTokens),
                  max: formatTokens(maxTokens),
                })}
              </span>
            )}
          </div>
          <div
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-label={t('contextMeter.usage')}
          >
            {hasBreakdown ? (
              breakdownEntries.map((entry) => (
                <div
                  key={entry.key}
                  className="h-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    width: `${(entry.value / (barDenominator as number)) * 100}%`,
                    backgroundColor: entry.color,
                  }}
                />
              ))
            ) : (
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${percent}%`, backgroundColor: usageColor }}
              />
            )}
          </div>
          {hasBreakdown && (
            <div className="flex flex-col gap-0.5">
              {breakdownEntries.map((entry) => (
                <div key={entry.key} className="flex items-center justify-between gap-2 text-[11px]">
                  {/* min-w-0 + truncate keeps a long category label from pushing
                    * the token count out of the panel. */}
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="truncate">{t(`contextMeter.categories.${entry.key}`)}</span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground/70 tabular-nums">
                    {formatTokens(entry.value)}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground/70">
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
                  <span className="truncate">{t('contextMeter.categories.freeSpace')}</span>
                </span>
                <span className="shrink-0 whitespace-nowrap text-muted-foreground/70 tabular-nums">
                  {formatTokens(freeTokens)}
                </span>
              </div>
            </div>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground/70">
            {t('contextMeter.hint')}
          </p>
        </div>
      }
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('contextMeter.used', { percent: formatPercent(percent) })}
        className="mr-1 flex size-6 shrink-0 cursor-pointer items-center pt-[2px] justify-center rounded-[4.5px] border border-transparent text-foreground/65 outline-none transition-colors hover:bg-accent hover:text-foreground/90 focus:outline-none focus-visible:outline-none sm:size-5"
      >
        <span className="relative flex size-3 items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            className="absolute inset-0 size-full -rotate-90 transform-gpu"
            aria-hidden="true"
          >
            <circle
              cx="12" cy="12" r={radius} fill="none" strokeWidth="4"
              stroke="color-mix(in oklab, var(--foreground) 20%, transparent)"
            />
            <circle
              cx="12" cy="12" r={radius} fill="none" strokeWidth="4" strokeLinecap="round"
              stroke={usageColor}
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
            />
          </svg>
        </span>
      </button>
    </Tooltip>
  );
}
