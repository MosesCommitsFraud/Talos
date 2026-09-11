import { ArchiveIcon, BugIcon, FileTextIcon, GhostIcon, MoreVerticalIcon, PencilIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { archiveSession, deleteSession, downloadChatDebugDump, fetchArtifacts, fetchSessions, renameSession } from '@/api/client';
import { useAuth } from './auth/AuthGate';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { isTitlePending, placeholderTitleText } from '@/lib/sessionTitle';
import { Skeleton, Tooltip } from './ui/misc';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';

/** Floating chat header (where the old solid header used to sit): the session
 *  title on the left, and on the right the artifact/preview buttons, the
 *  incognito toggle and a three-dot menu with per-session actions
 *  (rename / archive / delete). A background-coloured fade underneath keeps
 *  messages from scrolling visibly through the controls. */
export function IncognitoToggle() {
  const { t } = useTranslation();
  const incognito = usePrefs((s) => s.incognito);
  const toggle = usePrefs((s) => s.toggle);
  const visible = usePrefs((s) => s.visibility.incognitoBtn);
  const sessionId = useChat((s) => s.sessionId);
  const newChat = useChat((s) => s.newChat);
  const setArtifactsOpen = useUi((s) => s.setArtifactsOpen);
  const setPanelMode = useUi((s) => s.setPanelMode);
  const panelMode = useUi((s) => s.panelMode);
  const artifactsOpen = useUi((s) => s.artifactsOpen);
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [dumping, setDumping] = useState(false);

  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions });
  const session = sessions?.find((s) => s.id === sessionId);
  const title = session?.name ?? '';
  // Placeholder name → the naming model is still working; show a skeleton
  // rather than a title that will be swapped out a second later.
  // (While the list itself is loading there is no name to judge, so the header
  // waits with a skeleton too; a session missing from a loaded list — e.g. an
  // archived one — keeps the old blank-title behaviour.)
  const titlePending = !!sessionId && (sessions === undefined || isTitlePending(session));

  const { data: artifacts } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => fetchArtifacts(sessionId!),
    enabled: !!sessionId,
  });
  const hasArtifacts = (artifacts?.length ?? 0) > 0;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const onRename = () => {
    if (!sessionId) return;
    const name = window.prompt(t('chatHeader.renameChat'));
    if (name?.trim()) void renameSession(sessionId, name.trim()).then(refresh);
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
      <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          {/* pointer-events only on the text itself, so the empty space next to
              a short title doesn't swallow clicks meant for the chat. */}
          {titlePending ? (
            <div className="flex h-7 items-center text-sm font-medium">
              <Skeleton
                className="h-3.5"
                text={placeholderTitleText(session?.name)}
                label={t('chatHeader.titlePending')}
              />
            </div>
          ) : (
            <span className="pointer-events-auto inline-block max-w-full truncate align-middle text-sm font-medium leading-7 text-foreground">
              {title}
            </span>
          )}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          {hasArtifacts && (() => {
            // Each button opens the shared right panel to its view; clicking the
            // active one closes the panel.
            const openMode = (mode: 'files' | 'preview') => {
              if (artifactsOpen && panelMode === mode) setArtifactsOpen(false);
              else { setPanelMode(mode); setArtifactsOpen(true); }
            };
            const active = (mode: 'files' | 'preview') => artifactsOpen && panelMode === mode;
            return (
              <>
                <Tooltip label={t('chatHeader.sessionFiles')}>
                  <button
                    type="button"
                    aria-label={t('chatHeader.sessionFilesAria')}
                    aria-pressed={active('files')}
                    onClick={() => openMode('files')}
                    className={cn(btnBase, active('files') ? 'bg-accent text-foreground' : btnQuiet)}
                  >
                    <FileTextIcon className="size-4" />
                  </button>
                </Tooltip>
                <Tooltip label={t('chatHeader.sessionPreview')}>
                  <button
                    type="button"
                    aria-label={t('chatHeader.sessionPreviewAria')}
                    aria-pressed={active('preview')}
                    onClick={() => openMode('preview')}
                    className={cn(btnBase, active('preview') ? 'bg-accent text-foreground' : btnQuiet)}
                  >
                    <PlayIcon className="size-4" />
                  </button>
                </Tooltip>
              </>
            );
          })()}
          {/* Admin-only: raw JSON dump of the whole chat (reasoning, tool calls,
              tool errors, metrics) for debugging. */}
          {sessionId && auth?.is_admin && (
            <Tooltip label={t('chatHeader.debugDump')}>
              <button
                type="button"
                aria-label={t('chatHeader.debugDump')}
                onClick={onDebugDump}
                disabled={dumping}
                className={cn(btnBase, btnQuiet, dumping && 'opacity-50')}
              >
                <BugIcon className="size-4" />
              </button>
            </Tooltip>
          )}
          {visible && (
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
          {sessionId && (
            <Menu>
              <Tooltip label={t('chatHeader.moreOptions')}>
                <MenuTrigger
                  aria-label={t('chatHeader.moreOptions')}
                  className={cn(btnBase, btnQuiet, 'data-[state=open]:bg-accent data-[state=open]:text-foreground')}
                >
                  <MoreVerticalIcon className="size-4" />
                </MenuTrigger>
              </Tooltip>
              <MenuPopup align="end">
                <MenuItem onSelect={onRename}>
                  <PencilIcon /> {t('chatHeader.rename')}
                </MenuItem>
                <MenuItem onSelect={onArchive}>
                  <ArchiveIcon /> {t('sidebar.archive')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2Icon /> {t('common.delete')}
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
        </div>
      </div>
    </>
  );
}
