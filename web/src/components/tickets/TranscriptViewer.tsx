import { useQuery } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchTicketTranscript, ticketAttachmentDownloadUrl } from '@/api/client';
import { cn, formatRelativeTime } from '@/lib/utils';
import { Markdown } from '../Markdown';
import { Dialog, DialogContent } from '../ui/dialog';

/** Reads one attached chat snapshot. Read-only by construction — the admin sees
 *  the frozen copy the reporter sent, not the live chat. */
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
            <a
              href={ticketAttachmentDownloadUrl(ticketId, attachmentId, 'md')}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
            >
              <DownloadIcon className="size-3.5" />
              {t('tickets.viewer.download')}
            </a>
          )}
        </div>
        <div className="space-y-4 px-5 py-4">
          {isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</p>}
          {data?.transcript.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('tickets.viewer.empty')}</p>
          )}
          {data?.transcript.map((msg, i) => (
            <div key={i} className={cn('flex flex-col gap-1', msg.role === 'user' && 'items-end')}>
              <span className="px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {msg.role}
                {msg.timestamp && ` · ${formatRelativeTime(msg.timestamp)}`}
                {msg.partial && (
                  <span
                    title={t('tickets.viewer.partialHint')}
                    className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] text-primary"
                  >
                    {t('tickets.viewer.partial')}
                  </span>
                )}
              </span>
              <div
                className={cn(
                  'max-w-[90%] rounded-lg px-3 py-2 text-sm',
                  msg.role === 'user' ? 'bg-primary/10' : 'bg-accent/60',
                )}
              >
                <Markdown text={msg.content} />
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
