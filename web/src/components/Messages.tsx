import { useEffect, useRef } from 'react';
import { useChat } from '@/state/chat';
import { Markdown } from './Markdown';
import { Thinking } from './Thinking';
import { ToolRow } from './ToolRow';

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden>
      <path d="M16 4L16 22L6 22Z" fill="var(--color-accent)" />
      <path d="M16 8L16 22L24 22Z" fill="var(--color-accent)" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="var(--color-accent)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Messages() {
  const messages = useChat((s) => s.messages);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Stick to the bottom while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 select-none">
        <Logo />
        <h1 className="text-2xl font-semibold">What can I help with?</h1>
      </div>
    );
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto" role="log" aria-live="polite">
      <div className="mx-auto flex w-full max-w-[800px] flex-col gap-5 px-4 py-6">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="ml-auto max-w-[70%] rounded-[18px] bg-surface px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="w-full">
              {m.thinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.content} />}
              {m.tools?.map((t, i) => <ToolRow key={i} call={t} />)}
              {m.content ? (
                <div className={m.error ? 'text-red-400' : ''}>
                  <Markdown text={m.content} />
                </div>
              ) : (
                m.streaming && !m.thinking && (
                  <div className="flex gap-1 py-2" aria-label="Generating">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:120ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:240ms]" />
                  </div>
                )
              )}
              {m.metrics && !m.streaming && (
                <div className="mt-1.5 text-xs text-ink-muted/70">
                  {m.metrics.tokens_per_second != null && `${m.metrics.tokens_per_second} tok/s`}
                  {m.metrics.response_time != null && ` · ${m.metrics.response_time}s`}
                  {m.metrics.context_percent != null && ` · ${m.metrics.context_percent}% ctx`}
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
