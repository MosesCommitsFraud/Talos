import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAppSettings, fetchModels } from '@/api/client';
import { useChat } from '@/state/chat';
import { REASONING_EFFORTS, usePrefs, type ReasoningEffort } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from './ui/menu';
import { QwenIcon } from './ModelPicker';
import { useReasoningEfforts } from './EffortPicker';

/** Model + reasoning in one control, Claude-style: the trigger reads
 *  "<model> <effort>" and its menu lists the models, with the thinking budget
 *  behind an Effort submenu. Replaces the old pair of adjacent pickers so the
 *  composer's inner control row stays short.
 *
 *  Models without the effort knob (Qwen3.6 and older — see `useReasoningEfforts`)
 *  get a plain Reasoning on/off row instead of the submenu, and their trigger
 *  shows "Reasoning"/"No Reasoning" in the effort slot.
 *
 *  Stays mounted while hidden so the default-model effect keeps running. */
export function ModelEffortPicker({
  visible = true,
  placement = 'inside',
}: {
  visible?: boolean;
  /** Inside the input box (new-chat bar) or in the quieter row beneath it. */
  placement?: 'inside' | 'outside';
}) {
  const { t } = useTranslation();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const pendingModel = useChat((s) => s.pendingModel);
  const setPendingModel = useChat((s) => s.setPendingModel);
  const { data: appSettings } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings });
  const modelNames = (appSettings?.model_display_names ?? {}) as Record<string, string>;
  const displayName = (model: string) => modelNames[model]?.trim() || model;

  const reasoning = usePrefs((s) => s.reasoning);
  const toggle = usePrefs((s) => s.toggle);
  const effort = usePrefs((s) => s.reasoningEffort);
  const setEffort = usePrefs((s) => s.setReasoningEffort);

  const probed = useReasoningEfforts();
  const hasEffort = probed.length > 1;
  const levels: ReasoningEffort[] = hasEffort ? probed : REASONING_EFFORTS;

  const options = (endpoints ?? [])
    .filter((e) => e.is_enabled && e.model_type !== 'embedding')
    .flatMap((e) => e.models.map((model) => ({ endpointId: e.id, endpointName: e.name, model })));

  // Default to the first available model.
  useEffect(() => {
    if (!pendingModel && options.length > 0) {
      setPendingModel({ endpointId: options[0].endpointId, model: options[0].model });
    }
  }, [options.length, pendingModel, setPendingModel]);

  if (!visible) return null;

  const modelLabel = pendingModel ? displayName(pendingModel.model) : t('modelPicker.selectModel');
  const effortLabel = !reasoning
    ? t('composer.reasoning.off')
    : hasEffort
      ? t(`composer.effort.levels.${effort}`)
      : t('composer.reasoning.on');

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('modelPicker.switchModel')}
          // Roomier than the old ghost pickers, but it steps down outside the
          // box, where it sits next to the disclaimer rather than the send key.
          className={cn(
            'flex min-w-0 shrink items-center whitespace-nowrap rounded-lg border border-transparent font-medium text-foreground/80 outline-none transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none dark:text-foreground/70',
            placement === 'inside' ? 'h-7 gap-1.5 px-2.5 text-sm' : 'h-6 gap-1.5 px-2 text-xs',
          )}
        >
          <QwenIcon className={cn('shrink-0', placement === 'inside' ? 'size-4' : 'size-3.5')} />
          <span className="min-w-0 max-w-32 truncate text-left md:max-w-56">{modelLabel}</span>
          {/* The effort reads as a qualifier of the model, not a second control. */}
          <span className={cn('shrink-0 font-normal', reasoning ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
            {effortLabel}
          </span>
          <ChevronDownIcon
            className={cn('shrink-0 opacity-60', placement === 'inside' ? 'size-3.5' : 'size-3')}
            aria-hidden="true"
          />
        </button>
      </MenuTrigger>

      <MenuPopup align="end" className="min-w-52">
        {options.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">{t('modelPicker.noEndpoints')}</div>
        )}
        {options.map((o) => {
          const selected = pendingModel?.endpointId === o.endpointId && pendingModel.model === o.model;
          return (
            <MenuItem
              key={`${o.endpointId}:${o.model}`}
              onSelect={() => setPendingModel({ endpointId: o.endpointId, model: o.model })}
            >
              <QwenIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {displayName(o.model)}
                <span className="text-muted-foreground"> · {o.endpointName}</span>
              </span>
              <CheckIcon className={cn('size-3.5 shrink-0 text-primary', selected ? 'opacity-100' : 'opacity-0')} />
            </MenuItem>
          );
        })}

        {options.length > 0 && <MenuSeparator />}

        {hasEffort ? (
          <MenuSub>
            <MenuSubTrigger>
              <span className="min-w-0 flex-1 truncate">{t('composer.effort.label')}</span>
              <span className="shrink-0 text-muted-foreground">{effortLabel}</span>
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-40">
              {levels.map((level) => (
                <MenuItem
                  key={level}
                  onSelect={() => {
                    // Picking a level is also asking for thinking — a level with
                    // reasoning off would silently do nothing.
                    if (!reasoning) toggle('reasoning');
                    setEffort(level);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{t(`composer.effort.levels.${level}`)}</span>
                  <CheckIcon
                    className={cn(
                      'size-3.5 shrink-0 text-primary',
                      reasoning && effort === level ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => { if (reasoning) toggle('reasoning'); }}>
                <span className="min-w-0 flex-1 truncate">{t('composer.reasoning.off')}</span>
                <CheckIcon className={cn('size-3.5 shrink-0 text-primary', reasoning ? 'opacity-0' : 'opacity-100')} />
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        ) : (
          // No effort knob on this model: one row for the only decision there is.
          <MenuItem onSelect={() => toggle('reasoning')}>
            <span className="min-w-0 flex-1 truncate">{t('composer.reasoning.on')}</span>
            <CheckIcon className={cn('size-3.5 shrink-0 text-primary', reasoning ? 'opacity-100' : 'opacity-0')} />
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
