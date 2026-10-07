import { ArchiveIcon, BugIcon, ChevronDownIcon, FileIcon, FolderArchiveIcon, GhostIcon, PaperclipIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { archiveSession, deleteSession, downloadArtifactsZip, downloadChatDebugDump, fetchSessions, renameSession, uploadDownloadUrl } from '@/api/client';
import { useAuth } from './auth/AuthGate';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { displayName, fileTypeLabel } from '@/lib/files';
import { isTitlePending, placeholderTitleText } from '@/lib/sessionTitle';
import { useSessionFiles } from '@/lib/useSessionFiles';
import { AttachmentTile, openUploadViewer } from './AttachmentTile';
import { OutputTile, openSessionFile } from './OutputCard';
import { Skeleton, Tooltip } from './ui/misc';
import { Menu, MenuItem, MenuLabel, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';

/** The header's file button ("📄 3"): a dropdown listing everything the agent
 *  produced, each with a small preview, plus the uploads used in the chat.
 *  Picking a file opens it in the preview panel. */
function SessionFilesMenu({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { outputs, inputs } = useSessionFiles(sessionId);
  if (outputs.length === 0 && inputs.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
          aria-label={t('outputs.filesAria', { count: outputs.length })}
          className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <FileIcon className="size-3.5" />
          <span className="tabular-nums">{outputs.length || inputs.length}</span>
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-[70vh] w-80 overflow-y-auto">
        {outputs.length > 0 && (
          <>
            <MenuLabel>{t('outputs.title')}</MenuLabel>
            {outputs.map((f) => (
              <MenuItem key={f.path} onSelect={() => openSessionFile(sessionId, f)} className="group/out gap-3 py-1.5" title={f.name}>
                <OutputTile sessionId={sessionId} file={f} size="sm" />
                <span className="min-w-0 flex-1 truncate">{displayName(f.name)}</span>
                <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">{fileTypeLabel(f.name, f.mime)}</span>
              </MenuItem>
            ))}
          </>
        )}
        {inputs.length > 0 && (
          <>
            {outputs.length > 0 && <MenuSeparator />}
            <MenuLabel className="flex items-center gap-1.5"><PaperclipIcon className="size-3" />{t('outputs.usedInSession')}</MenuLabel>
            {inputs.map((f) => {
              const name = f.name || f.id;
              const url = uploadDownloadUrl(f.id);
              return (
                <MenuItem
                  key={f.id}
                  className="gap-3 py-1.5"
                  title={name}
                  onSelect={() => {
                    if (openUploadViewer({ url, name, mime: f.mime, sessionId })) return;
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = name;
                    a.click();
                  }}
                >
                  <AttachmentTile url={url} name={name} mime={f.mime} size={36} />
                  <span className="min-w-0 flex-1 truncate">{displayName(name)}</span>
                  <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">{fileTypeLabel(name, f.mime)}</span>
                </MenuItem>
              );
            })}
          </>
        )}
        {outputs.length > 0 && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => { void downloadArtifactsZip(sessionId); }}>
              <FolderArchiveIcon /> {t('artifacts.downloadZip')}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** Floating chat header: the session title doubles as a dropdown with the
 *  per-session actions (rename / archive / debug dump / delete), and on the
 *  right the session's file menu. Incognito only shows on a fresh chat, where
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

  const onRename = () => {
    if (!sessionId) return;
    const name = window.prompt(t('chatHeader.renameChat'), title);
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
            // pointer-events only on the trigger itself, so the empty space next
            // to a short title doesn't swallow clicks meant for the chat.
            <Menu>
              <MenuTrigger
                aria-label={t('chatHeader.moreOptions')}
                className="group pointer-events-auto flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-sm font-medium text-foreground transition-colors hover:bg-accent data-[state=open]:bg-accent"
              >
                <span className="truncate">{title}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </MenuTrigger>
              <MenuPopup align="start" className="min-w-44">
                <MenuItem onSelect={onRename}>
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
          ) : null}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          {sessionId && <SessionFilesMenu sessionId={sessionId} />}
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
