import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon, FoldVerticalIcon, ListChecksIcon, PencilIcon, ScanSearchIcon, Trash2Icon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { artifactDownloadUrl, downloadArtifact, fetchArtifacts, uploadDownloadUrl } from '@/api/client';
import { cn, copyTextToClipboard } from '@/lib/utils';
import { artifactSelectionLocator } from '@/lib/artifactSelection';
import { artifactDisplayName, displayName, fileExt, isPreviewable } from '@/lib/files';
import { useChat, type UiMessage } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { AttachmentTile, FilePreviewFace, hasVisualPreview, openUploadViewer } from './AttachmentTile';
import { Markdown } from './Markdown';
import { PlanCard } from './PlanCard';
import { RagSources } from './RagSources';
import { ToolGroup, type GroupEntry } from './ToolGroup';
import { WorkingAnimation } from './WorkingAnimation';
import { ImageGallery, toolImages } from './ToolRow';
import { Collapse } from './ui/collapse';
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
 *  the looping Talos mark plus an elapsed timer, ported from t3code's
 *  WorkingTimelineRow.
 *
 *  Outlives the turn by up to one animation cycle: `running` goes false the
 *  moment the stream ends, which drops the clock (the settled turn states the
 *  final duration itself) and lets the mark play its loop out to the end frame
 *  instead of being yanked mid-swing. `onFinished` fires there. */
function Working({ startedAt, running = true, onFinished }: { startedAt?: number; running?: boolean; onFinished?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground/70 tabular-nums"
      aria-label={running ? t('messages.generating') : undefined}
      aria-hidden={!running}
    >
      <WorkingAnimation className="size-5" playing={running} onFinished={onFinished} />
      {/* The animation already says "still going" — the label only needs to say
          how long, so the clock stands alone. */}
      {running && <span>{startedAt ? <WorkingTimer startedAt={startedAt} /> : t('messages.working')}</span>}
    </div>
  );
}

type TurnSegment =
  | { kind: 'text'; msg: UiMessage }
  | { kind: 'activity'; id: string; entries: GroupEntry[] };

/** Split a turn into the sequence a reader should see: what the model said, and
 *  — bunched into one collapsible group between those — what it did.
 *
 *  Reasoning and tool calls share that group. They are the same kind of thing to
 *  a reader (steps taken between two remarks), and separating them stacked two
 *  disclosures with a gap in the middle for what is really one stretch of work.
 *
 *  Activity accumulates across rounds and only flushes when the model speaks
 *  again, so ten silent lookups collapse into a single "Ran 10 commands" line
 *  instead of ten stacked rows. Within a round the order mirrors what actually
 *  happened: the model thinks, says something, then calls its tools. */
function buildSegments(turn: UiMessage[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let pending: GroupEntry[] = [];
  let pendingId = '';
  // One bubble can open two groups — its reasoning, then (after its text) its
  // tool calls — so the message id alone is not a unique React key. The counter
  // makes it one; duplicate keys let React drop siblings silently.
  let seq = 0;
  const add = (id: string, entry: GroupEntry) => {
    if (pending.length === 0) pendingId = `${id}-${seq++}`;
    pending.push(entry);
  };
  const flush = () => {
    if (pending.length === 0) return;
    out.push({ kind: 'activity', id: pendingId, entries: pending });
    pending = [];
  };
  for (const m of turn) {
    if (m.thinking) {
      add(m.id, { kind: 'thinking', id: m.id, text: m.thinking, streaming: !!m.streaming && !m.content });
    }
    if (m.content.trim()) {
      flush();
      out.push({ kind: 'text', msg: m });
    }
    for (const call of m.tools ?? []) add(m.id, { kind: 'call', call });
  }
  flush();
  return out;
}

/** Settled-turn fold: collapses everything the turn did — thinking, tool groups
 *  and the commentary between them — behind a quiet "Worked for Xs" line, with
 *  only the final answer left standing outside it.
 *
 *  The fold is just the outer lid; what unfolds is the same interleaved body the
 *  stream showed, tool groups and all. Styled like those groups (trailing
 *  chevron, medium 13px, muted) so the whole stack reads as one family. */
function ActivityFold({ turn, showThinking, durationMs, terminalId }: { turn: UiMessage[]; showThinking: boolean; durationMs: number | null; terminalId?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = durationMs != null ? t('messages.workedFor', { duration: formatDurationMs(durationMs) }) : t('messages.worked');
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full select-none items-center gap-1.5 text-[15px] font-medium text-muted-foreground tabular-nums transition-colors hover:text-foreground"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <Collapse open={open}>
        <div className="mt-1.5">
          <TurnBody turn={turn} showThinking={showThinking} hideContentFor={terminalId} />
        </div>
      </Collapse>
    </div>
  );
}

/** Renders a turn's segments. Shared by the streaming and settled branches so a
 *  turn doesn't visibly rearrange itself the moment it finishes — the tool
 *  groups just switch from live labels to their past-tense recap.
 *  `hideContentFor` suppresses one bubble's text (the final answer, which stays
 *  outside the fold; or a proposed plan, which renders as a chip). */
function TurnBody({ turn, showThinking, hideContentFor }: { turn: UiMessage[]; showThinking: boolean; hideContentFor?: string }) {
  return (
    <>
      {buildSegments(turn).map((seg) => {
        if (seg.kind === 'activity') {
          // Reasoning is opt-out; with it hidden the group keeps only its calls,
          // and vanishes entirely if that leaves nothing.
          const entries = showThinking ? seg.entries : seg.entries.filter((e) => e.kind === 'call');
          return entries.length > 0 ? <ToolGroup key={`act-${seg.id}`} entries={entries} /> : null;
        }
        if (seg.msg.id === hideContentFor) return null;
        return (
          <div key={seg.msg.id} className={seg.msg.error ? 'text-destructive-foreground' : 'text-strong'}>
            <Markdown text={seg.msg.content} streaming={!!seg.msg.streaming} />
          </div>
        );
      })}
    </>
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

/** What was sent with the message, as square preview tiles above the bubble:
 *  images and PDFs show their own first face, everything else its type glyph.
 *  Each tile downloads the file; the name and size live in the tooltip, where
 *  they don't cost a line of chat width. */
function AttachmentList({ msg }: { msg: UiMessage }) {
  const sessionId = useChat((s) => s.sessionId);
  if (!msg.attachments?.length) return null;
  return (
    <div className="mb-1 flex max-w-full flex-wrap justify-end gap-1.5">
      {msg.attachments.map((file) => {
        const name = file.name || file.id;
        const url = uploadDownloadUrl(file.id);
        const label = file.size != null ? `${name} · ${formatSize(file.size)}` : name;
        return (
          <Tooltip key={file.id} label={label} side="top">
            {/* An anchor, so a file with no viewer still downloads (and the
                middle-click / "save as" affordances survive); the click handler
                takes over for images and PDFs. */}
            <a
              href={url}
              download
              aria-label={label}
              onClick={(e) => { if (openUploadViewer({ url, name, mime: file.mime, sessionId })) e.preventDefault(); }}
              className="cursor-pointer transition-opacity hover:opacity-80"
            >
              <AttachmentTile url={url} name={name} mime={file.mime} />
            </a>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ArtifactSelectionChip({ msg }: { msg: UiMessage }) {
  const { t } = useTranslation();
  const openPreview = useUi((state) => state.openPreview);
  const selection = msg.artifactSelection;
  if (!selection) return null;
  const locator = artifactSelectionLocator(selection);
  const label = t('composer.selectionChip', { locator: locator ? ` ${locator}` : '' });
  return (
    <div className="mt-1 flex max-w-full justify-end">
      <button
        type="button"
        onClick={() => openPreview({ sessionId: selection.sessionId, path: selection.path, name: selection.name, mime: selection.mime, version: selection.version })}
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
      >
        <ScanSearchIcon className="size-3.5 shrink-0 text-primary" />
        <span>{label}</span>
      </button>
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
    <div className="w-full rounded-md border border-ring bg-card p-3">
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

export interface ArtifactFile { path: string; name: string; size?: number; mime?: string; version?: number }

/** Downloadable chips for the files a turn produced — documents and images
 *  alike, shown inline on the last turn. Clicking a previewable file
 *  (md/text/code/csv/Word/Excel/pdf/image) opens the resizable preview panel;
 *  the trailing icon always downloads. */
function ArtifactChips({ sessionId, files }: { sessionId: string; files: ArtifactFile[] }) {
  const { t } = useTranslation();
  const openPreview = useUi((s) => s.openPreview);
  if (files.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {files.map((f) => {
        const previewable = isPreviewable(f.name, f.mime);
        const visual = hasVisualPreview(f.name, f.mime);
        const ext = fileExt(f.name).toUpperCase();
        return (
          <div key={f.path} className="group/chip relative">
            <button
              type="button"
              onClick={() => {
                if (previewable) openPreview({ sessionId, path: f.path, name: f.name, mime: f.mime, version: typeof f.version === 'number' ? f.version : undefined });
                else void downloadArtifact(sessionId, f.path, f.name);
              }}
              title={previewable ? t('messages.openPreview', { name: f.name }) : f.name}
              // A card, not a chip: the file's own first page/frame is the
              // background for anything with a visual face, with the label
              // block over a scrim so it stays readable on any image.
              className="relative flex h-[132px] w-[168px] flex-col justify-end overflow-hidden rounded-xl border bg-card p-2.5 text-left transition-colors hover:border-foreground/25"
            >
              {visual && (
                <>
                  <div className="absolute inset-0">
                    <FilePreviewFace url={artifactDownloadUrl(sessionId, f.path)} name={f.name} mime={f.mime} width={168} height={132} />
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/45 to-black/10" />
                </>
              )}
              <span
                className={cn(
                  'absolute left-2.5 top-2.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide',
                  visual ? 'bg-black/45 text-white/90' : 'bg-muted text-muted-foreground',
                )}
              >
                {ext || t('artifacts.file')}
              </span>
              <span
                className={cn(
                  'relative line-clamp-2 text-[13px] font-medium leading-tight break-all',
                  visual ? 'text-white' : 'text-foreground',
                )}
              >
                {displayName(f.name)}
              </span>
              {f.size != null && (
                <span className={cn('relative mt-1 text-[11px]', visual ? 'text-white/70' : 'text-muted-foreground')}>
                  {formatSize(f.size)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => { void downloadArtifact(sessionId, f.path, f.name); }}
              aria-label={t('artifacts.download', { name: f.name })}
              className={cn(
                'absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/chip:opacity-100',
                visual ? 'bg-black/45 text-white hover:bg-black/65' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              <DownloadIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
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
 *  message. Streaming and settled render the same shape — commentary interleaved
 *  with one collapsible group per batch of tool calls — so the turn doesn't
 *  rearrange itself when it finishes. The live "Working for Xs" indicator is
 *  swapped for the final elapsed time. */
function AssistantTurn({ turn, containsLast, artifactFiles, sessionId }: { turn: UiMessage[]; containsLast: boolean; artifactFiles: ArtifactFile[]; sessionId: string | null }) {
  const showThinking = usePrefs((s) => s.visibility.showThinking);
  const showMetrics = usePrefs((s) => s.visibility.messageMetrics);
  const turnStartedAt = useChat((s) => s.turnStartedAt);

  const streaming = turn.some((m) => m.streaming);
  // The indicator outlives the stream: when the turn settles the mark keeps its
  // place until it has played the cycle it was in out to the end frame, then
  // Working reports back and the row goes. Only turns that were actually seen
  // streaming wind down — reopening a session must not replay one per turn.
  const [windingDown, setWindingDown] = useState(false);
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) setWindingDown(true);
    if (streaming) setWindingDown(false);
    wasStreaming.current = streaming;
  }, [streaming]);
  const indicator = (streaming || windingDown) && (
    <Working
      startedAt={turnStartedAt ?? undefined}
      running={streaming}
      onFinished={() => setWindingDown(false)}
    />
  );

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
        <TurnBody turn={turn} showThinking={showThinking} />
        {/* Live plan checklist as the agent ticks steps off via update_plan. */}
        {planMsg && <PlanCard msg={planMsg} />}
        {/* Persistent "still running" indicator: shown for the whole streaming
            turn — through thinking, tool calls, and text deltas. */}
        {indicator}
      </>
    );
  }

  // Settled turn: the work folds behind "Worked for Xs" and only the final
  // answer stays out. The terminal message is the last bubble that produced
  // text; everything before it — thinking, tool groups, interim commentary —
  // goes inside the fold. The agent loop guarantees the last round restates the
  // complete answer (final-answer completeness nudge), so folding the earlier
  // text loses nothing.
  const terminal = [...turn].reverse().find((m) => m.content.trim().length > 0);
  const terminalId = terminal?.id;
  const hasFoldedCommentary = turn.some((m) => m.id !== terminalId && m.content.trim().length > 0);
  const hasActivity =
    hasFoldedCommentary || turn.some((m) => (m.thinking && showThinking) || (m.tools?.length ?? 0) > 0);
  const durationMs =
    last.turnElapsedMs ??
    (() => {
      const seconds = turn.reduce((acc, m) => acc + (m.metrics?.response_time ?? 0), 0);
      return seconds > 0 ? seconds * 1000 : null;
    })();

  // Images a tool produced live inside a collapsed group, so re-surface them
  // under the answer where they stay visible without opening anything.
  const createdImages = turn.flatMap((m) => (m.tools ?? []).flatMap(toolImages));
  const sources = turn.flatMap((m) => m.sources ?? []);
  // A plan-mode turn that actually proposed a plan (a checklist is present) gets
  // a compact chip; the full plan lives in the side panel. Strictly gated on
  // planProposed so ordinary turns never get it, and superseded by a question.
  const proposalMsg =
    !questionMsg && terminal?.planProposed && /[-*]\s*\[[ xX]\]/.test(terminal.content) ? terminal : undefined;

  return (
    <>
      {compacted && <CompactionMarker />}
      {hasActivity && (
        <ActivityFold turn={turn} showThinking={showThinking} durationMs={durationMs} terminalId={terminalId} />
      )}
      {/* The answer itself stays outside the fold. A proposed plan opens in the
          side panel instead, so the stream shows a compact chip. */}
      {!proposalMsg && terminal && (
        <div className={terminal.error ? 'text-destructive-foreground' : 'text-strong'}>
          <Markdown text={terminal.content} />
        </div>
      )}
      {proposalMsg && <PlanChip />}
      {planMsg && !proposalMsg && <PlanCard msg={planMsg} />}
      {/* Images produced inside a collapsed tool group, re-surfaced between the
          answer and the artifacts button. No subtitles: this is a recap. */}
      {createdImages.length > 0 && (
        <div className="mt-3">
          <ImageGallery images={createdImages} showLabels={false} />
        </div>
      )}
      {/* Downloadable chips for every file the turn produced (documents and
          images alike) — each opens the resizable preview panel or downloads.
          Shown on the last turn, where the session's output files are known. */}
      {containsLast && sessionId && artifactFiles.length > 0 && (
        <ArtifactChips sessionId={sessionId} files={artifactFiles} />
      )}
      {copyText && (
        <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <MessageActions msg={last} copyText={copyText} canDelete={false} />
          {showMetrics && <MessageTime ts={last.createdAt} />}
        </div>
      )}
      {/* RAG citations: last thing in the turn, only when the backend confirmed
          the knowledge was used. */}
      {sources.length > 0 && <RagSources sources={sources} />}
      {/* Same spot it held while streaming — last in the turn — so the mark
          stays put while it plays its final cycle out instead of jumping. */}
      {indicator}
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

  const syncScrollState = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight + 1;
    const atBottom = !hasOverflow || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = atBottom;
    setShowScrollToBottom(hasOverflow && !atBottom);
  }, []);

  // Stick to the bottom while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    syncScrollState();
  }, [messages, syncScrollState]);

  // Content can become shorter without producing a scroll event (for example,
  // when an activity fold closes). Keep the pill in sync with layout changes.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    syncScrollState();
    return () => observer.disconnect();
  }, [syncScrollState]);

  const onScroll = () => {
    syncScrollState();
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
  // Output files the agent created — rendered as downloadable/previewable chips
  // on the last turn. Images are listed by name here too (clicking opens the
  // image in the preview panel), so every artifact type is surfaced the same way.
  const artifactFiles: ArtifactFile[] = sessionId
    ? (artifacts ?? []).flatMap((f) => {
        const path = String(f.path ?? f.name ?? '');
        const name = artifactDisplayName(path, typeof f.name === 'string' ? f.name : undefined);
        const mime = String(f.mime ?? '');
        if (!path || (f.source === 'workspace' && inputPaths.has(path))) return [];
        return [{
          path,
          name,
          size: typeof f.size === 'number' ? f.size : undefined,
          mime: mime || undefined,
        }];
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
                  {/* Attachments sit above the text, the way they were staged
                      in the composer. */}
                  <AttachmentList msg={block.msg} />
                  <div className="rounded-lg rounded-br-sm bg-bubble px-3 py-1.5 text-[15px] leading-relaxed whitespace-pre-wrap text-strong">
                    {block.msg.content}
                  </div>
                  <ArtifactSelectionChip msg={block.msg} />
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {/* Time trails the icons, matching the assistant row. */}
                    <MessageActions msg={block.msg} onEdit={() => setEditing(block.msg.id)} />
                    <MessageTime ts={block.msg.createdAt} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div key={block.turn[0].id} className={`group w-full ${index === 0 ? '' : 'mt-3'}`}>
              <AssistantTurn
                turn={block.turn}
                containsLast={block.turn.some((m) => m.id === lastAssistantId)}
                artifactFiles={artifactFiles}
                sessionId={sessionId}
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
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-foreground/15 bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:cursor-pointer hover:border-foreground/25 hover:text-foreground dark:border-border/60 dark:hover:border-border"
        >
          <ChevronDownIcon className="size-3.5" />
          {t('messages.scrollToBottom')}
        </button>
      </div>
    )}
   </div>
  );
}
