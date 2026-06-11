import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useChat } from '@/state/chat';
import { Markdown } from './Markdown';
import { Thinking } from './Thinking';
import { ToolRow } from './ToolRow';
import { Tooltip } from './ui/misc';

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden>
      <path d="M16 4L16 22L6 22Z" fill="var(--primary)" />
      <path d="M16 8L16 22L24 22Z" fill="var(--primary)" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="var(--primary)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? 'Copied' : 'Copy'} side="top">
      <button
        type="button"
        aria-label="Copy message"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </Tooltip>
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
        <h1 className="text-2xl font-semibold tracking-tight">What can I help with?</h1>
      </div>
    );
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto" role="log" aria-live="polite">
      <div className="mx-auto flex w-full max-w-[800px] flex-col gap-5 px-4 py-6">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="group ml-auto flex max-w-[75%] flex-col items-end gap-0.5">
              <div className="rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                {m.content}
              </div>
              <CopyButton text={m.content} />
            </div>
          ) : (
            <div key={m.id} className="group w-full">
              {m.thinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.content} />}
              {m.tools?.map((t, i) => <ToolRow key={i} call={t} />)}
              {m.content ? (
                <div className={m.error ? 'text-destructive-foreground' : ''}>
                  <Markdown text={m.content} />
                </div>
              ) : (
                m.streaming && !m.thinking && (
                  <div className="flex gap-1 py-2" aria-label="Generating">
                    <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:120ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:240ms]" />
                  </div>
                )
              )}
              {!m.streaming && m.content && (
                <div className="mt-1 flex items-center gap-2">
                  <CopyButton text={m.content} />
                  {m.metrics && (
                    <span className="text-xs text-muted-foreground/80 opacity-0 transition-opacity group-hover:opacity-100">
                      {m.metrics.tokens_per_second != null && `${m.metrics.tokens_per_second} tok/s`}
                      {m.metrics.response_time != null && ` · ${m.metrics.response_time}s`}
                      {m.metrics.context_percent != null && ` · ${m.metrics.context_percent}% ctx`}
                    </span>
                  )}
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
