import { useChat } from '@/state/chat';
import { Tooltip } from './ui/misc';

/* MIDA's ContextWindowMeter, bridged to Talos metrics: a small ring in the
 * composer showing how full the model's context window is, with the detail
 * (percent · used/max tokens) in the tooltip. Replaces the old "ctx%" text. */

function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '0';
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

export function ContextMeter() {
  const messages = useChat((s) => s.messages);

  // Latest assistant metrics carry the running context state of the session.
  const metrics = [...messages].reverse().find((m) => m.metrics?.context_percent != null)?.metrics;
  if (!metrics || metrics.context_percent == null) return null;

  const percent = Math.max(0, Math.min(100, metrics.context_percent));
  const maxTokens = metrics.context_length ?? null;
  const usedTokens = maxTokens != null ? Math.round((percent / 100) * maxTokens) : null;

  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percent / 100) * circumference;
  const high = percent >= 85;

  return (
    <Tooltip
      side="top"
      label={
        <div className="space-y-1 px-0.5 py-0.5 leading-tight">
          <div className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Context window
          </div>
          <div className="text-xs font-medium whitespace-nowrap">
            {percent < 10 ? percent.toFixed(1).replace(/\.0$/, '') : Math.round(percent)}%
            {usedTokens != null && maxTokens != null && (
              <>
                <span className="mx-1">·</span>
                {formatTokens(usedTokens)}/{formatTokens(maxTokens)} used
              </>
            )}
          </div>
        </div>
      }
    >
      <span
        role="img"
        aria-label={`Context window ${Math.round(percent)}% used`}
        className="relative mr-1 flex size-6 shrink-0 cursor-default items-center justify-center"
      >
        <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90 transform-gpu" aria-hidden="true">
          <circle
            cx="12" cy="12" r={radius} fill="none" strokeWidth="3"
            stroke="color-mix(in oklab, var(--muted) 70%, transparent)"
          />
          <circle
            cx="12" cy="12" r={radius} fill="none" strokeWidth="3" strokeLinecap="round"
            stroke={high ? 'var(--warning)' : 'var(--muted-foreground)'}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
          />
        </svg>
        <span className="relative flex size-4 items-center justify-center rounded-full text-[8px] font-medium text-muted-foreground">
          {Math.round(percent)}
        </span>
      </span>
    </Tooltip>
  );
}
