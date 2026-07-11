import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChat } from '@/state/chat';
import { Tooltip } from './ui/misc';

/* t3code's ContextWindowMeter, bridged to Talos metrics: a small ring in the
 * composer showing how full the model's context window is, with the detail
 * panel (percent · used/max tokens, progress bar) on hover. */

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

  // Leaves room in the 24px viewBox for the 4.5-wide stroke (9.5 + 2.25 < 12).
  const radius = 9.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percent / 100) * circumference;
  const isOverloaded = percent > 90;
  const usageColor = isOverloaded ? 'var(--color-red-500)' : 'var(--color-blue-500)';

  return (
    <Tooltip
      side="top"
      open={open}
      onOpenChange={setOpen}
      label={
        <div className="flex w-56 flex-col gap-2 p-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('contextMeter.title')}</span>
              <span
                className="rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60 ring-1 ring-inset ring-border"
                title={isExact ? t('contextMeter.exactHint') : t('contextMeter.estimatedHint')}
              >
                {isExact ? t('contextMeter.exact') : t('contextMeter.estimated')}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground/70 tabular-nums">
              <span>{formatPercent(percent)}</span>
              {usedTokens != null && maxTokens != null && (
                <>
                  <span className="mx-1">·</span>
                  <span>
                    {formatTokens(usedTokens)}/{formatTokens(maxTokens)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-label={t('contextMeter.usage')}
          >
            <div
              className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
              style={{ width: `${percent}%`, backgroundColor: usageColor }}
            />
          </div>
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
        className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent text-foreground/65 outline-none transition-colors hover:bg-accent hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <span className="relative flex size-3 items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            className="absolute inset-0 size-full -rotate-90 transform-gpu"
            aria-hidden="true"
          >
            <circle
              cx="12" cy="12" r={radius} fill="none" strokeWidth="4.5"
              stroke="color-mix(in oklab, var(--foreground) 42%, transparent)"
            />
            <circle
              cx="12" cy="12" r={radius} fill="none" strokeWidth="4.5" strokeLinecap="round"
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
