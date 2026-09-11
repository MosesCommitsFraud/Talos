import { useQuery } from '@tanstack/react-query';
import { HelpCircleIcon } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchReasoningEfforts } from '@/api/client';
import { useChat } from '@/state/chat';
import { REASONING_EFFORTS, usePrefs, type ReasoningEffort } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Menu, MenuPopup, MenuTrigger } from './ui/menu';
import { Switch, Tooltip } from './ui/misc';

/** The effort levels the currently selected model honours — `[]` while the probe
 *  is in flight, for a model without the knob, or when the probe can't run.
 *
 *  Not every Qwen generation has it: Qwen3.8's chat template renders a per-level
 *  reasoning instruction, Qwen3.6's only knows `enable_thinking`. The served
 *  model name doesn't distinguish them (the same alias has pointed at both), so
 *  the backend measures it against the endpoint and caches the answer. Callers
 *  fall back to the plain thinking toggle, which every generation understands. */
export function useReasoningEfforts(): ReasoningEffort[] {
  const pendingModel = useChat((s) => s.pendingModel);
  const { data } = useQuery({
    queryKey: ['reasoning-efforts', pendingModel?.endpointId, pendingModel?.model],
    queryFn: () => fetchReasoningEfforts(pendingModel!.endpointId, pendingModel!.model),
    enabled: !!pendingModel,
    // The probe costs three one-token completions upstream; the answer only
    // changes when the endpoint is re-pointed at another checkpoint.
    staleTime: 15 * 60_000,
    retry: false,
  });
  return data?.efforts ?? [];
}

/** Reasoning control beside the model picker — one button for both halves of the
 *  same decision: a switch that turns thinking on or off, and a slider from
 *  "Faster" to "Smarter" over the levels the model actually accepts.
 *
 *  Only rendered for models that have the effort knob; Composer shows a plain
 *  Thinking/No-Thinking toggle for the ones that don't. The stops come from the
 *  probe rather than the constant, so a model with a different set still lines
 *  up; REASONING_EFFORTS is the fallback and mirrors
 *  llm_core.QWEN_REASONING_EFFORTS. With thinking off the model never opens a
 *  <think> block, so the slider greys out but stays readable. */
export function EffortPicker() {
  const { t } = useTranslation();
  const reasoning = usePrefs((s) => s.reasoning);
  const toggle = usePrefs((s) => s.toggle);
  const effort = usePrefs((s) => s.reasoningEffort);
  const setEffort = usePrefs((s) => s.setReasoningEffort);
  const trackRef = useRef<HTMLDivElement>(null);

  const probed = useReasoningEfforts();
  const levels = probed.length > 1 ? probed : REASONING_EFFORTS;

  const index = Math.max(0, levels.indexOf(effort));
  const last = levels.length - 1;
  const name = (e: ReasoningEffort) => t(`composer.effort.levels.${e}`);
  const label = name(effort);

  /** Map a pointer x within the track to the nearest stop. */
  const pickFromPointer = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      // The stops live inside the handle-width inset (left-3/right-3).
      const inset = 12;
      const span = rect.width - inset * 2;
      if (span <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left - inset) / span));
      setEffort(levels[Math.round(ratio * last)]);
    },
    [last, levels, setEffort],
  );

  return (
    <Menu>
      <Tooltip
        label={reasoning ? t('composer.effort.tooltip') : t('composer.reasoning.offDesc')}
        side="top"
      >
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={t('composer.effort.label')}
            className={cn(
              'flex h-6 shrink-0 items-center pt-[2px] gap-1.5 whitespace-nowrap rounded-[4.5px] border border-transparent px-1 text-xs font-medium outline-none transition-colors focus:outline-none focus-visible:outline-none sm:h-5 sm:px-1.5',
              'hover:bg-accent',
              reasoning
                ? 'text-foreground/80 hover:text-foreground/90 dark:text-foreground/65'
                // Thinking off is a real state, not a disabled control: dimmer
                // than the on state, still legible and still clickable.
                : 'text-foreground/45 hover:text-foreground/60 dark:text-foreground/40',
            )}
          >
            {reasoning ? label : t('composer.reasoning.off')}
          </button>
        </MenuTrigger>
      </Tooltip>

      {/* Wider than a menu because the body is a switch and a slider, not rows.
          Arrow keys belong to the slider here, so they never reach Radix's
          roving focus. */}
      <MenuPopup
        align="end"
        className="w-60 p-3"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            if (!reasoning) return;
            const next = index + (e.key === 'ArrowRight' ? 1 : -1);
            if (next >= 0 && next <= last) setEffort(levels[next]);
          }
        }}
      >
        {/* Thinking on/off — the switch the slider depends on, so it comes first. */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('composer.reasoning.on')}</span>
          <Tooltip label={reasoning ? t('composer.reasoning.onDesc') : t('composer.reasoning.offDesc')} side="top">
            <span className="ms-auto flex items-center">
              <Switch
                checked={reasoning}
                onCheckedChange={() => toggle('reasoning')}
                aria-label={t('composer.reasoning.label')}
              />
            </span>
          </Tooltip>
        </div>

        <div className="my-2.5 h-px bg-border" />

        <div className={cn('transition-opacity', !reasoning && 'pointer-events-none opacity-40')}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{t('composer.effort.label')}</span>
            <span className="text-sm text-muted-foreground">{label}</span>
            <Tooltip label={t('composer.effort.help')} side="top">
              <span className="ms-auto text-muted-foreground/70">
                <HelpCircleIcon className="size-3.5" />
              </span>
            </Tooltip>
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t('composer.effort.faster')}</span>
            <span>{t('composer.effort.smarter')}</span>
          </div>

          {/* Slider: one dot per level, a pill handle on the active one. The
              handle carries the ARIA state; the dots are just the track. */}
          <div
            ref={trackRef}
            className="relative mt-2 flex h-7 cursor-pointer items-center touch-none select-none"
            onPointerDown={(e) => {
              pickFromPointer(e.clientX);
              // Capture so a drag that leaves the track keeps steering it.
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) pickFromPointer(e.clientX);
            }}
          >
            <div className="absolute inset-0 rounded-lg bg-muted/70 dark:bg-foreground/[0.07]" />
            {/* Inset by half a handle so the first and last stop sit where the
                handle can actually reach them. */}
            <div className="absolute inset-y-0 left-3 right-3">
              <div className="flex h-full items-center justify-between">
                {levels.map((level, i) => (
                  <span
                    key={level}
                    aria-hidden="true"
                    className={cn(
                      'size-1 rounded-full transition-opacity',
                      // Top of the range gets the accent, the rest are plain
                      // stops; the one under the handle would only show through.
                      i === last ? 'bg-primary' : 'bg-foreground/30',
                      i === index && 'opacity-0',
                    )}
                  />
                ))}
              </div>
              <div
                role="slider"
                tabIndex={reasoning ? 0 : -1}
                aria-label={t('composer.effort.label')}
                aria-valuemin={0}
                aria-valuemax={last}
                aria-valuenow={index}
                aria-valuetext={label}
                aria-disabled={!reasoning}
                className={cn(
                  'absolute top-1/2 h-[22px] w-6 -translate-x-1/2 -translate-y-1/2 rounded-[7px] shadow-sm outline-none transition-[left] duration-150 ease-out',
                  'bg-foreground/75 dark:bg-foreground/60',
                  'ring-offset-1 ring-offset-popover focus-visible:ring-2 focus-visible:ring-primary/60',
                )}
                style={{ left: `${(index / last) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </MenuPopup>
    </Menu>
  );
}
