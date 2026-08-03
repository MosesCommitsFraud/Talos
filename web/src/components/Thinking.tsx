import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Quiet disclosure for the model's reasoning, built like ToolGroup so the two
 *  kinds of "what the agent did" read as one control: a muted label with a
 *  trailing chevron, opening into a bordered panel. While the model is still
 *  thinking the label shimmers, the same signal a running tool group gives. */
export function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className={`min-w-0 truncate ${streaming ? 'shimmer-text' : ''}`}>
          {streaming ? t('thinking.thinking') : t('thinking.view')}
        </span>
        <ChevronDownIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg border px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}
