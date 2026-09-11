import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  DownloadIcon,
  EyeIcon,
  RotateCcwIcon,
  TicketIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteTicket,
  fetchTicket,
  fetchTickets,
  setTicketStatus,
  ticketAttachmentDownloadUrl,
  type Ticket,
} from '@/api/client';
import { useUi } from '@/state/ui';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useAuth } from '../auth/AuthGate';
import { Button } from '../ui/button';
import { SearchInput } from '../ui/search';
import { TranscriptViewer } from './TranscriptViewer';

type Tab = 'open' | 'archived';

function TicketRow({ ticket, selected, onSelect }: { ticket: Ticket; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-lg px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <div className="truncate text-sm">{ticket.title}</div>
      <div className="truncate text-[11px] text-muted-foreground">
        {ticket.created_by || t('tickets.unknownUser')}
        {ticket.created_at && ` · ${formatRelativeTime(ticket.created_at)}`}
        {ticket.attachment_count > 0 &&
          ` · ${t('tickets.attachmentCount', { count: ticket.attachment_count })}`}
      </div>
    </button>
  );
}

/** The /tickets workspace: an admin-only list of user-filed tickets on the
 *  left, the selected ticket (text + attached chat snapshots) on the right.
 *  Mirrors the /rag and /users workspaces. */
export function TicketsWorkspace() {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);
  const queryClient = useQueryClient();
  const auth = useAuth();
  // Admin-only surface. The menu and palette entries are already gated, but
  // `#/tickets` is deep-linkable, so a non-admin landing here goes back to chat
  // rather than seeing an empty (403-backed) triage view.
  const isAdmin = auth?.is_admin !== false;
  const [tab, setTab] = useState<Tab>('open');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const { data: tickets, isLoading } = useQuery({
    queryKey: ['tickets', tab],
    queryFn: () => fetchTickets(tab),
    refetchInterval: 60_000,
    enabled: isAdmin,
  });
  const { data: detail } = useQuery({
    queryKey: ['ticket', selectedId],
    queryFn: () => fetchTicket(selectedId as string),
    enabled: isAdmin && !!selectedId,
  });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tickets ?? []).filter(
      (x) => !q || x.title.toLowerCase().includes(q) || (x.created_by || '').toLowerCase().includes(q),
    );
  }, [tickets, query]);

  // Keep a valid selection as the list changes (tab switch, archiving, search).
  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !rows.some((x) => x.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  useEffect(() => {
    if (!isAdmin) setView('chat');
  }, [isAdmin, setView]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    void queryClient.invalidateQueries({ queryKey: ['ticket'] });
  };

  const changeStatus = async (id: string, status: Tab) => {
    await setTicketStatus(id, status);
    refresh();
  };

  const remove = async (id: string) => {
    if (!window.confirm(t('tickets.deleteConfirm'))) return;
    await deleteTicket(id);
    setSelectedId(null);
    refresh();
  };

  if (!isAdmin) return null;

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden">
      {/* Left: tabs + ticket list */}
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 px-3 py-3">
          <button
            type="button"
            onClick={() => setView('chat')}
            aria-label={t('rag.backToChat')}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{t('tickets.title')}</h1>
        </div>
        <div className="space-y-2 px-3 pb-2">
          <div className="flex gap-1 rounded-lg bg-accent/50 p-0.5 text-xs">
            {(['open', 'archived'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  'flex-1 rounded-md px-2 py-1 transition-colors',
                  tab === key ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`tickets.tab.${key}`)}
              </button>
            ))}
          </div>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tickets.search')}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {isLoading && <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
          {!isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-2 py-12 text-center text-xs text-muted-foreground">
              <TicketIcon className="size-5 opacity-60" />
              {t('tickets.empty')}
            </div>
          )}
          {rows.map((x) => (
            <TicketRow key={x.id} ticket={x} selected={x.id === selectedId} onSelect={() => setSelectedId(x.id)} />
          ))}
        </div>
      </aside>

      {/* Right: the selected ticket */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {!detail ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('tickets.selectHint')}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
            <header className="space-y-2">
              <h2 className="text-xl font-semibold tracking-tight">{detail.title}</h2>
              <p className="text-xs text-muted-foreground">
                {t('tickets.filedBy', { user: detail.created_by || t('tickets.unknownUser') })}
                {detail.created_at && ` · ${formatRelativeTime(detail.created_at)}`}
                {detail.status === 'archived' &&
                  detail.resolved_by &&
                  ` · ${t('tickets.resolvedBy', { user: detail.resolved_by })}`}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {detail.status === 'open' ? (
                  <Button onClick={() => void changeStatus(detail.id, 'archived')}>
                    <CheckCircle2Icon /> {t('tickets.markDone')}
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => void changeStatus(detail.id, 'open')}>
                    <RotateCcwIcon /> {t('tickets.reopen')}
                  </Button>
                )}
                <Button variant="destructive-outline" onClick={() => void remove(detail.id)}>
                  <Trash2Icon /> {t('common.delete')}
                </Button>
              </div>
            </header>

            {detail.body && (
              <section className="rounded-lg border bg-card/40 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                {detail.body}
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t('tickets.attachments')}
              </h3>
              {detail.attachments.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('tickets.noAttachments')}</p>
              )}
              {detail.attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.session_name || t('common.untitled')}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {t('tickets.viewer.messages', { count: a.message_count })}
                      {!!a.artifact_count && ` · ${t('tickets.viewer.artifacts', { count: a.artifact_count })}`}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setViewing(a.id)}>
                    <EyeIcon /> {t('tickets.view')}
                  </Button>
                  <a
                    href={ticketAttachmentDownloadUrl(detail.id, a.id, 'md')}
                    aria-label={t('tickets.viewer.download')}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <DownloadIcon className="size-4" />
                  </a>
                </div>
              ))}
            </section>
          </div>
        )}
      </div>

      {detail && (
        <TranscriptViewer ticketId={detail.id} attachmentId={viewing} onClose={() => setViewing(null)} />
      )}
    </main>
  );
}
