import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextCategory } from '@/api/types';
import { useChat } from '@/state/chat';
import { cn } from '@/lib/utils';
import { RollingNumber } from './RollingNumber';

/* A small ring in the composer showing how full the model's context window is,
 * with a panel on hover or click: the share in large figures, the window as one
 * stacked bar, what fills it listed largest first, and a line on what happens
 * when it is full. */

// Canonical category order. Only used to break ties between equally-sized
// categories, so their colors don't swap between renders.
const CATEGORY_ORDER: readonly ContextCategory[] = [
  'system',
  'tools',
  'mcpTools',
  'skills',
  'knowledge',
  'documents',
  'toolResults',
  'messages',
];

// Accent ramp from styles/index.css: one hue fading to lighter tints, so the
// stacked bar reads as one quantity split into parts rather than as unrelated
// categories. Assigned by SIZE, not by category — the biggest contributor gets
// the darkest tint and each smaller one gets lighter, so the bar is a gradient
// and the eye lands on whatever is actually filling the window.
const RAMP: readonly string[] = [
  'var(--ctx-1)',
  'var(--ctx-2)',
  'var(--ctx-3)',
  'var(--ctx-4)',
  'var(--ctx-5)',
  'var(--ctx-6)',
  'var(--ctx-7)',
  'var(--ctx-8)',
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
  // Sorted biggest-first, then coloured by rank: the bar becomes a dark→light
  // gradient and the legend leads with whatever is actually filling the window.
  const breakdownEntries = breakdown
    ? CATEGORY_ORDER.filter((key) => (breakdown[key] ?? 0) > 0)
        .map((key) => ({ key, value: breakdown[key] as number }))
        .sort(
          (a, b) =>
            b.value - a.value || CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key),
        )
        .map((entry, i) => ({ ...entry, color: RAMP[Math.min(i, RAMP.length - 1)] }))
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
  const share = (value: number) =>
    barDenominator ? formatPercent((value / barDenominator) * 100) : '';

  return (
    <TooltipPrimitive.Root delayDuration={250} open={open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={t('contextMeter.used', { percent: formatPercent(percent) })}
          // Sized and centred to sit level with the model picker beside it — no
          // pt nudge, so the ring's middle lands on the button's middle.
          className={cn(
            'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/65 outline-none transition-colors hover:bg-accent hover:text-foreground/90 focus:outline-none focus-visible:outline-none',
            open && 'bg-accent',
          )}
        >
          <span className="relative flex size-3.5 items-center justify-center">
            <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90 transform-gpu" aria-hidden="true">
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
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="top"
          align="end"
          sideOffset={8}
          // Kept clear of the window's edges: the ring sits in the corner, and a
          // panel centred on it would run off the screen.
          collisionPadding={12}
          aria-label={t('contextMeter.used', { percent: formatPercent(percent) })}
          className="z-50 w-72 max-w-[calc(100vw-24px)] rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-foreground">{t('contextMeter.title')}</span>
            <span
              className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
              title={isExact ? t('contextMeter.exactHint') : t('contextMeter.estimatedHint')}
            >
              {isExact ? t('contextMeter.exact') : t('contextMeter.estimated')}
            </span>
          </div>

          {/* The share large, the two numbers it is made of beside it. */}
          <div className="mt-2 flex items-baseline gap-2 tabular-nums">
            <span className="text-2xl leading-none font-semibold tracking-tight" style={{ color: percent > 75 ? usageColor : 'var(--strong)' }}>
              <RollingNumber value={percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)} />%
            </span>
            {usedTokens != null && maxTokens != null && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {t('contextMeter.usedOf', { used: formatTokens(usedTokens), max: formatTokens(maxTokens) })}
              </span>
            )}
          </div>

          <div
            className="mt-2.5 flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted"
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
            // What fills the window, largest first: name, share of the window,
            // tokens. Three columns so the two numbers line up down the list.
            <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 text-xs">
              {breakdownEntries.map((entry) => (
                <div key={entry.key} className="contents">
                  <dt className="flex min-w-0 items-center gap-1.5 text-foreground/90">
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: entry.color }} />
                    <span className="truncate">{t(`contextMeter.categories.${entry.key}`)}</span>
                  </dt>
                  <dd className="text-right text-muted-foreground/70 tabular-nums">{share(entry.value)}</dd>
                  <dd className="text-right text-muted-foreground tabular-nums">{formatTokens(entry.value)}</dd>
                </div>
              ))}
              <div className="contents">
                <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-[3px] bg-muted-foreground/25" />
                  <span className="truncate">{t('contextMeter.categories.freeSpace')}</span>
                </dt>
                <dd className="text-right text-muted-foreground/70 tabular-nums">{share(freeTokens ?? 0)}</dd>
                <dd className="text-right text-muted-foreground tabular-nums">{formatTokens(freeTokens)}</dd>
              </div>
            </dl>
          )}

          <p className="mt-3 border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
            {t('contextMeter.hint')}
          </p>
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
