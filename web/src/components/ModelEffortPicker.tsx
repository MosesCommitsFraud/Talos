import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAppSettings, fetchModels } from '@/api/client';
import { useChat } from '@/state/chat';
import { REASONING_EFFORTS, usePrefs, type ReasoningEffort } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Menu, MenuItem, MenuLabel, MenuPopup, MenuSeparator, MenuSwitch, MenuTrigger, roomyMenuClass } from './ui/menu';
import { QwenIcon } from './ModelPicker';
import { useReasoningEfforts } from './EffortPicker';

function Tick({ on }: { on: boolean }) {
  return <CheckIcon aria-hidden className={cn('ms-auto size-3.5 shrink-0 text-primary', on ? 'opacity-100' : 'opacity-0')} />;
}

/** Model + reasoning in one control, Claude-style: the trigger reads
 *  "<model> <effort>" and its menu has two headed parts in the same chrome as
 *  the composer's "+" menu: the models (name, and the endpoint it runs on at
 *  the row's end), then how much the model thinks. With three effort levels
 *  the choice is laid out in the menu itself, one click each, rather than
 *  behind a submenu.
 *
 *  Models without the effort knob (Qwen3.6 and older — see `useReasoningEfforts`)
 *  get a plain Reasoning switch instead, and their trigger shows
 *  "Reasoning"/"No Reasoning" in the effort slot.
 *
 *  Stays mounted while hidden so the default-model effect keeps running. */
export function ModelEffortPicker({
  visible = true,
}: {
  visible?: boolean;
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
          // Full text colour for the model, so it stands clearly above the muted
          // effort beside it in both themes.
          className="group/model flex h-6 min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus:outline-none focus-visible:outline-none data-[state=open]:bg-accent"
        >
          <QwenIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 max-w-32 truncate text-left md:max-w-56">{modelLabel}</span>
          {/* The effort reads as a qualifier of the model, not a second control. */}
          <span className={cn('shrink-0 font-normal', reasoning ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
            {effortLabel}
          </span>
          <ChevronDownIcon className="-ms-0.5 size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/model:rotate-180" />
        </button>
      </MenuTrigger>

      <MenuPopup align="end" side="top" className={cn(roomyMenuClass, 'w-64 max-w-[calc(100vw-1.5rem)]')}>
        <MenuLabel>{t('modelPicker.model')}</MenuLabel>
        {options.length === 0 && (
          <div className="px-2 pb-1.5 text-xs text-muted-foreground">{t('modelPicker.noEndpoints')}</div>
        )}
        {options.map((o) => {
          const selected = pendingModel?.endpointId === o.endpointId && pendingModel.model === o.model;
          return (
            <MenuItem
              key={`${o.endpointId}:${o.model}`}
              role="menuitemradio"
              aria-checked={selected}
              onSelect={() => setPendingModel({ endpointId: o.endpointId, model: o.model })}
            >
              <QwenIcon className={cn('size-4 shrink-0', selected ? 'text-foreground' : 'text-muted-foreground')} />
              <span className={cn('min-w-0 truncate', selected && 'font-medium text-strong')}>{displayName(o.model)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{o.endpointName}</span>
              <Tick on={selected} />
            </MenuItem>
          );
        })}

        <MenuSeparator />

        {hasEffort ? (
          <>
            <MenuLabel title={t('composer.effort.help')}>{t('composer.effort.label')}</MenuLabel>
            {levels.map((level, i) => (
              <MenuItem
                key={level}
                role="menuitemradio"
                aria-checked={reasoning && effort === level}
                onSelect={() => {
                  // Picking a level is also asking for thinking — a level with
                  // reasoning off would silently do nothing.
                  if (!reasoning) toggle('reasoning');
                  setEffort(level);
                }}
              >
                <span className="min-w-0 truncate">{t(`composer.effort.levels.${level}`)}</span>
                {/* The two ends say which way the scale runs. */}
                {(i === 0 || i === levels.length - 1) && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {t(i === 0 ? 'composer.effort.faster' : 'composer.effort.smarter')}
                  </span>
                )}
                <Tick on={reasoning && effort === level} />
              </MenuItem>
            ))}
            <MenuItem
              role="menuitemradio"
              aria-checked={!reasoning}
              title={t('composer.reasoning.offDesc')}
              onSelect={() => { if (reasoning) toggle('reasoning'); }}
            >
              <span className="min-w-0 flex-1 truncate">{t('composer.reasoning.off')}</span>
              <Tick on={!reasoning} />
            </MenuItem>
          </>
        ) : (
          // No effort knob on this model: one row for the only decision there is.
          <MenuItem
            role="menuitemcheckbox"
            aria-checked={reasoning}
            title={reasoning ? t('composer.reasoning.onDesc') : t('composer.reasoning.offDesc')}
            onSelect={(e) => {
              e.preventDefault();
              toggle('reasoning');
            }}
          >
            <span className="min-w-0 flex-1 truncate">{t('composer.reasoning.on')}</span>
            <MenuSwitch on={reasoning} />
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
