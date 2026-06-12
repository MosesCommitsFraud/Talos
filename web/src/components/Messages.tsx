import { CheckIcon, CopyIcon, FileIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { artifactDownloadUrl, fetchArtifacts, uploadDownloadUrl } from '@/api/client';
import { useChat, type UiMessage } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { Markdown } from './Markdown';
import { Thinking } from './Thinking';
import { ToolRow, toolImages, type ToolImage } from './ToolRow';
import { Tooltip } from './ui/misc';
import { Button } from './ui/button';

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden>
      <path d="M16 4L16 22L6 22Z" fill="var(--primary)" />
      <path d="M16 8L16 22L24 22Z" fill="var(--primary)" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="var(--primary)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function ActionIcon({
  label,
  onClick,
  children,
  destructive,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent ${
          destructive ? 'hover:text-destructive-foreground' : 'hover:text-foreground'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <ActionIcon
      label={copied ? 'Copied' : 'Copy'}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </ActionIcon>
  );
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentList({ msg }: { msg: UiMessage }) {
  if (!msg.attachments?.length) return null;
  return (
    <div className="mt-1 flex max-w-full flex-wrap justify-end gap-1.5">
      {msg.attachments.map((file) => (
        <a
          key={file.id}
          href={uploadDownloadUrl(file.id)}
          download
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FileIcon className="size-3.5 shrink-0" />
          <span className="max-w-48 truncate">{file.name || file.id}</span>
          {file.size != null && <span className="shrink-0 opacity-70">{formatSize(file.size)}</span>}
        </a>
      ))}
    </div>
  );
}

function MessageActions({ msg, onEdit, copyText }: { msg: UiMessage; onEdit?: () => void; copyText?: string }) {
  const remove = useChat((s) => s.remove);
  const canMutate = !!msg.dbId;
  return (
    <>
      <CopyAction text={copyText ?? msg.content} />
      {onEdit && canMutate && (
        <ActionIcon label="Edit message" onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </ActionIcon>
      )}
      {canMutate && (
        <ActionIcon label="Delete message" destructive onClick={() => void remove(msg.id).catch(console.error)}>
          <Trash2Icon className="size-3.5" />
        </ActionIcon>
      )}
    </>
  );
}

function EditBox({ msg, onDone }: { msg: UiMessage; onDone: () => void }) {
  const [draft, setDraft] = useState(msg.content);
  const edit = useChat((s) => s.edit);
  const save = async () => {
    const value = draft.trim();
    if (value && value !== msg.content) await edit(msg.id, value).catch(console.error);
    onDone();
  };
  return (
    <div className="w-full rounded-2xl border border-ring bg-card p-3">
      <textarea
        autoFocus
        value={draft}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') onDone();
        }}
        className="w-full resize-y bg-transparent text-[15px] leading-relaxed outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        <Button size="sm" onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

function FinalImageGrid({ images }: { images: ToolImage[] }) {
  if (images.length === 0) return null;
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {images.map((image, i) => (
        <a
          key={`${image.src.slice(0, 48)}-${i}`}
          href={image.src}
          target="_blank"
          rel="noreferrer"
          className="overflow-hidden rounded-xl border bg-card"
        >
          <img src={image.src} alt={image.label || `Generated image ${i + 1}`} className="max-h-96 w-full object-contain" />
          {image.label && <div className="truncate border-t px-2 py-1 text-xs text-muted-foreground">{image.label}</div>}
        </a>
      ))}
    </div>
  );
}

export function Messages() {
  const sessionId = useChat((s) => s.sessionId);
  const messages = useChat((s) => s.messages);
  const showMetrics = usePrefs((s) => s.visibility.messageMetrics);
  const showWelcome = usePrefs((s) => s.visibility.welcomeText);
  const showThinking = usePrefs((s) => s.visibility.showThinking);
  const [editing, setEditing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const { data: artifacts } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => fetchArtifacts(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 10_000,
  });

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
        {showWelcome && (
          <>
            <Logo />
            <h1 className="text-2xl font-semibold tracking-tight">What can I help with?</h1>
          </>
        )}
      </div>
    );
  }

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const inputPaths = new Set(
    messages.flatMap((m) => m.role === 'user'
      ? (m.attachments ?? []).flatMap((f) => [f.sandbox_path, f.name].filter((v): v is string => !!v))
      : []),
  );
  const artifactImages: ToolImage[] = sessionId
    ? (artifacts ?? []).flatMap((f) => {
        const path = String(f.path ?? f.name ?? '');
        const mime = String(f.mime ?? '');
        const isImage = f.is_image || mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
        return path && isImage && !inputPaths.has(path)
          ? [{ src: artifactDownloadUrl(sessionId, path), label: path }]
          : [];
      })
    : [];
  const isAssistantTurnEnd = (index: number) => messages[index].role === 'assistant' && messages[index + 1]?.role !== 'assistant';
  const assistantTurnStart = (index: number) => {
    let start = index;
    while (start > 0 && messages[start - 1].role === 'assistant') start -= 1;
    return start;
  };
  const assistantTurnText = (index: number) => {
    const start = assistantTurnStart(index);
    return messages.slice(start, index + 1).map((msg) => msg.content.trim()).filter(Boolean).join('\n\n');
  };
  const assistantTurnImages = (index: number) => {
    const start = assistantTurnStart(index);
    return messages.slice(start, index + 1).flatMap((msg) => (msg.tools ?? []).flatMap(toolImages));
  };

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto" role="log" aria-live="polite">
      <div className="mx-auto flex w-full max-w-[800px] flex-col px-4 py-6">
        {messages.map((m, index) =>
          m.role === 'user' ? (
            <div key={m.id} className={`group ml-auto flex w-full max-w-[75%] flex-col items-end gap-0.5 ${index === 0 ? '' : 'mt-3'}`}>
              {editing === m.id ? (
                <EditBox msg={m} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <div className="rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                    {m.content}
                  </div>
                  <AttachmentList msg={m} />
                  <div className="flex">
                    <MessageActions msg={m} onEdit={() => setEditing(m.id)} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div key={m.id} className={`group w-full ${index === 0 ? '' : messages[index - 1].role === 'assistant' ? 'mt-1' : 'mt-3'}`}>
              {m.thinking && showThinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.content} />}
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
              {!m.streaming && isAssistantTurnEnd(index) && (() => {
                const toolFinalImages = assistantTurnImages(index);
                const finalImages = toolFinalImages.length > 0 || m.id !== lastAssistantId ? toolFinalImages : artifactImages;
                const copyText = assistantTurnText(index);
                return (
                  <>
                    <FinalImageGrid images={finalImages} />
                    {copyText && (
                      <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <MessageActions msg={m} copyText={copyText} />
                        {showMetrics && m.metrics && (
                          <span className="text-xs text-muted-foreground/80">
                            {m.metrics.tokens_per_second != null && `${m.metrics.tokens_per_second} tok/s`}
                            {m.metrics.response_time != null && ` · ${m.metrics.response_time}s`}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
