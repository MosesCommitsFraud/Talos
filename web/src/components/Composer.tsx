import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { useChat } from '@/state/chat';
import { ModelPicker } from './ModelPicker';

export function Composer() {
  const [text, setText] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const queryClient = useQueryClient();

  const autoresize = () => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || streaming) return;
    setText('');
    requestAnimationFrame(autoresize);
    await send(value, () => queryClient.invalidateQueries({ queryKey: ['sessions'] }));
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  return (
    <div className="mx-auto w-full max-w-[800px] px-4 pb-4">
      <div className="rounded-[28px] bg-surface px-4 pt-3.5 pb-2.5 shadow-[0_2px_16px_rgba(0,0,0,0.18)]">
        <div className="flex items-start">
          <textarea
            ref={textarea}
            value={text}
            rows={1}
            autoFocus
            placeholder="Message Talos…"
            aria-label="Message input"
            onChange={(e) => { setText(e.target.value); autoresize(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            className="max-h-[200px] min-h-[26px] w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-ink/45"
          />
          <ModelPicker />
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <button
            type="button"
            title="Attach files (coming to the new UI soon — use /legacy)"
            aria-label="Attach files"
            disabled
            className="flex size-9 items-center justify-center rounded-full text-ink/40 cursor-not-allowed"
          >
            <Paperclip size={18} />
          </button>
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop generating"
              className="flex size-9 items-center justify-center rounded-full bg-ink text-base text-black transition-colors hover:bg-ink/85"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!text.trim()}
              aria-label="Send message"
              className="flex size-9 items-center justify-center rounded-full bg-ink text-black transition-all hover:bg-ink/85 disabled:opacity-30"
            >
              <ArrowUp size={18} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
