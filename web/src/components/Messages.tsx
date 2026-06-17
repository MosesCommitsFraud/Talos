import { CheckIcon, ChevronDownIcon, CopyIcon, FileIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { artifactDownloadUrl, fetchArtifacts, uploadDownloadUrl } from '@/api/client';
import { copyTextToClipboard } from '@/lib/utils';
import { useChat, type UiMessage } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { Markdown } from './Markdown';
import { RagSources } from './RagSources';
import { Thinking } from './Thinking';
import { ToolRow, toolImages, type ToolImage } from './ToolRow';
import { Tooltip } from './ui/misc';
import { Button } from './ui/button';

/** Compact elapsed label: "12s", "3m 5s", "1h 4m". */
function formatWorkingElapsed(startMs: number, nowMs: number): string {
  const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Self-ticking "Working for Xs" label — updates its own text node each second
 *  so the streaming message tree isn't re-committed every tick (t3code style). */
function WorkingTimer({ startedAt }: { startedAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = formatWorkingElapsed(startedAt, Date.now());
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span ref={ref} className="tabular-nums">{formatWorkingElapsed(startedAt, Date.now())}</span>;
}

/** Persistent "still running" indicator shown for the whole assistant turn —
 *  pulsing dots plus an elapsed timer, ported from t3code's WorkingTimelineRow. */
function Working({ startedAt }: { startedAt?: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground/70 tabular-nums" aria-label={t('messages.generating')}>
      <span className="inline-flex items-center gap-[3px]">
        <span className="size-1 animate-pulse rounded-full bg-muted-foreground/40" />
        <span className="size-1 animate-pulse rounded-full bg-muted-foreground/40 [animation-delay:200ms]" />
        <span className="size-1 animate-pulse rounded-full bg-muted-foreground/40 [animation-delay:400ms]" />
      </span>
      <span>{startedAt ? <>{t('messages.workingFor')} <WorkingTimer startedAt={startedAt} /></> : t('messages.working')}</span>
    </div>
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
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyTextToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <ActionIcon
      label={copied ? t('messages.copied') : t('messages.copy')}
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

function MessageActions({ msg, onEdit, copyText, canDelete = true }: { msg: UiMessage; onEdit?: () => void; copyText?: string; canDelete?: boolean }) {
  const { t } = useTranslation();
  const remove = useChat((s) => s.remove);
  const canMutate = !!msg.dbId;
  return (
    <>
      <CopyAction text={copyText ?? msg.content} />
      {onEdit && canMutate && (
        <ActionIcon label={t('messages.editMessage')} onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </ActionIcon>
      )}
      {canDelete && canMutate && (
        <ActionIcon label={t('messages.deleteMessage')} destructive onClick={() => void remove(msg.id).catch(console.error)}>
          <Trash2Icon className="size-3.5" />
        </ActionIcon>
      )}
    </>
  );
}

function EditBox({ msg, onDone }: { msg: UiMessage; onDone: () => void }) {
  const { t } = useTranslation();
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
        <Button variant="ghost" size="sm" onClick={onDone}>{t('messages.cancel')}</Button>
        <Button size="sm" onClick={() => void save()}>{t('messages.save')}</Button>
      </div>
    </div>
  );
}

function FinalImageGrid({ images }: { images: ToolImage[] }) {
  const { t } = useTranslation();
  const uniqueImages = images.filter((image, i, all) => all.findIndex((other) => other.src === image.src) === i);
  if (uniqueImages.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
      {uniqueImages.map((image, i) => (
        <a
          key={`${image.src.slice(0, 48)}-${i}`}
          href={image.src}
          target="_blank"
          rel="noreferrer"
          className="min-w-0"
        >
          <img src={image.src} alt={image.label || t('messages.generatedImage', { n: i + 1 })} className="max-h-96 w-full rounded-lg object-contain" />
          {image.label && <div className="mt-1 truncate text-xs text-muted-foreground">{image.label}</div>}
        </a>
      ))}
    </div>
  );
}

export function Messages() {
  const { t } = useTranslation();
  const sessionId = useChat((s) => s.sessionId);
  const messages = useChat((s) => s.messages);
  const turnStartedAt = useChat((s) => s.turnStartedAt);
  const showMetrics = usePrefs((s) => s.visibility.messageMetrics);
  const showThinking = usePrefs((s) => s.visibility.showThinking);
  const [editing, setEditing] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = atBottom;
    setShowScrollToBottom(!atBottom);
  };

  const scrollToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinned.current = true;
    setShowScrollToBottom(false);
  };

  // Empty chat: the greeting + composer are centered together by App; this just
  // holds the space above so the composer can animate down on the first message.
  if (messages.length === 0) return <div className="min-h-0 flex-1" />;

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
  // RAG citations apply to the whole assistant turn, so collect them across all
  // of the turn's rows and render once, at the very end (RagSources dedupes by
  // filename). The backend only sends sources it determined the answer used.
  const assistantTurnSources = (index: number) => {
    const start = assistantTurnStart(index);
    return messages.slice(start, index + 1).flatMap((msg) => msg.sources ?? []);
  };

  return (
   <div className="relative flex min-h-0 flex-1 flex-col">
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
            <div key={m.id} className={`group w-full ${index === 0 ? '' : messages[index - 1].role === 'assistant' ? 'mt-0.5' : 'mt-3'}`}>
              {m.thinking && showThinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.content} />}
              {m.tools?.map((t, i) => <ToolRow key={i} call={t} />)}
              {m.content && (
                <div className={m.error ? 'text-destructive-foreground' : ''}>
                  <Markdown text={m.content} />
                </div>
              )}
              {/* Persistent "still running" indicator: shown for the entire
                  streaming turn — through thinking, tool calls, and text deltas —
                  so it never silently disappears mid-response. */}
              {m.streaming && <Working startedAt={turnStartedAt ?? undefined} />}
              {!m.streaming && isAssistantTurnEnd(index) && (() => {
                // Tool images already render inline at their tool row — the
                // bottom grid is only a fallback for artifacts no tool showed.
                const toolFinalImages = assistantTurnImages(index);
                const finalImages = toolFinalImages.length === 0 && m.id === lastAssistantId ? artifactImages : [];
                const copyText = assistantTurnText(index);
                return (
                  <>
                    <FinalImageGrid images={finalImages} />
                    {copyText && (
                      <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <MessageActions msg={m} copyText={copyText} canDelete={false} />
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
              {/* RAG citations: the very last thing in the assistant turn, and
                  only when the backend confirmed the knowledge was used. */}
              {!m.streaming && isAssistantTurnEnd(index) && (() => {
                const sources = assistantTurnSources(index);
                return sources.length > 0 ? <RagSources sources={sources} /> : null;
              })()}
            </div>
          ),
        )}
      </div>
    </div>
    {/* Scroll-to-bottom pill — shown when scrolled away from the bottom (t3code style). */}
    {showScrollToBottom && (
      <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={t('messages.scrollToBottom')}
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:cursor-pointer hover:border-border hover:text-foreground"
        >
          <ChevronDownIcon className="size-3.5" />
          {t('messages.scrollToBottom')}
        </button>
      </div>
    )}
   </div>
  );
}
