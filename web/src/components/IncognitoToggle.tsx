import { ArchiveIcon, BugIcon, ChevronDownIcon, GhostIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { archiveSession, deleteSession, downloadChatDebugDump, fetchSessions, renameSession } from '@/api/client';
import { useAuth } from './auth/AuthGate';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { isTitlePending, placeholderTitleText } from '@/lib/sessionTitle';
import { selectDockOpen, useUi } from '@/state/ui';
import { PaneToggles } from './RightPanel';
import { SessionFilesPopover } from './SessionFilesPopover';
import { Skeleton, Tooltip } from './ui/misc';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';

/** The chat title, edited in place: a click turns it into an input, Enter or
 *  leaving the field saves, Escape restores the old name. */
function EditableTitle({
  title, editing, onEdit, onDone,
}: {
  title: string;
  editing: boolean;
  onEdit: () => void;
  onDone: (name: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(title);
    // After the menu that may have asked for the edit has handed focus back.
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [editing, title]);

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        aria-label={t('chatHeader.renameChat')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onDone(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onDone(draft); }
          if (e.key === 'Escape') { e.preventDefault(); onDone(null); }
        }}
        // Sized to its text, so it sits exactly where the title was.
        size={Math.max(8, draft.length + 1)}
        className="pointer-events-auto h-7 min-w-0 max-w-full rounded-md border border-ring/60 bg-background px-2 text-sm font-medium text-foreground outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      title={t('chatHeader.clickToRename')}
      className="pointer-events-auto h-7 min-w-0 cursor-text truncate rounded-md px-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent"
    >
      {title}
    </button>
  );
}

/** Floating chat header: the session title (click to rename in place) with a
 *  chevron menu of per-session actions (rename / archive / debug dump /
 *  delete), and on the right the session's file panel. Incognito only shows on a fresh chat, where
 *  it decides how the next chat is kept. A background-coloured fade underneath
 *  keeps messages from scrolling visibly through the controls. */
export function IncognitoToggle() {
  const { t } = useTranslation();
  const incognito = usePrefs((s) => s.incognito);
  const toggle = usePrefs((s) => s.toggle);
  const visible = usePrefs((s) => s.visibility.incognitoBtn);
  const sidebarCollapsed = usePrefs((s) => s.sidebarCollapsed);
  const sessionId = useChat((s) => s.sessionId);
  const newChat = useChat((s) => s.newChat);
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [dumping, setDumping] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);

  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions });
  const session = sessions?.find((s) => s.id === sessionId);
  const title = session?.name ?? '';
  // Placeholder name → the naming model is still working; show a skeleton
  // rather than a title that will be swapped out a second later.
  // (While the list itself is loading there is no name to judge, so the header
  // waits with a skeleton too; a session missing from a loaded list — e.g. an
  // archived one — keeps the old blank-title behaviour.)
  const titlePending = !!sessionId && (sessions === undefined || isTitlePending(session));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const onRenameDone = (name: string | null) => {
    setEditingTitle(false);
    const next = name?.trim();
    if (!sessionId || !next || next === title) return;
    // Show the new name at once; the refetch confirms it.
    queryClient.setQueryData<typeof sessions>(['sessions'], (list) =>
      list?.map((s) => (s.id === sessionId ? { ...s, name: next } : s)));
    void renameSession(sessionId, next).then(refresh);
  };
  const onArchive = () => {
    if (!sessionId) return;
    void archiveSession(sessionId).then(() => { newChat(); refresh(); });
  };
  const onDelete = () => {
    if (!sessionId) return;
    void deleteSession(sessionId).then(() => { newChat(); refresh(); });
  };

  const onDebugDump = () => {
    if (!sessionId || dumping) return;
    setDumping(true);
    void downloadChatDebugDump(sessionId)
      .catch((err: unknown) => window.alert(err instanceof Error ? err.message : String(err)))
      .finally(() => setDumping(false));
  };

  const dockOpen = useUi(selectDockOpen);
  const btnBase =
    'flex size-7 items-center justify-center rounded-md transition-colors';
  const btnQuiet = 'text-muted-foreground hover:bg-accent hover:text-foreground';

  return (
    <>
      {/* Fade in the chat background so messages dissolve instead of sliding
          out from behind the controls: solid down to the bottom of the button
          row, then a short fade. Ends on the background colour at zero alpha
          rather than `transparent` — fading to transparent *black* tints the
          gradient. Only over a real conversation; the welcome screen has
          nothing scrolling under the controls. No z-index on purpose (see the
          render order in App.tsx). */}
      {sessionId && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-12"
          style={{
            background:
              'linear-gradient(to bottom, var(--background) 75%, rgb(from var(--background) r g b / 0) 100%)',
          }}
        />
      )}
      {/* Collapsed, the sidebar's expand button floats over this corner
          (Sidebar.tsx: left-2.5, size-7), so the title starts past it. */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-2 z-10 flex items-center gap-2 px-3', sidebarCollapsed && 'pl-12')}>
        <div className="flex min-w-0 flex-1">
          {titlePending ? (
            <div className="flex h-7 items-center px-2 text-sm font-medium">
              <Skeleton
                className="h-3.5"
                text={placeholderTitleText(session?.name)}
                label={t('chatHeader.titlePending')}
              />
            </div>
          ) : sessionId ? (
            // pointer-events only on the title and chevron, so the empty space
            // next to a short title doesn't swallow clicks meant for the chat.
            <div className="flex min-w-0 items-center">
              <EditableTitle
                title={title}
                editing={editingTitle}
                onEdit={() => setEditingTitle(true)}
                onDone={onRenameDone}
              />
              <Menu>
                <MenuTrigger
                  aria-label={t('chatHeader.moreOptions')}
                  className="group pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                >
                  <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                </MenuTrigger>
                {/* No focus return to the chevron: Rename moves focus into the
                    title field, and the trigger would steal it right back. */}
                <MenuPopup align="start" className="min-w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <MenuItem onSelect={() => setEditingTitle(true)}>
                    <PencilIcon /> {t('chatHeader.rename')}
                  </MenuItem>
                  <MenuItem onSelect={onArchive}>
                    <ArchiveIcon /> {t('sidebar.archive')}
                  </MenuItem>
                  {/* Admin-only: raw JSON dump of the whole chat (reasoning, tool
                      calls, tool errors, metrics) for debugging. */}
                  {auth?.is_admin && (
                    <MenuItem onSelect={onDebugDump} disabled={dumping}>
                      <BugIcon /> {t('chatHeader.debugDump')}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2Icon /> {t('common.delete')}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          {/* Over the dock while it is open (RightDock), which leaves the
              chat title the whole width of the chat column. */}
          {sessionId && !dockOpen && <PaneToggles />}
          {sessionId && !dockOpen && <SessionFilesPopover sessionId={sessionId} />}
          {!sessionId && visible && (
            <Tooltip label={incognito ? t('chatHeader.incognitoOn') : t('chatHeader.incognitoOff')}>
              <button
                type="button"
                aria-label={t('chatHeader.toggleIncognito')}
                aria-pressed={incognito}
                onClick={() => toggle('incognito')}
                className={cn(btnBase, incognito ? 'bg-primary/15 text-primary' : btnQuiet)}
              >
                <GhostIcon className="size-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </>
  );
}
