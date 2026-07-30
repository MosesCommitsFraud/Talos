import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon, MessageSquareIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createTicket, fetchSessions } from '@/api/client';
import type { Session } from '@/api/types';
import { cn, formatRelativeTime, timestampMs } from '@/lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Input, Textarea } from '../ui/misc';
import { SearchInput } from '../ui/search';

/** Searchable multi-select over the user's chats, newest first. Attaching a
 *  chat is optional — a ticket can be plain text. */
function ChatPicker({
  sessions,
  selected,
  onToggle,
}: {
  sessions: Session[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-away closes the list; the dialog itself stays open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => !q || (s.name || '').toLowerCase().includes(q));
  }, [sessions, query]);

  return (
    <div ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-sm transition-colors hover:bg-accent/50 dark:bg-input/20"
      >
        <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('min-w-0 flex-1 truncate', selected.length === 0 && 'text-muted-foreground')}>
          {selected.length === 0
            ? t('tickets.dialog.attachPlaceholder')
            : t('tickets.dialog.attachedCount', { count: selected.length })}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {/* In flow rather than absolutely positioned: the dialog body is its own
          scroll container, so a floating popup would be clipped by it. */}
      {open && (
        <div className="mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
          <div className="border-b p-1.5">
            <SearchInput
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tickets.dialog.searchChats')}
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {matches.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t('tickets.dialog.noChats')}
              </p>
            )}
            {matches.map((s) => {
              const isSelected = selected.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onToggle(s.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <CheckIcon className={cn('size-3.5 shrink-0', isSelected ? 'text-primary' : 'invisible')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{s.name || t('common.untitled')}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {formatRelativeTime(s.last_message_at ?? s.updated_at)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** "Report a problem" — title, free text, and any of the user's own chats
 *  attached as frozen transcripts for the admins to read. */
export function TicketDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { data } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, enabled: open });

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setSelected([]);
    setError(null);
    setSent(false);
  }, [open]);

  const sessions = useMemo(
    () =>
      [...(data ?? [])]
        .filter((s) => !s.archived)
        .sort((a, b) => timestampMs(b.last_message_at ?? b.updated_at) - timestampMs(a.last_message_at ?? a.updated_at)),
    [data],
  );
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createTicket({ title: title.trim(), body: body.trim(), session_ids: selected });
      setSent(true);
      window.setTimeout(onClose, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={t('tickets.dialog.title')} className="w-[min(560px,94vw)]">
        <div className="space-y-3.5 p-5">
          {sent ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('tickets.dialog.sent')}</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="ticket-title">
                  {t('tickets.dialog.titleLabel')}
                </label>
                <Input
                  id="ticket-title"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('tickets.dialog.titlePlaceholder')}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="ticket-body">
                  {t('tickets.dialog.bodyLabel')}
                </label>
                <Textarea
                  id="ticket-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t('tickets.dialog.bodyPlaceholder')}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('tickets.dialog.attachLabel')}
                </span>
                <ChatPicker sessions={sessions} selected={selected} onToggle={toggle} />
                {selected.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {selected.map((id) => (
                      <span
                        key={id}
                        className="flex max-w-full items-center gap-1 rounded-md bg-accent px-1.5 py-1 text-[11px]"
                      >
                        <span className="truncate">{byId.get(id)?.name || t('common.untitled')}</span>
                        <button
                          type="button"
                          aria-label={t('common.remove')}
                          onClick={() => toggle(id)}
                          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {error && <p className="text-xs text-destructive-foreground">{error}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button disabled={!title.trim() || busy} onClick={() => void submit()}>
                  {busy ? t('tickets.dialog.sending') : t('tickets.dialog.submit')}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
