import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, ArchiveRestoreIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deleteSession, fetchArchivedSessions, unarchiveSession } from '@/api/client';
import type { Session } from '@/api/types';
import { useChat } from '@/state/chat';
import { formatRelativeTime } from '@/lib/utils';
import { Dialog, DialogContent } from './ui/dialog';
import { Tooltip } from './ui/misc';

/** Lists the user's archived chats with restore / open / delete actions.
 *  Archived sessions are excluded from the active list endpoint, so this
 *  pulls its own data from /api/sessions/archived. */
export function ArchiveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const openSession = useChat((s) => s.openSession);
  const { data, isLoading } = useQuery({
    queryKey: ['sessions', 'archived'],
    queryFn: fetchArchivedSessions,
    enabled: open,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  const restore = async (id: string) => {
    await unarchiveSession(id);
    refresh();
  };
  const remove = async (id: string) => {
    await deleteSession(id);
    refresh();
  };
  const openChat = (id: string) => {
    void openSession(id);
    onClose();
  };

  const sessions: Session[] = data ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={t('archiveDialog.title')} className="w-[min(640px,94vw)]">
        <div className="min-h-0 space-y-1 p-3">
          {isLoading && (
            <p className="px-2 py-10 text-center text-sm text-muted-foreground">{t('archiveDialog.loading')}</p>
          )}
          {!isLoading && sessions.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-2 py-12 text-center text-sm text-muted-foreground">
              <ArchiveIcon className="size-5 opacity-60" />
              {t('archiveDialog.empty')}
            </div>
          )}
          {sessions.map((s) => (
            <div key={s.id} className="group flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-accent/70">
              <button
                type="button"
                onClick={() => openChat(s.id)}
                title={t('archiveDialog.open')}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-sm">{s.name || t('common.untitled')}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {t('archiveDialog.countMessages', { count: s.message_count ?? 0 })}
                  {s.last_message_at && ` · ${formatRelativeTime(s.last_message_at)}`}
                </div>
              </button>
              <Tooltip label={t('archiveDialog.restore')}>
                <button
                  type="button"
                  aria-label={t('archiveDialog.restore')}
                  onClick={() => void restore(s.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                >
                  <ArchiveRestoreIcon className="size-4" />
                </button>
              </Tooltip>
              <Tooltip label={t('archiveDialog.delete')}>
                <button
                  type="button"
                  aria-label={t('archiveDialog.delete')}
                  onClick={() => void remove(s.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-destructive-foreground"
                >
                  <Trash2Icon className="size-4" />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
