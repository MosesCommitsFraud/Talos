import { CheckIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import type { ToolCall } from '@/api/types';

/** One quiet tool-call row: "python · done", expandable to command + output. */
export function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = call.status === 'running' ? LoaderCircleIcon : call.status === 'error' ? CircleAlertIcon : CheckIcon;
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon
          className={`size-3.5 ${call.status === 'running' ? 'animate-spin' : call.status === 'error' ? 'text-destructive-foreground' : ''}`}
        />
        <span>{call.tool}</span>
        <span className="font-normal opacity-70">{call.status === 'running' ? 'running' : call.status}</span>
        <ChevronRightIcon className={`size-3.5 opacity-60 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 ml-1 space-y-1.5">
          {call.command && (
            <pre className="rounded-lg border bg-muted px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.command}</pre>
          )}
          {call.output && (
            <pre className="max-h-72 overflow-y-auto rounded-lg border bg-muted px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.output}</pre>
          )}
        </div>
      )}
    </div>
  );
}
