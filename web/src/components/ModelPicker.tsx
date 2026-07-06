import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAppSettings, fetchModels } from '@/api/client';
import { useChat } from '@/state/chat';
import { cn } from '@/lib/utils';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './ui/menu';

/** Qwen brand mark (simple-icons), fill follows currentColor. */
export function QwenIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" />
    </svg>
  );
}

/** t3code-style model picker trigger: provider logo + model name + chevron,
 *  quiet ghost styling. Stays mounted even when hidden so the default-model
 *  effect keeps running. */
export function ModelPicker({ visible = true }: { visible?: boolean }) {
  const { t } = useTranslation();
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const pendingModel = useChat((s) => s.pendingModel);
  const setPendingModel = useChat((s) => s.setPendingModel);
  const { data: appSettings } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings });
  const modelNames = (appSettings?.model_display_names ?? {}) as Record<string, string>;
  const displayName = (model: string) => modelNames[model]?.trim() || model;

  const options = (endpoints ?? [])
    .filter((e) => e.is_enabled && e.model_type !== 'embedding')
    .flatMap((e) => e.models.map((model) => ({ endpointId: e.id, endpointName: e.name, model })));

  // Default to the first available model.
  useEffect(() => {
    if (!pendingModel && options.length > 0) {
      setPendingModel({ endpointId: options[0].endpointId, model: options[0].model });
    }
  }, [options.length, pendingModel, setPendingModel]);

  const label = pendingModel ? displayName(pendingModel.model) : t('modelPicker.selectModel');

  if (!visible) return null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('modelPicker.switchModel')}
          className="flex h-7 max-w-32 shrink-0 items-center justify-between gap-1.5 whitespace-nowrap rounded-md border border-transparent px-1.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80 sm:h-6 sm:px-2 md:max-w-56"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <QwenIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuPopup align="start">
        {options.length === 0 && (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">{t('modelPicker.noEndpoints')}</div>
        )}
        {options.map((o) => {
          const selected =
            pendingModel?.endpointId === o.endpointId && pendingModel.model === o.model;
          return (
            <MenuItem
              key={`${o.endpointId}:${o.model}`}
              onSelect={() => setPendingModel({ endpointId: o.endpointId, model: o.model })}
              className="gap-2"
            >
              <QwenIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{displayName(o.model)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {displayName(o.model) !== o.model ? `${o.model} · ${o.endpointName}` : o.endpointName}
                </div>
              </div>
              <CheckIcon className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
