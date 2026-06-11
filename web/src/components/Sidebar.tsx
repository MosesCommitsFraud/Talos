import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import {
  archiveSession,
  deleteSession,
  fetchAuthInfo,
  fetchSessions,
  markImportant,
  renameSession,
} from '@/api/client';
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
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from './ui/menu';

const SORT_LABELS: Record<SortMode, string> = {
  active: 'Last active',
  newest: 'Newest first',
  name: 'Name A–Z',
};

function SessionRow({ session }: { session: Session }) {
  const activeId = useChat((s) => s.sessionId);
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.name);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const commitRename = async () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== session.name) {
      await renameSession(session.id, name);
      refresh();
    }
  };

  if (renaming) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commitRename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitRename();
          if (e.key === 'Escape') setRenaming(false);
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
          onDoubleClick={() => { setDraft(session.name); setRenaming(true); }}
          title={session.name}
          className={cn(
            'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
            session.id === activeId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{session.name || 'Untitled'}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {formatRelativeTime(session.updated_at)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={() => { setDraft(session.name); setRenaming(true); }}>
          <PencilIcon /> Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void markImportant(session.id, true).then(refresh)}>
          <StarIcon /> Mark important
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void archiveSession(session.id).then(refresh)}>
          <ArchiveIcon /> Archive
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
          <Trash2Icon /> Delete
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
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
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, refetchInterval: 30_000 });
  const { data: auth } = useQuery({ queryKey: ['auth'], queryFn: fetchAuthInfo, staleTime: Infinity });
  const newChat = useChat((s) => s.newChat);

  const sortMode = usePrefs((s) => s.sortMode);
  const setSortMode = usePrefs((s) => s.setSortMode);

  const visible = (sessions ?? [])
    .filter((s) => !s.archived)
    .sort((a, b) => {
      if (sortMode === 'newest') return timestampMs(b.created_at) - timestampMs(a.created_at);
      if (sortMode === 'name') return (a.name || '').localeCompare(b.name || '');
      return timestampMs(b.last_message_at ?? b.updated_at) - timestampMs(a.last_message_at ?? a.updated_at);
    });
  const isMac = /Mac|iPhone/.test(navigator.platform);

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r bg-card" aria-label="Sidebar">
      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <span className="text-[15px] font-semibold tracking-tight text-primary">Talos</span>
      </div>

      <div className="space-y-0.5 px-2 pt-2">
        <NavButton icon={<SquarePenIcon />} label="New chat" onClick={newChat} />
        <NavButton
          icon={<SearchIcon />}
          label="Search"
          onClick={onOpenPalette}
          trailing={<Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>}
        />
      </div>

      <div className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">Tools</div>
      <div className="space-y-0.5 px-2">
        <NavButton icon={<BrainIcon />} label="Brain" onClick={onOpenBrain} />
        <NavButton icon={<BookOpenIcon />} label="Library" onClick={onOpenLibrary} />
      </div>

      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <span className="text-xs font-medium text-muted-foreground">Chats</span>
        <Menu>
          <Tooltip label={`Sort: ${SORT_LABELS[sortMode]}`}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label="Sort chats"
                className="-mr-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowUpDownIcon className="size-3.5" />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuPopup align="start">
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <MenuItem key={mode} onSelect={() => setSortMode(mode)}>
                <CheckIcon className={mode === sortMode ? '' : 'invisible'} />
                {SORT_LABELS[mode]}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => { window.location.href = '/legacy'; }}>
              <ExternalLinkIcon /> Folders & bulk manage
              <span className="ml-auto text-xs text-muted-foreground">legacy</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {visible.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
        {visible.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-xs text-muted-foreground">
            <MessageSquareIcon className="size-4 opacity-60" />
            No chats yet
          </div>
        )}
      </div>

      <div className="space-y-0.5 border-t p-2">
        <a
          href="/legacy"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground [&_svg]:size-4"
        >
          <ExternalLinkIcon />
          <span className="flex-1 text-left">Legacy UI</span>
        </a>
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <div className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
            {(auth?.user ?? 'U').slice(0, 1).toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate text-sm">{auth?.user ?? 'User'}</span>
          <Tooltip label="Settings">
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="Settings"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <SettingsIcon className="size-4" />
            </button>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
}
