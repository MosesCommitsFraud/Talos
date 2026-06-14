import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  archiveSession,
  deleteSession,
  fetchSessions,
  markImportant,
  renameSession,
  setSessionFolder,
} from '@/api/client';
import { useAuth } from './auth/AuthGate';
import type { Session } from '@/api/types';
import { useChat } from '@/state/chat';
import { usePrefs, type SortMode } from '@/state/prefs';
import { cn, formatRelativeTime, timestampMs } from '@/lib/utils';
import { Kbd, Tooltip } from './ui/misc';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from './ui/menu';

const SORT_KEYS: Record<SortMode, string> = {
  active: 'sidebar.sortActive',
  newest: 'sidebar.sortNewest',
  name: 'sidebar.sortName',
};

function SessionRow({ session, folders }: { session: Session; folders: string[] }) {
  const { t } = useTranslation();
  const activeId = useChat((s) => s.sessionId);
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const queryClient = useQueryClient();
  // 'rename' edits the chat name; 'folder' types a new folder to move into.
  const [mode, setMode] = useState<'idle' | 'rename' | 'folder'>('idle');
  const [draft, setDraft] = useState('');
  const pinned = !!session.is_important;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const beginRename = () => { setDraft(session.name); setMode('rename'); };
  const beginNewFolder = () => { setDraft(''); setMode('folder'); };

  const moveToFolder = (folder: string | null) =>
    void setSessionFolder(session.id, folder).then(refresh);

  const commit = async () => {
    const value = draft.trim();
    setMode('idle');
    if (mode === 'rename') {
      if (value && value !== session.name) { await renameSession(session.id, value); refresh(); }
    } else if (mode === 'folder') {
      if (value && value !== (session.folder ?? '')) { await setSessionFolder(session.id, value); refresh(); }
    }
  };

  if (mode !== 'idle') {
    return (
      <input
        autoFocus
        value={draft}
        placeholder={mode === 'folder' ? t('sidebar.folderPlaceholder') : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') setMode('idle');
        }}
        className="mx-0.5 my-px w-[calc(100%-4px)] rounded-lg border border-ring bg-transparent px-2 py-1.5 text-sm outline-none"
      />
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => void openSession(session.id)}
          onDoubleClick={beginRename}
          title={session.name}
          className={cn(
            'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
            session.id === activeId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70',
          )}
        >
          {pinned && <PinIcon className="size-3 shrink-0 -rotate-45 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{session.name || t('common.untitled')}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {formatRelativeTime(session.updated_at)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={beginRename}>
          <PencilIcon /> {t('sidebar.rename')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void markImportant(session.id, !pinned).then(refresh)}>
          {pinned ? <PinOffIcon /> : <PinIcon />} {t(pinned ? 'sidebar.unpin' : 'sidebar.pin')}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderIcon /> {t('sidebar.moveToFolder')}
            <ChevronRightIcon className="ml-auto" />
          </ContextMenuSubTrigger>
          <ContextMenuSubPopup>
            {folders.map((name) => (
              <ContextMenuItem key={name} onSelect={() => moveToFolder(name)}>
                <CheckIcon className={name === session.folder ? '' : 'invisible'} />
                <span className="truncate">{name}</span>
              </ContextMenuItem>
            ))}
            {session.folder && (
              <ContextMenuItem onSelect={() => moveToFolder(null)}>
                <CheckIcon className="invisible" /> {t('sidebar.noFolder')}
              </ContextMenuItem>
            )}
            {folders.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem onSelect={beginNewFolder}>
              <FolderPlusIcon /> {t('sidebar.newFolder')}
            </ContextMenuItem>
          </ContextMenuSubPopup>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => void archiveSession(session.id).then(refresh)}>
          <ArchiveIcon /> {t('sidebar.archive')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive-foreground [&_svg]:text-destructive-foreground"
          onSelect={() => {
            void deleteSession(session.id).then(() => {
              if (session.id === activeId) newChat();
              refresh();
            });
          }}
        >
          <Trash2Icon /> {t('common.delete')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

function FolderGroup({ name, sessions, folders }: { name: string; sessions: Session[]; folders: string[] }) {
  const collapsed = usePrefs((s) => s.collapsedFolders.includes(name));
  const toggleFolder = usePrefs((s) => s.toggleFolder);
  return (
    <div>
      <button
        type="button"
        onClick={() => toggleFolder(name)}
        className="group flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/70"
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 tabular-nums opacity-70">{sessions.length}</span>
      </button>
      {!collapsed && (
        <div className="space-y-px pl-2">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} folders={folders} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavButton({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent/70 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </button>
  );
}

export function Sidebar({
  onOpenPalette,
  onOpenSettings,
  onOpenBrain,
  onOpenLibrary,
}: {
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onOpenBrain: () => void;
  onOpenLibrary: () => void;
}) {
  const { t } = useTranslation();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, refetchInterval: 30_000 });
  const auth = useAuth();
  const newChat = useChat((s) => s.newChat);

  const sortMode = usePrefs((s) => s.sortMode);
  const setSortMode = usePrefs((s) => s.setSortMode);
  const visibility = usePrefs((s) => s.visibility);

  const sorter = (a: Session, b: Session) => {
    if (sortMode === 'newest') return timestampMs(b.created_at) - timestampMs(a.created_at);
    if (sortMode === 'name') return (a.name || '').localeCompare(b.name || '');
    return timestampMs(b.last_message_at ?? b.updated_at) - timestampMs(a.last_message_at ?? a.updated_at);
  };

  const active = (sessions ?? []).filter((s) => !s.archived);
  // Every folder that exists anywhere — drives the "Move to folder" submenu.
  const folderNames = [...new Set(active.map((s) => s.folder).filter((f): f is string => !!f))]
    .sort((a, b) => a.localeCompare(b));
  // Pinned chats float to their own section, independent of folder.
  const pinned = active.filter((s) => s.is_important).sort(sorter);
  const rest = active.filter((s) => !s.is_important);
  const grouped = folderNames
    .map((name) => ({ name, items: rest.filter((s) => s.folder === name).sort(sorter) }))
    .filter((g) => g.items.length > 0);
  const ungrouped = rest.filter((s) => !s.folder).sort(sorter);
  const isMac = /Mac|iPhone/.test(navigator.platform);

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r bg-card" aria-label={t('sidebar.navLabel')}>
      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <span className="text-[15px] font-semibold tracking-tight text-primary">Talos</span>
      </div>

      <div className="space-y-0.5 px-2 pt-2">
        <NavButton icon={<SquarePenIcon />} label={t('sidebar.newChat')} onClick={newChat} />
        <NavButton
          icon={<SearchIcon />}
          label={t('sidebar.search')}
          onClick={onOpenPalette}
          trailing={<Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>}
        />
      </div>

      {(visibility.sidebarBrain || visibility.sidebarLibrary) && (
        <>
          <div className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">{t('sidebar.tools')}</div>
          <div className="space-y-0.5 px-2">
            {visibility.sidebarBrain && <NavButton icon={<BrainIcon />} label={t('sidebar.brain')} onClick={onOpenBrain} />}
            {visibility.sidebarLibrary && <NavButton icon={<BookOpenIcon />} label={t('sidebar.library')} onClick={onOpenLibrary} />}
          </div>
        </>
      )}

      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <span className="text-xs font-medium text-muted-foreground">{t('sidebar.chats')}</span>
        <Menu>
          <Tooltip label={t('sidebar.sortLabel', { mode: t(SORT_KEYS[sortMode]) })}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t('sidebar.sortChats')}
                className="-mr-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowUpDownIcon className="size-3.5" />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuPopup align="start">
            {(Object.keys(SORT_KEYS) as SortMode[]).map((mode) => (
              <MenuItem key={mode} onSelect={() => setSortMode(mode)}>
                <CheckIcon className={mode === sortMode ? '' : 'invisible'} />
                {t(SORT_KEYS[mode])}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => { window.location.href = '/legacy'; }}>
              <ExternalLinkIcon /> {t('sidebar.foldersBulk')}
              <span className="ml-auto text-xs text-muted-foreground">{t('common.legacy')}</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {pinned.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
              <PinIcon className="size-3 -rotate-45" /> {t('sidebar.pinned')}
            </div>
            {pinned.map((s) => (
              <SessionRow key={s.id} session={s} folders={folderNames} />
            ))}
          </>
        )}
        {grouped.map((g) => (
          <FolderGroup key={g.name} name={g.name} sessions={g.items} folders={folderNames} />
        ))}
        {(pinned.length > 0 || grouped.length > 0) && ungrouped.length > 0 && (
          <div className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">{t('sidebar.chats')}</div>
        )}
        {ungrouped.map((s) => (
          <SessionRow key={s.id} session={s} folders={folderNames} />
        ))}
        {active.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-xs text-muted-foreground">
            <MessageSquareIcon className="size-4 opacity-60" />
            {t('sidebar.noChats')}
          </div>
        )}
      </div>

      <div className="space-y-0.5 border-t p-2">
        <a
          href="/legacy"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground [&_svg]:size-4"
        >
          <ExternalLinkIcon />
          <span className="flex-1 text-left">{t('sidebar.legacyUi')}</span>
        </a>
        {(visibility.sidebarUserBar || visibility.sidebarSettingsBtn) && (
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            {visibility.sidebarUserBar && (
              <>
                <div className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                  {(auth?.username ?? 'U').slice(0, 1).toUpperCase()}
                </div>
                <span className="min-w-0 flex-1 truncate text-sm">{auth?.username ?? t('sidebar.user')}</span>
              </>
            )}
            {!visibility.sidebarUserBar && <span className="flex-1" />}
            {visibility.sidebarSettingsBtn && (
              <Tooltip label={t('sidebar.settingsHidden')}>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  aria-label={t('sidebar.settings')}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <SettingsIcon className="size-4" />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
