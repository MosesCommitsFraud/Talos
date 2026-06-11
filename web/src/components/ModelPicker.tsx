import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useEffect } from 'react';
import { fetchModels } from '@/api/client';
import { useChat } from '@/state/chat';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './ui/menu';

/** Quiet ghost-pill model selector for the composer. Stays mounted even when
 *  hidden so the default-model effect keeps running. */
export function ModelPicker({ visible = true }: { visible?: boolean }) {
  const { data: endpoints } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const pendingModel = useChat((s) => s.pendingModel);
  const setPendingModel = useChat((s) => s.setPendingModel);

  const options = (endpoints ?? [])
    .filter((e) => e.is_enabled && e.model_type !== 'embedding')
    .flatMap((e) => e.models.map((model) => ({ endpointId: e.id, endpointName: e.name, model })));

  // Default to the first available model.
  useEffect(() => {
    if (!pendingModel && options.length > 0) {
      setPendingModel({ endpointId: options[0].endpointId, model: options[0].model });
    }
  }, [options.length, pendingModel, setPendingModel]);

  const label = pendingModel?.model ?? 'Select model';

  if (!visible) return null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch model"
          className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {label}
          <ChevronDownIcon className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuPopup align="end">
        {options.length === 0 && (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">No model endpoints configured</div>
        )}
        {options.map((o) => (
          <MenuItem
            key={`${o.endpointId}:${o.model}`}
            onSelect={() => setPendingModel({ endpointId: o.endpointId, model: o.model })}
            className="flex-col items-start gap-0"
          >
            <div>{o.model}</div>
            <div className="text-xs text-muted-foreground">{o.endpointName}</div>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
