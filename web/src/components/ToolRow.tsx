import { useState } from 'react';
import { Check, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ToolCall } from '@/api/types';

/** One quiet tool-call row: "python · done", expandable to command + output. */
export function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = call.status === 'running' ? LoaderCircle : call.status === 'error' ? CircleAlert : Check;
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[13px] font-medium text-ink-muted hover:text-ink transition-colors"
      >
        <Icon size={13} className={call.status === 'running' ? 'animate-spin' : call.status === 'error' ? 'text-red-400' : ''} />
        <span>{call.tool}</span>
        <span className="font-normal opacity-70">{call.status === 'running' ? 'running' : call.status}</span>
        <ChevronRight size={13} className={`opacity-60 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 ml-1 space-y-1.5">
          {call.command && (
            <pre className="rounded-lg bg-ink/5 px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.command}</pre>
          )}
          {call.output && (
            <pre className="rounded-lg bg-ink/5 px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap max-h-72 overflow-y-auto">{call.output}</pre>
          )}
        </div>
      )}
    </div>
  );
}
