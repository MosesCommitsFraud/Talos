import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

/** GPT-style quiet disclosure for the model's reasoning. */
export function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[13px] font-medium text-ink-muted hover:text-ink transition-colors"
      >
        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {streaming ? 'Thinking…' : 'View thinking'}
      </button>
      {open && (
        <div className="mt-1.5 ml-1.5 border-l-2 border-edge pl-3.5 text-[13.5px] leading-relaxed text-ink-muted whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
