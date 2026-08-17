import { HelpCircleIcon } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { REASONING_EFFORTS, usePrefs, type ReasoningEffort } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Menu, MenuPopup, MenuTrigger } from './ui/menu';
import { Tooltip } from './ui/misc';

/** Thinking-budget picker beside the model picker: a small slider from
 *  "Faster" to "Smarter" over the model's reasoning-effort levels (Qwen3.8:
 *  low · medium · xhigh). Only meaningful while reasoning is on — with thinking
 *  off the model never opens a <think> block, so the control greys out. */
export function EffortPicker() {
  const { t } = useTranslation();
  const reasoning = usePrefs((s) => s.reasoning);
  const effort = usePrefs((s) => s.reasoningEffort);
  const setEffort = usePrefs((s) => s.setReasoningEffort);
  const trackRef = useRef<HTMLDivElement>(null);

  const index = Math.max(0, REASONING_EFFORTS.indexOf(effort));
  const last = REASONING_EFFORTS.length - 1;
  const name = (e: ReasoningEffort) => t(`composer.effort.levels.${e}`);

  /** Map a pointer x within the track to the nearest stop. */
  const pickFromPointer = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      // The stops live inside the handle-width inset (left-2.5/right-2.5).
      const inset = 10;
      const span = rect.width - inset * 2;
      if (span <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left - inset) / span));
      setEffort(REASONING_EFFORTS[Math.round(ratio * last)]);
    },
    [last, setEffort],
  );

  const label = name(effort);

  return (
    <Menu>
      <Tooltip label={reasoning ? t('composer.effort.tooltip') : t('composer.effort.tooltipOff')} side="top">
        <MenuTrigger asChild>
          <button
            type="button"
            disabled={!reasoning}
            aria-label={t('composer.effort.label')}
            className={cn(
              'flex h-6 shrink-0 items-center pt-[2px] gap-1.5 whitespace-nowrap rounded-[4.5px] border border-transparent px-1 text-xs font-medium transition-colors sm:h-5 sm:px-1.5',
              'text-foreground/80 hover:bg-accent hover:text-foreground/90 dark:text-foreground/65',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            {label}
          </button>
        </MenuTrigger>
      </Tooltip>

      {/* Wider than a menu because the body is a slider, not rows. Arrow keys
          belong to the slider here, so they never reach Radix's roving focus. */}
      <MenuPopup
        align="end"
        className="w-56 p-3"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            const next = index + (e.key === 'ArrowRight' ? 1 : -1);
            if (next >= 0 && next <= last) setEffort(REASONING_EFFORTS[next]);
          }
        }}
      >
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
          className="relative mt-2 flex h-6 cursor-pointer items-center"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pickFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) pickFromPointer(e.clientX);
          }}
        >
          <div className="absolute inset-0 rounded-md bg-muted/60" />
          {/* Inset by half a handle so the first and last stop sit where the
              handle can actually reach them. */}
          <div className="absolute inset-y-0 left-2.5 right-2.5">
            <div className="flex h-full items-center justify-between">
              {REASONING_EFFORTS.map((level, i) => (
                <span
                  key={level}
                  aria-hidden="true"
                  className={cn('size-1 rounded-full', i === last ? 'bg-primary' : 'bg-foreground/30')}
                />
              ))}
            </div>
            <div
              role="slider"
              tabIndex={0}
              aria-label={t('composer.effort.label')}
              aria-valuemin={0}
              aria-valuemax={last}
              aria-valuenow={index}
              aria-valuetext={label}
              className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-md bg-foreground/70 shadow-sm transition-[left] duration-100"
              style={{ left: `${(index / last) * 100}%` }}
            />
          </div>
        </div>
      </MenuPopup>
    </Menu>
  );
}
