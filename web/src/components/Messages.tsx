import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, FileIcon, FoldVerticalIcon, ImageIcon, ListChecksIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { artifactDownloadUrl, fetchArtifacts, uploadDownloadUrl } from '@/api/client';
import { copyTextToClipboard } from '@/lib/utils';
import { useChat, type UiMessage } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { Markdown } from './Markdown';
import { PlanCard } from './PlanCard';
import { RagSources } from './RagSources';
import { Thinking } from './Thinking';
import { ImageGallery, ToolRow, toolImages, type ToolImage } from './ToolRow';
import { Tooltip } from './ui/misc';
import { Button } from './ui/button';

/** Compact elapsed label in h/m/s: "12s", "3m 5s", "1h 4m 5s". */
function formatDurationMs(ms: number): string {
  const elapsed = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

const formatWorkingElapsed = (startMs: number, nowMs: number) => formatDurationMs(nowMs - startMs);

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

/** Relative timestamp shown under a bubble: "just now" under a minute, "{n} min
 *  ago" under an hour, "{n}h ago" under a day, else the wall-clock time it was
 *  sent (HH:mm, 24-hour). Re-renders every 30s so the label keeps pace. */
function MessageTime({ ts }: { ts?: number }) {
  const { t, i18n } = useTranslation();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return null;
  const diff = Date.now() - ts;
  let label: string;
  if (diff < 60_000) label = t('messages.timeJustNow');
  else if (diff < 3_600_000) label = t('messages.timeMinAgo', { count: Math.floor(diff / 60_000) });
  else if (diff < 86_400_000) label = t('messages.timeHourAgo', { count: Math.floor(diff / 3_600_000) });
  else label = new Date(ts).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false });
  return <span className="text-xs text-muted-foreground/70 tabular-nums">{label}</span>;
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

/** Settled-turn fold: collapses everything a finished turn did — thinking, tool
 *  calls, and any interim commentary the model emitted between tool calls —
 *  behind a quiet "Worked for Xs" disclosure (t3code style). Only the terminal
 *  message's text renders outside the fold as the final answer; `terminalId`
 *  marks it so its commentary isn't duplicated here. */
function ActivityFold({ turn, terminalId, showThinking, durationMs }: { turn: UiMessage[]; terminalId: string; showThinking: boolean; durationMs: number | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = durationMs != null ? t('messages.workedFor', { duration: formatDurationMs(durationMs) }) : t('messages.worked');
  return (
    <div className="my-1 border-b border-border/50 pb-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex select-none items-center gap-1 rounded-md text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground"
      >
        <span>{label}</span>
        <ChevronRightIcon className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {turn.map((m) => (
            <Fragment key={m.id}>
              {m.thinking && showThinking && <Thinking text={m.thinking} streaming={false} />}
              {/* Interim commentary the model said between tool calls — folded
                  away too; the terminal message's text shows below the fold. */}
              {m.id !== terminalId && m.content && (
                <div className="text-sm text-muted-foreground">
                  <Markdown text={m.content} />
                </div>
              )}
              {m.tools?.map((call, i) => <ToolRow key={i} call={call} compact />)}
            </Fragment>
          ))}
        </div>
      )}
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
        className={`flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent ${
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
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
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
          <PencilIcon className="size-3" />
        </ActionIcon>
      )}
      {canDelete && canMutate && (
        <ActionIcon label={t('messages.deleteMessage')} destructive onClick={() => void remove(msg.id).catch(console.error)}>
          <Trash2Icon className="size-3" />
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

/** End-of-turn affordance: a quiet button that opens the artifacts sidebar so
 *  the user can view (and download) the files/images the query produced. */
function ArtifactsButton({ count }: { count: number }) {
  const { t } = useTranslation();
  const openArtifacts = useUi((s) => s.setArtifactsOpen);
  return (
    <button
      type="button"
      onClick={() => openArtifacts(true)}
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
    >
      <ImageIcon className="size-3.5" />
      {t('messages.viewArtifacts', { count })}
    </button>
  );
}

/** Compact marker in the message stream for a proposed plan — the full plan
 *  lives in the side panel, which this reopens if it was collapsed. */
function PlanChip() {
  const { t } = useTranslation();
  const openPlan = useUi((s) => s.setPlanPanelOpen);
  return (
    <button
      type="button"
      onClick={() => openPlan(true)}
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/[0.06] px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
    >
      <ListChecksIcon className="size-3.5" />
      {t('plan.viewPlan')}
    </button>
  );
}

/** Centered divider shown above a turn when auto-compaction ran before it —
 *  tells the user older messages were summarized to keep the chat in-context. */
function CompactionMarker() {
  const { t } = useTranslation();
  return (
    <div className="my-2 flex items-center gap-2.5 text-muted-foreground/70" role="status">
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
        <FoldVerticalIcon className="size-3.5" />
        {t('messages.compacted')}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** One assistant turn = the run of consecutive assistant bubbles after a user
 *  message. While streaming it renders live (thinking → tools → text, in order,
 *  plus the running indicator). Once settled, the thinking and tool calls fold
 *  into a single "Worked for Xs" disclosure and only the answer stays visible —
 *  matching t3code's finished-turn compaction. */
function AssistantTurn({ turn, containsLast, artifactImages }: { turn: UiMessage[]; containsLast: boolean; artifactImages: ToolImage[] }) {
  const showThinking = usePrefs((s) => s.visibility.showThinking);
  const showMetrics = usePrefs((s) => s.visibility.messageMetrics);
  const turnStartedAt = useChat((s) => s.turnStartedAt);

  const streaming = turn.some((m) => m.streaming);
  const last = turn[turn.length - 1];
  const copyText = turn.map((m) => m.content.trim()).filter(Boolean).join('\n\n');
  // Interactive cards: a live/updated plan checklist, and (settled) a question
  // the agent asked. Stamped onto the bubble that received the turn's deltas.
  const planMsg = [...turn].reverse().find((m) => m.plan);
  const questionMsg = [...turn].reverse().find((m) => m.pendingQuestion);
  const compacted = turn.some((m) => m.compacted);

  if (streaming) {
    return (
      <>
        {compacted && <CompactionMarker />}
        {turn.map((m) => (
          <Fragment key={m.id}>
            {m.thinking && showThinking && <Thinking text={m.thinking} streaming={!!m.streaming && !m.content} />}
            {m.tools?.map((call, i) => <ToolRow key={i} call={call} />)}
            {m.content && (
              <div className={m.error ? 'text-destructive-foreground' : ''}>
                <Markdown text={m.content} streaming={!!m.streaming} />
              </div>
            )}
          </Fragment>
        ))}
        {/* Live plan checklist as the agent ticks steps off via update_plan. */}
        {planMsg && <PlanCard msg={planMsg} />}
        {/* Persistent "still running" indicator: shown for the whole streaming
            turn — through thinking, tool calls, and text deltas. */}
        <Working startedAt={turnStartedAt ?? undefined} />
      </>
    );
  }

  // Settled turn: fold the work, keep only the final answer. The terminal
  // message is the last bubble that produced text — everything before it
  // (thinking, tools, and any interim commentary) folds into the disclosure.
  const terminal = [...turn].reverse().find((m) => m.content.trim().length > 0);
  const terminalId = terminal?.id ?? '';
  const hasFoldedCommentary = turn.some((m) => m.id !== terminalId && m.content.trim().length > 0);
  const hasActivity = hasFoldedCommentary || turn.some((m) => (m.thinking && showThinking) || (m.tools?.length ?? 0) > 0);
  const durationMs =
    last.turnElapsedMs ??
    (() => {
      const seconds = turn.reduce((acc, m) => acc + (m.metrics?.response_time ?? 0), 0);
      return seconds > 0 ? seconds * 1000 : null;
    })();

  // The tool rows (and any images they produced) fold away once the turn
  // settles. Rather than re-rendering those images inline, surface a button that
  // opens the artifacts sidebar — the canonical place for files the query made.
  const createdImages = turn.flatMap((m) => (m.tools ?? []).flatMap(toolImages));
  const createdCount = createdImages.length > 0 ? createdImages.length : containsLast ? artifactImages.length : 0;
  const sources = turn.flatMap((m) => m.sources ?? []);
  // A plan-mode turn that actually proposed a plan (a checklist is present) gets
  // a compact chip; the full plan lives in the side panel. Strictly gated on
  // planProposed so ordinary turns never get it, and superseded by a question.
  const proposalMsg =
    !questionMsg && terminal?.planProposed && /[-*]\s*\[[ xX]\]/.test(terminal.content) ? terminal : undefined;

  return (
    <>
      {compacted && <CompactionMarker />}
      {hasActivity && <ActivityFold turn={turn} terminalId={terminalId} showThinking={showThinking} durationMs={durationMs} />}
      {/* A proposed plan opens in the side panel; the message stream shows a
          compact chip rather than duplicating the whole plan inline. */}
      {terminal && !proposalMsg && (
        <div className={terminal.error ? 'text-destructive-foreground' : ''}>
          <Markdown text={terminal.content} />
        </div>
      )}
      {proposalMsg && <PlanChip />}
      {planMsg && !proposalMsg && <PlanCard msg={planMsg} />}
      {/* The tool rows (with their inline images) fold away once the turn
          settles, so re-surface the images the turn produced here — between the
          answer and the artifacts button. No subtitles: this is a recap. */}
      {createdImages.length > 0 && (
        <div className="mt-3">
          <ImageGallery images={createdImages} showLabels={false} />
        </div>
      )}
      {createdCount > 0 && <ArtifactsButton count={createdCount} />}
      {copyText && (
        <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <MessageActions msg={last} copyText={copyText} canDelete={false} />
          {showMetrics && last.metrics?.tokens_per_second != null && (
            <span className="text-xs text-muted-foreground/80">
              {`${last.metrics.tokens_per_second} tok/s`}
            </span>
          )}
          <MessageTime ts={last.createdAt} />
        </div>
      )}
      {/* RAG citations: last thing in the turn, only when the backend confirmed
          the knowledge was used. */}
      {sources.length > 0 && <RagSources sources={sources} />}
    </>
  );
}

export function Messages() {
  const { t } = useTranslation();
  const sessionId = useChat((s) => s.sessionId);
  const messages = useChat((s) => s.messages);
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
  // Group the flat message list into render blocks: a user bubble, or an
  // assistant turn (the run of consecutive assistant bubbles after it).
  type Block = { kind: 'user'; msg: UiMessage } | { kind: 'turn'; turn: UiMessage[] };
  const blocks: Block[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'user') {
      blocks.push({ kind: 'user', msg: m });
    } else {
      const turn: UiMessage[] = [];
      while (i < messages.length && messages[i].role === 'assistant') {
        turn.push(messages[i]);
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'turn', turn });
    }
  }

  return (
   <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto [scrollbar-gutter:stable]" role="log" aria-live="polite">
      <div className="mx-auto flex w-full max-w-[800px] flex-col px-4 pb-6 pt-14">
        {blocks.map((block, index) =>
          block.kind === 'user' ? (
            <div key={block.msg.id} className={`group ml-auto flex w-full max-w-[75%] flex-col items-end gap-0.5 ${index === 0 ? '' : 'mt-3'}`}>
              {editing === block.msg.id ? (
                <EditBox msg={block.msg} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <div className="rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                    {block.msg.content}
                  </div>
                  <AttachmentList msg={block.msg} />
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <MessageTime ts={block.msg.createdAt} />
                    <MessageActions msg={block.msg} onEdit={() => setEditing(block.msg.id)} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div key={block.turn[0].id} className={`group w-full ${index === 0 ? '' : 'mt-3'}`}>
              <AssistantTurn
                turn={block.turn}
                containsLast={block.turn.some((m) => m.id === lastAssistantId)}
                artifactImages={artifactImages}
              />
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
