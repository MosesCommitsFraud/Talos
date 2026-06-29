import { ArchiveIcon, FileTextIcon, GhostIcon, MoreVerticalIcon, PencilIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { archiveSession, deleteSession, fetchArtifacts, renameSession } from '@/api/client';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { Tooltip } from './ui/misc';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';

/** Floating chat controls pinned to the top-right of the chat area (where the
 *  old header used to sit): the incognito toggle, plus a three-dot menu with
 *  per-session actions (rename / archive / delete). */
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

  const btnBase =
    'flex size-7 items-center justify-center rounded-md transition-colors';
  const btnQuiet = 'text-muted-foreground hover:bg-accent hover:text-foreground';
  // Tighter rows to match the sidebar account dropdown.
  const menuItemCls = 'gap-2.5 rounded-sm! px-2.5 py-1 text-[13px] [&_svg]:size-4';

  return (
    <div className="absolute right-3 top-2 z-10 flex items-center gap-1">
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
          <MenuPopup align="end" className="rounded-md! p-1">
            <MenuItem className={menuItemCls} onSelect={onRename}>
              <PencilIcon /> {t('chatHeader.rename')}
            </MenuItem>
            <MenuItem className={menuItemCls} onSelect={onArchive}>
              <ArchiveIcon /> {t('sidebar.archive')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              className={cn(menuItemCls, 'text-destructive-foreground [&_svg]:text-destructive-foreground')}
              onSelect={onDelete}
            >
              <Trash2Icon /> {t('common.delete')}
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
