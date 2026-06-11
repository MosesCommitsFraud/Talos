import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect } from 'react';
import { fetchModels } from '@/api/client';
import { useChat } from '@/state/chat';

/** Quiet ghost-pill model selector for the composer (Radix dropdown). */
export function ModelPicker() {
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

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[13px] text-ink-muted hover:bg-ink/8 hover:text-ink transition-colors"
          aria-label="Switch model"
        >
          {label}
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-52 rounded-xl border border-ink/10 bg-panel p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        >
          {options.length === 0 && (
            <div className="px-3 py-2 text-[13px] text-ink-muted">No model endpoints configured</div>
          )}
          {options.map((o) => (
            <DropdownMenu.Item
              key={`${o.endpointId}:${o.model}`}
              onSelect={() => setPendingModel({ endpointId: o.endpointId, model: o.model })}
              className="cursor-pointer rounded-lg px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-ink/8"
            >
              <div>{o.model}</div>
              <div className="text-xs text-ink-muted">{o.endpointName}</div>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
