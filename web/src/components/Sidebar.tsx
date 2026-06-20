import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  HistoryIcon,
  MessageSquareIcon,
  PanelLeftIcon,
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
import { selectChatStatus, useChat } from '@/state/chat';
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
  MenuTrigger,
} from './ui/menu';

/** The Talos mark (matches the favicon): two stacked sails over a wave. */
function TalosLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      <path d="M16 4L16 22L6 22Z" fill="currentColor" />
      <path d="M16 8L16 22L24 22Z" fill="currentColor" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const SORT_KEYS: Record<SortMode, string> = {
  active: 'sidebar.sortActive',
  newest: 'sidebar.sortNewest',
  name: 'sidebar.sortName',
};

function SessionRow({ session, folders }: { session: Session; folders: string[] }) {
  const { t } = useTranslation();
  const activeId = useChat((s) => s.sessionId);
  const status = useChat(selectChatStatus(session.id));
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
          {status === 'working' ? (
            // Running turn — a shimmering "Working" label, shown even when this
            // chat isn't the one on screen so background turns are visible.
            <span className="shimmer-text shrink-0 text-[11px] font-medium" aria-label={t('sidebar.running')}>
              {t('sidebar.working')}
            </span>
          ) : status === 'awaiting' ? (
            // Turn ended on a question — the chat needs the user's input.
            <span className="shrink-0 text-[11px] font-medium text-warning">
              {t('sidebar.awaiting')}
            </span>
          ) : status === 'completed' ? (
            // Finished in the background — surfaced until the chat is opened.
            <span className="shrink-0 text-[11px] font-medium text-success">
              {t('sidebar.completed')}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
              {formatRelativeTime(session.updated_at)}
            </span>
          )}
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

/** Primary nav row. Fixed height with the icon at a fixed left offset, so the
 *  icon stays put whether the sidebar is expanded or compact — only the label
 *  appears/disappears. When compact, the label moves into a tooltip. */
function NavButton({
  icon,
  label,
  trailing,
  onClick,
  collapsed,
  muteIcon = true,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  collapsed?: boolean;
  muteIcon?: boolean;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-accent/70 [&_svg]:size-[18px] [&_svg]:shrink-0',
        muteIcon && '[&_svg]:text-muted-foreground',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!collapsed && trailing}
    </button>
  );
  return collapsed ? (
    <Tooltip label={label} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function Sidebar({
  onOpenPalette,
  onOpenSettings,
}: {
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, refetchInterval: 30_000 });
  const auth = useAuth();
  const newChat = useChat((s) => s.newChat);

  const sortMode = usePrefs((s) => s.sortMode);
  const setSortMode = usePrefs((s) => s.setSortMode);
  const visibility = usePrefs((s) => s.visibility);
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);

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
  const initial = (auth?.username ?? 'U').slice(0, 1).toUpperCase();

  // The scrolling chat list — shared by the full sidebar and the compact recents flyout.
  const chatList = (
    <>
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
    </>
  );

  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col border-r bg-card transition-[width] duration-200 ease-out',
        collapsed ? 'w-[3.25rem]' : 'w-64',
      )}
      aria-label={t('sidebar.navLabel')}
    >
      {/* Header — fixed height in both modes so the nav rows below never shift.
          Expanded: wordmark + collapse toggle. Compact: logo that turns into the
          toggle icon on hover. */}
      <div className="flex h-12 shrink-0 items-center px-2">
        {collapsed ? (
          <Tooltip label={t('sidebar.expandSidebar')} side="right">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t('sidebar.expandSidebar')}
              className="group flex size-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-accent/70"
            >
              <TalosLogo className="size-5 group-hover:hidden" />
              <PanelLeftIcon className="hidden size-4 text-muted-foreground group-hover:block" />
            </button>
          </Tooltip>
        ) : (
          <>
            <span className="flex-1 truncate pl-2 text-xl font-semibold tracking-tight text-primary">Talos</span>
            <Tooltip label={t('sidebar.collapseSidebar')}>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={t('sidebar.collapseSidebar')}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelLeftIcon className="size-4" />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* Primary nav — identical structure in both modes, so the icons hold their place. */}
      <div className="space-y-0.5 px-2 pt-1">
        <NavButton collapsed={collapsed} icon={<SquarePenIcon />} label={t('sidebar.newChat')} onClick={newChat} />
        <NavButton
          collapsed={collapsed}
          icon={<SearchIcon />}
          label={t('sidebar.search')}
          onClick={onOpenPalette}
          trailing={<Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>}
        />
        {collapsed && (
          // Recents — hover to reveal a flyout list of chats.
          <div className="group/recents relative">
            <button
              type="button"
              aria-label={t('sidebar.recents')}
              className="flex h-9 w-full items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground [&_svg]:size-[18px]"
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                <HistoryIcon />
              </span>
            </button>
            <div className="invisible absolute left-full top-0 z-40 pl-2 opacity-0 transition-opacity group-hover/recents:visible group-hover/recents:opacity-100">
              <div className="flex max-h-[70vh] w-64 flex-col overflow-hidden rounded-xl border bg-popover shadow-[0_12px_32px_rgb(0_0_0/0.18)] dark:shadow-[0_12px_32px_rgb(0_0_0/0.5)]">
                <div className="px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{t('sidebar.recents')}</div>
                <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-2">{chatList}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
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
              </MenuPopup>
            </Menu>
          </div>
          <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">{chatList}</div>
        </>
      )}

      {/* The empty area below the nav is itself a click target to expand. */}
      {collapsed && (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t('sidebar.expandSidebar')}
          className="flex-1 cursor-pointer"
        />
      )}

      {/* Footer */}
      {collapsed ? (
        <div className="p-2">
          {/* Same row geometry as the expanded user bar — min-h-10 matches the
              height the size-7 settings cog gives that row — so the bottom-anchored
              avatar holds its exact position across the open/close animation. */}
          <div className="flex min-h-10 items-center px-2">
            <Tooltip label={auth?.username ?? t('sidebar.account')} side="right">
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label={t('sidebar.account')}
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
              >
                {initial}
              </button>
            </Tooltip>
          </div>
        </div>
      ) : (
        <div className="space-y-0.5 border-t p-2">
          {(visibility.sidebarUserBar || visibility.sidebarSettingsBtn) && (
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              {visibility.sidebarUserBar && (
                <>
                  <div className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                    {initial}
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
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <SettingsIcon className="size-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
