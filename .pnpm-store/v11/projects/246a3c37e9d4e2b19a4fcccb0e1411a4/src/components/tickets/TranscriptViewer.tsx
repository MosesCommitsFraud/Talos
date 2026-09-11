import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, ExternalLinkIcon, FileJsonIcon, PaperclipIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchTicketTranscript,
  ticketAttachmentDownloadUrl,
  ticketMediaUrl,
  type TicketArtifact,
  type TicketTranscriptMessage,
} from '@/api/client';
import { cn, formatRelativeTime } from '@/lib/utils';
import { fileExt } from '@/lib/files';
import { coldLoadMessage, type UiMessage } from '@/state/chat';
import { useUi } from '@/state/ui';
import { TurnBody } from '../Messages';
import { RagSources } from '../RagSources';
import { Dialog, DialogContent } from '../ui/dialog';

/** One rendered message plus the snapshot-level facts the chat store has no
 *  field for — currently only whether it was still streaming when filed. */
interface ViewerMessage {
  msg: UiMessage;
  partial: boolean;
}

/** Rebuild the reporter's messages from the frozen snapshot.
 *
 *  Deliberately goes through the chat store's own `coldLoadMessage`: an admin
 *  triaging a report has to see what the reporter saw, and a second renderer
 *  with its own idea of how a multi-round turn splits would drift away from the
 *  chat window the ticket is about. Format-1 snapshots carry no metadata, so
 *  they come out as the plain text they always were. */
function buildMessages(transcript: TicketTranscriptMessage[], sessionId: string): ViewerMessage[] {
  const out: ViewerMessage[] = [];
  for (const entry of transcript) {
    const metadata = entry.metadata ?? (entry.timestamp ? { timestamp: entry.timestamp } : undefined);
    for (const msg of coldLoadMessage({ role: entry.role, content: entry.content, metadata }, sessionId)) {
      out.push({ msg, partial: !!entry.partial });
    }
  }
  return out;
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function PartialBadge() {
  const { t } = useTranslation();
  return (
    <span
      title={t('tickets.viewer.partialHint')}
      className="rounded bg-primary/15 px-1.5 py-0.5 text-[9px] text-primary"
    >
      {t('tickets.viewer.partial')}
    </span>
  );
}

/** Files the user sent with a message. They are served by the normal upload
 *  route, which already lets an admin read them. */
function SnapshotAttachments({ msg }: { msg: UiMessage }) {
  if (!msg.attachments?.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {msg.attachments.map((file) => (
        <a
          key={file.id}
          href={`/api/upload/${encodeURIComponent(file.id)}`}
          download
          className="flex max-w-full items-center gap-1 rounded-md bg-accent px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <PaperclipIcon className="size-3 shrink-0" />
          <span className="truncate">{file.name || file.id}</span>
        </a>
      ))}
    </div>
  );
}

/** The chat's output files, frozen with the transcript. The bytes are fetched
 *  through the ticket's own media route, so they stay readable here without the
 *  admin gaining access to the rest of that user's workspace. */
function ArtifactStrip({
  ticketId,
  attachmentId,
  artifacts,
}: {
  ticketId: string;
  attachmentId: string;
  artifacts: TicketArtifact[];
}) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);
  if (artifacts.length === 0) return null;
  return (
    <section className="border-t px-5 py-4">
      <h3 className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {t('tickets.viewer.artifacts', { count: artifacts.length })}
      </h3>
      <div className="flex flex-wrap gap-2">
        {artifacts.map((file) => {
          const ref = file.media_ref;
          const isImage = !!file.is_image || (file.mime ?? '').startsWith('image/');
          const isHtml = /^(html?|htm)$/i.test(fileExt(file.name));
          const viewUrl = ref ? ticketMediaUrl(ticketId, attachmentId, ref, 'inline') : null;
          return (
            <div
              key={file.path}
              className="flex w-[210px] max-w-full items-center gap-2 rounded-lg border bg-card px-2 py-1.5"
            >
              {isImage && viewUrl ? (
                <button
                  type="button"
                  onClick={() => openLightbox({ src: viewUrl, label: file.name })}
                  className="size-9 shrink-0 cursor-zoom-in overflow-hidden rounded-md"
                >
                  <img src={viewUrl} alt={file.name} className="size-full object-cover" />
                </button>
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-[9px] font-semibold text-muted-foreground">
                  {fileExt(file.name).toUpperCase() || t('artifacts.file')}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px]">{file.name}</span>
                {file.size != null && (
                  <span className="block text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
                )}
              </span>
              {isHtml && ref && (
                <a
                  href={ticketMediaUrl(ticketId, attachmentId, ref, 'render')}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('tickets.viewer.openArtifact', { name: file.name })}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
              {ref && (
                <a
                  href={ticketMediaUrl(ticketId, attachmentId, ref, 'download')}
                  aria-label={t('artifacts.download', { name: file.name })}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <DownloadIcon className="size-3.5" />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Reads one attached chat snapshot in full: the messages, the model's
 *  reasoning, every tool call it made, the citations it used and the files it
 *  produced. Read-only by construction — the admin sees the frozen copy the
 *  reporter sent, not the live chat.
 *
 *  Reasoning and tool groups are rendered by the same components the chat
 *  window uses, with thinking forced on — a reader here is triaging a bug, not
 *  choosing how much detail they like — and the turn's activity left in the
 *  open instead of tucked behind the chat's "Worked for Xs" fold. Individual
 *  tool rows still open on click, as they do in a chat. */
export function TranscriptViewer({
  ticketId,
  attachmentId,
  onClose,
}: {
  ticketId: string;
  attachmentId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['ticket-transcript', ticketId, attachmentId],
    queryFn: () => fetchTicketTranscript(ticketId, attachmentId as string),
    enabled: !!attachmentId,
  });

  const items = useMemo(
    () => buildMessages(data?.transcript ?? [], data?.session_id ?? ''),
    [data],
  );

  // Same grouping the chat uses: a user bubble, or the run of assistant bubbles
  // that answered it (one turn).
  const blocks = useMemo(() => {
    type Block =
      | { kind: 'user'; item: ViewerMessage }
      | { kind: 'turn'; items: ViewerMessage[] };
    const out: Block[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].msg.role === 'user') {
        out.push({ kind: 'user', item: items[i] });
        continue;
      }
      const turn: ViewerMessage[] = [];
      while (i < items.length && items[i].msg.role === 'assistant') {
        turn.push(items[i]);
        i += 1;
      }
      i -= 1;
      out.push({ kind: 'turn', items: turn });
    }
    return out;
  }, [items]);

  return (
    <Dialog open={!!attachmentId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        title={data?.session_name || t('tickets.viewer.title')}
        className="h-[85vh] w-[min(880px,94vw)]"
      >
        <div className="flex items-center justify-between gap-3 border-b px-5 py-2 text-xs text-muted-foreground">
          <span className="truncate">
            {t('tickets.viewer.messages', { count: data?.transcript.length ?? 0 })}
          </span>
          {attachmentId && (
            <span className="flex shrink-0 items-center gap-1">
              <a
                href={ticketAttachmentDownloadUrl(ticketId, attachmentId, 'md')}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
              >
                <DownloadIcon className="size-3.5" />
                {t('tickets.viewer.download')}
              </a>
              <a
                href={ticketAttachmentDownloadUrl(ticketId, attachmentId, 'json')}
                title={t('tickets.viewer.downloadJson')}
                aria-label={t('tickets.viewer.downloadJson')}
                className="flex items-center rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
              >
                <FileJsonIcon className="size-3.5" />
              </a>
            </span>
          )}
        </div>

        {data && (data.format_version ?? 1) < 2 && (
          <p className="border-b bg-accent/40 px-5 py-2 text-[11px] text-muted-foreground">
            {t('tickets.viewer.legacyHint')}
          </p>
        )}

        <div className="space-y-3 px-5 py-4">
          {isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</p>}
          {data?.transcript.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('tickets.viewer.empty')}</p>
          )}
          {blocks.map((block, i) =>
            block.kind === 'user' ? (
              <div key={block.item.msg.id} className="flex flex-col items-end gap-1">
                <SnapshotAttachments msg={block.item.msg} />
                <span className="px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t('tickets.viewer.roleUser')}
                  {block.item.msg.createdAt && ` · ${formatRelativeTime(new Date(block.item.msg.createdAt).toISOString())}`}
                </span>
                <div className="max-w-[90%] rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
                  {block.item.msg.content}
                </div>
              </div>
            ) : (
              <div key={block.items[0]?.msg.id ?? i} className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t('tickets.viewer.roleAssistant')}
                  {block.items[0]?.msg.createdAt &&
                    ` · ${formatRelativeTime(new Date(block.items[0].msg.createdAt).toISOString())}`}
                  {block.items.some((x) => x.partial) && <PartialBadge />}
                </span>
                <div className={cn('rounded-lg bg-accent/60 px-3 py-2 text-sm')}>
                  <TurnBody turn={block.items.map((x) => x.msg)} showThinking />
                  {block.items.flatMap((x) => x.msg.sources ?? []).length > 0 && (
                    <RagSources sources={block.items.flatMap((x) => x.msg.sources ?? [])} />
                  )}
                </div>
              </div>
            ),
          )}
        </div>

        {attachmentId && data?.artifacts?.length ? (
          <ArtifactStrip ticketId={ticketId} attachmentId={attachmentId} artifacts={data.artifacts} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
