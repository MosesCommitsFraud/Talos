import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BriefcaseIcon,
  BugIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  HelpCircleIcon,
  ListFilterIcon,
  LogOutIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShapesIcon,
  ShieldIcon,
  DatabaseIcon,
  TicketIcon,
  Trash2Icon,
  UserIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  archiveSession,
  deleteSession,
  fetchSessions,
  logout,
  markImportant,
  renameSession,
  setSessionFolder,
} from '@/api/client';
import { useAuth } from './auth/AuthGate';
import type { Session } from '@/api/types';
import { selectChatStatus, selectFolderStatus, useChat } from '@/state/chat';
import { usePrefs, type SortMode } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn, formatRelativeTime, timestampMs } from '@/lib/utils';
import { anyTitlePending, isTitlePending, placeholderTitleText } from '@/lib/sessionTitle';
import { Skeleton, Tooltip } from './ui/misc';
import { KeybindingPill } from './ui/kbd';
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
  MenuLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from './ui/menu';

const SORT_KEYS: Record<SortMode, string> = {
  active: 'sidebar.sortActive',
  newest: 'sidebar.sortNewest',
  name: 'sidebar.sortName',
};

/** Truncates normally, then slowly pans only the hidden portion on hover. The
 *  animation stops at the end so the full title can be read without looping. */
function ScrollableSessionTitle({ children, className }: { children: string; className?: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<Animation | null>(null);

  const stop = () => {
    animationRef.current?.cancel();
    animationRef.current = null;
  };
  const start = () => {
    stop();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const distance = Math.ceil(text.scrollWidth - viewport.clientWidth);
    if (distance <= 1) return;
    // Roughly 22 px/s plus a short initial pause: calm enough to read, without
    // making moderately long titles take forever to reveal.
    const duration = Math.max(4_000, (distance / 22) * 1_000 + 1_200);
    animationRef.current = text.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: 0.14 },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ],
      { duration, easing: 'ease-in-out', fill: 'forwards' },
    );
  };

  useEffect(() => stop, []);

  return (
    <span
      ref={viewportRef}
      className={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap', className)}
      onMouseEnter={start}
      onMouseLeave={stop}
    >
      <span ref={textRef} className="inline-block">{children}</span>
    </span>
  );
}

function SessionRow({ session, projects }: { session: Session; projects: string[] }) {
  const { t } = useTranslation();
  const activeId = useChat((s) => s.sessionId);
  const status = useChat(selectChatStatus(session.id));
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const queryClient = useQueryClient();
  // 'rename' edits the chat name; 'project' types a new project to move into.
  const [mode, setMode] = useState<'idle' | 'rename' | 'project'>('idle');
  const [draft, setDraft] = useState('');
  const addProject = usePrefs((s) => s.addProject);
  const pinned = !!session.is_important;
  const titlePending = isTitlePending(session);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const beginRename = () => { setDraft(session.name); setMode('rename'); };
  const beginNewProject = () => { setDraft(''); setMode('project'); };

  // Refresh either way: on failure the list snaps back to what the server
  // actually has, instead of showing a move that never happened.
  const moveToProject = (project: string | null) =>
    void setSessionFolder(session.id, project)
      .catch((err) => console.error('Talos: moving chat to project failed', err))
      .finally(refresh);

  const commit = async () => {
    const value = draft.trim();
    setMode('idle');
    if (mode === 'rename') {
      if (value && value !== session.name) { await renameSession(session.id, value); refresh(); }
    } else if (mode === 'project') {
      if (value && value !== (session.folder ?? '')) {
        try { await setSessionFolder(session.id, value); addProject(value); }
        catch (err) { console.error('Talos: creating project failed', err); }
        refresh();
      }
    }
  };

  if (mode !== 'idle') {
    return (
      <input
        autoFocus
        value={draft}
        placeholder={mode === 'project' ? t('sidebar.projectPlaceholder') : undefined}
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
          className={cn(
            'group relative my-px flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors',
            session.id === activeId ? 'bg-sidebar-active text-strong' : 'hover:bg-sidebar-accent',
          )}
        >
          {pinned && <PinIcon className="size-3 shrink-0 -rotate-45 text-muted-foreground" />}
          {/* Until the model has written a title, the row shows a skeleton
              instead of the placeholder ("Chat: <first words>") the backend
              parks on the session — a title that changes under the user reads
              worse than one that is visibly still loading. */}
          {titlePending ? (
            /* flex-1 like the real title, so the status label / hover timestamp
               keep sitting at the right edge of the row. */
            <div className="min-w-0 flex-1">
              <Skeleton
                className="my-[3px] h-3.5"
                text={placeholderTitleText(session.name)}
                label={t('sidebar.titlePending')}
              />
            </div>
          ) : (
            /* When the hover timestamp overlays the row (idle only — status
               labels reserve their own space), mask the title's tail to
               transparent so the text fades out under the time, regardless
               of the row's background color. */
            <ScrollableSessionTitle
              className={
                status
                  ? undefined
                  : 'group-hover:[mask-image:linear-gradient(to_right,black_calc(100%-7rem),transparent_calc(100%-2rem))]'
              }
            >
              {session.name || t('common.untitled')}
            </ScrollableSessionTitle>
          )}
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
            // Out of flow so the title gets the full row width; fades in on
            // hover over the title's tail, which the mask above fades out —
            // no colored backdrop needed.
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
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
        {/* Getting a chat back out has its own row: burying it at the bottom of
            the "Move to project" submenu made it look like a one-way trip. */}
        {session.folder && (
          <ContextMenuItem onSelect={() => moveToProject(null)}>
            <FolderMinusIcon /> {t('sidebar.removeFromProject')}
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderIcon /> {t('sidebar.moveToProject')}
          </ContextMenuSubTrigger>
          <ContextMenuSubPopup>
            {projects.map((name) => (
              <ContextMenuItem key={name} onSelect={() => moveToProject(name)}>
                <CheckIcon className={name === session.folder ? '' : 'invisible'} />
                <span className="truncate">{name}</span>
              </ContextMenuItem>
            ))}
            {session.folder && (
              <ContextMenuItem onSelect={() => moveToProject(null)}>
                <CheckIcon className="invisible" /> {t('sidebar.noProject')}
              </ContextMenuItem>
            )}
            {projects.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem onSelect={beginNewProject}>
              <FolderPlusIcon /> {t('sidebar.newProject')}
            </ContextMenuItem>
          </ContextMenuSubPopup>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => void archiveSession(session.id).then(refresh)}>
          <ArchiveIcon /> {t('sidebar.archive')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
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

/** One row in the Projects section. Selecting it filters the chat list below;
 *  the context menu renames or deletes the project. A project has no row of its
 *  own on the server — it exists as a label on its chats plus an entry in prefs
 *  (which is what lets an empty one exist at all), so both operations are a
 *  batch update of its members. */
function ProjectRow({
  name,
  members,
  active,
  onSelect,
}: {
  name: string;
  /** Every chat carrying this project label, pinned ones included. */
  members: Session[];
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const renameProjectPref = usePrefs((s) => s.renameProjectPref);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const status = useChat(selectFolderStatus(members.map((s) => s.id)));

  const setFolder = async (target: string | null) => {
    try {
      await Promise.all(members.map((s) => setSessionFolder(s.id, target)));
      renameProjectPref(name, target);
    } catch (err) {
      console.error('Talos: updating project failed', err);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  };

  const commitRename = async () => {
    const value = draft.trim();
    setRenaming(false);
    if (value && value !== name) await setFolder(value);
  };

  if (renaming) {
    return (
      <input
        autoFocus
        value={draft}
        placeholder={t('sidebar.projectPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commitRename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitRename();
          if (e.key === 'Escape') { setDraft(name); setRenaming(false); }
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
          onClick={onSelect}
          onDoubleClick={() => { setDraft(name); setRenaming(true); }}
          className={cn(
            'group my-px flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors',
            active ? 'bg-sidebar-active text-strong' : 'hover:bg-sidebar-accent',
          )}
        >
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {status === 'working' ? (
            <span className="shimmer-text shrink-0 text-[11px] font-medium" title={t('sidebar.projectWorking')}>
              {t('sidebar.working')}
            </span>
          ) : status ? (
            // Quieter than a label: a dot in the same palette the rows use.
            <span
              title={t(status === 'awaiting' ? 'sidebar.projectAwaiting' : 'sidebar.projectCompleted')}
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                status === 'awaiting' ? 'bg-warning' : 'bg-success',
              )}
            />
          ) : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{members.length}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={() => { setDraft(name); setRenaming(true); }}>
          <PencilIcon /> {t('sidebar.renameProject')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Deletes the project only — its chats move back to the flat list. */}
        <ContextMenuItem variant="destructive" onSelect={() => void setFolder(null)}>
          <FolderMinusIcon /> {t('sidebar.deleteProject')}
          <span className="ms-auto ps-2 text-[11px] text-muted-foreground">{t('sidebar.deleteProjectHint')}</span>
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** Primary nav row (New / Projects / Artifacts / Customize). `anim` names the
 *  small move the icon makes while the row is hovered — see `.nav-row` in
 *  index.css. "New" takes none: it is the row people hit without looking, and
 *  the one that should read as a plain button. */
/* Every row in the sidebar carries `my-px` and a matching notch off its own
 * padding: the pitch of the list is unchanged, but two highlighted rows next to
 * each other (the hovered one and the selected one) are separated by a hairline
 * instead of merging into one block. */
function NavRow({
  icon,
  label,
  anim,
  onClick,
  emphasis,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  anim?: 'lift' | 'shapes' | 'tilt';
  onClick?: () => void;
  /** The "New" row sits a shade brighter — it is the sidebar's primary action. */
  emphasis?: boolean;
  /** This row's page is the one on screen. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'nav-row my-px flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0',
        emphasis || active
          ? 'bg-sidebar-active text-strong hover:bg-sidebar-active'
          : 'text-foreground/80 hover:bg-sidebar-accent hover:text-foreground',
      )}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center', anim && `nav-anim-${anim}`)}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  );
}

/** The account dropdown anchored to the footer avatar. Holds the entries that
 *  used to be a single Settings button: scoped Settings / Admin panel / Help /
 *  Archive / Account / Log out. */
function AccountMenu({
  trigger,
  isAdmin,
  authEnabled,
  username,
  actions,
}: {
  trigger: React.ReactNode;
  isAdmin: boolean;
  authEnabled: boolean;
  username: string;
  actions: AccountActions;
}) {
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuPopup side="top" align="start" sideOffset={6} className="w-60">
        <MenuLabel className="truncate text-foreground/70">{username}</MenuLabel>
        <MenuItem onSelect={actions.onOpenSettings}>
          <SettingsIcon /> {t('sidebar.menu.settings')}
        </MenuItem>
        {isAdmin && (
          <MenuItem onSelect={actions.onOpenAdmin}>
            <ShieldIcon /> {t('sidebar.menu.adminPanel')}
          </MenuItem>
        )}
        {isAdmin && (
          <MenuItem onSelect={actions.onOpenRag}>
            <DatabaseIcon /> {t('sidebar.menu.rag')}
          </MenuItem>
        )}
        {isAdmin && (
          <MenuItem onSelect={actions.onOpenTickets}>
            <TicketIcon /> {t('sidebar.menu.tickets')}
          </MenuItem>
        )}
        <MenuItem onSelect={actions.onOpenHelp}>
          <HelpCircleIcon /> {t('sidebar.menu.help')}
        </MenuItem>
        <MenuItem onSelect={actions.onOpenArchive}>
          <ArchiveIcon /> {t('sidebar.menu.archive')}
        </MenuItem>
        <MenuItem onSelect={actions.onOpenAccount}>
          <UserIcon /> {t('sidebar.menu.account')}
        </MenuItem>
        {authEnabled && (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onSelect={() => void logout()}>
              <LogOutIcon /> {t('sidebar.menu.logOut')}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

interface AccountActions {
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
  onOpenHelp: () => void;
  onOpenArchive: () => void;
  onOpenAccount: () => void;
  onOpenRag: () => void;
  onOpenTickets: () => void;
}

interface SidebarProps {
  onOpenPalette: () => void;
  account: AccountActions;
  /** Opens the "report a problem" modal — the ticket button in the account
   *  row, available to every user (admins triage in /tickets). */
  onOpenTicketDialog: () => void;
}

/** The full-width sidebar contents. Rendered twice: once as the real sidebar,
 *  and once, dimmed and inert, as the hover preview of the collapsed rail —
 *  hence `preview`, which drops the wordmark the rail's expand button covers. */
function SidebarBody({ onOpenPalette, account, onOpenTicketDialog, preview }: SidebarProps & { preview?: boolean }) {
  const { t } = useTranslation();
  // While a chat is still waiting for its generated title, poll fast so the
  // skeleton is replaced the moment the backend's naming task finishes;
  // otherwise the list only needs the lazy 30s refresh.
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: (query) => (anyTitlePending(query.state.data) ? 2_000 : 30_000),
  });
  const auth = useAuth();
  const newChat = useChat((s) => s.newChat);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  /** Which project's chats the list is showing; null = every loose chat. Shared
   *  state: the Projects page opens a project into this same list. */
  const openProject = useUi((s) => s.openProject);
  const setOpenProject = useUi((s) => s.setOpenProject);

  const sortMode = usePrefs((s) => s.sortMode);
  const setSortMode = usePrefs((s) => s.setSortMode);
  const visibility = usePrefs((s) => s.visibility);
  const storedProjects = usePrefs((s) => s.projects);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);

  const sorter = (a: Session, b: Session) => {
    if (sortMode === 'newest') return timestampMs(b.created_at) - timestampMs(a.created_at);
    if (sortMode === 'name') return (a.name || '').localeCompare(b.name || '');
    return timestampMs(b.last_message_at ?? b.updated_at) - timestampMs(a.last_message_at ?? a.updated_at);
  };

  const active = (sessions ?? []).filter((s) => !s.archived);
  // Projects are the union of the labels the server knows about (a label exists
  // as long as a chat carries it) and the ones created here but still empty.
  const projectNames = [
    ...new Set([
      ...active.map((s) => s.folder).filter((f): f is string => !!f),
      ...storedProjects.map((p) => p.name),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  // An open project narrows the list to its chats; otherwise the list is the
  // loose chats, with pinned ones floated into their own section on top.
  const inProject = openProject !== null ? active.filter((s) => s.folder === openProject) : [];
  const loose = active.filter((s) => !s.folder);
  const pinned = openProject === null ? loose.filter((s) => s.is_important).sort(sorter) : [];
  const rows = openProject === null ? loose.filter((s) => !s.is_important).sort(sorter) : inProject.slice().sort(sorter);
  const accountLabel = auth?.display_name || auth?.username;
  const initial = (accountLabel ?? 'U').slice(0, 1).toUpperCase();

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-foreground/70">
      {/* Header — the wordmark, at the same height as the rail's expand button
          so nothing below shifts when the sidebar collapses. */}
      <div className="flex h-12 shrink-0 items-center px-3">
        {!preview && (
          <span className="truncate text-xl font-semibold tracking-tight text-primary">Talos</span>
        )}
      </div>

      {/* Primary nav — each row below "New" opens its full-page view, and shows
          as selected while that view is the one on screen. */}
      <div className="px-2">
        <NavRow
          emphasis
          icon={<PlusIcon />}
          label={t('sidebar.new')}
          onClick={() => { newChat(); setView('chat'); }}
        />
        <NavRow
          anim="lift"
          icon={<ArchiveIcon />}
          label={t('sidebar.projects')}
          active={view === 'projects'}
          onClick={() => setView('projects')}
        />
        <NavRow
          anim="shapes"
          icon={<ShapesIcon />}
          label={t('sidebar.artifacts')}
          active={view === 'artifacts'}
          onClick={() => setView('artifacts')}
        />
        <NavRow
          anim="tilt"
          icon={<BriefcaseIcon />}
          label={t('sidebar.customize')}
          active={view === 'customize'}
          onClick={() => setView('customize')}
        />
      </div>

      {/* Projects — a short, non-scrolling section; the chat list below takes
          the remaining height. */}
      <div className="mt-4 px-2">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-xs font-medium text-muted-foreground">{t('sidebar.projects')}</span>
          <Tooltip label={t('sidebar.newProject')}>
            <button
              type="button"
              onClick={() => setCreateProjectOpen(true)}
              aria-label={t('sidebar.newProject')}
              className="-mr-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="max-h-44 overflow-y-auto">
          {projectNames.map((name) => (
            <ProjectRow
              key={name}
              name={name}
              members={active.filter((s) => s.folder === name)}
              active={name === openProject}
              // Selecting a project also leaves whichever page was open: the
              // chats it holds are in the list below, not on that page.
              onSelect={() => {
                setOpenProject(name === openProject ? null : name);
                setView('chat');
              }}
            />
          ))}
          {projectNames.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground/80">
              <PinIcon className="size-3.5 shrink-0 -rotate-45" />
              <span className="min-w-0 truncate">{t('sidebar.noProjects')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Chats — the scrolling remainder. Its header doubles as the way back out
          of an open project. */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 pb-1">
          {openProject === null ? (
            // Names whichever group comes first in the list below — pinned
            // chats float to the top, and the rest get their own "Chats"
            // heading further down.
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {pinned.length > 0 && <PinIcon className="size-3 -rotate-45" />}
              {t(pinned.length > 0 ? 'sidebar.pinned' : 'sidebar.chats')}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setOpenProject(null)}
              className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3 shrink-0" />
              <span className="truncate">{openProject}</span>
            </button>
          )}
          <Menu>
            <Tooltip label={t('sidebar.sortLabel', { mode: t(SORT_KEYS[sortMode]) })}>
              <MenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('sidebar.sortChats')}
                  className="-mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                >
                  <ListFilterIcon className="size-3.5" />
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
        {/* No bottom padding: the footer divider sits flush against the last
            chat row, and the footer supplies the space below it instead. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {pinned.length > 0 && (
            <>
              {/* No heading of its own — the section header above already reads
                  "Pinned" whenever these rows are present. */}
              {pinned.map((s) => (
                <SessionRow key={s.id} session={s} projects={projectNames} />
              ))}
              {rows.length > 0 && (
                <div className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">{t('sidebar.chats')}</div>
              )}
            </>
          )}
          {rows.map((s) => (
            <SessionRow key={s.id} session={s} projects={projectNames} />
          ))}
          {rows.length === 0 && pinned.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-xs text-muted-foreground">
              <MessageSquareIcon className="size-4 opacity-60" />
              {t('sidebar.noChats')}
            </div>
          )}
        </div>
      </div>

      {/* Footer — the account avatar opens a dropdown (Settings / Admin / Help /
          Archive / Account / Log out); search and the collapse toggle sit beside
          it as icon buttons. */}
      <div className="px-2 pb-2">
        <div className="mx-1 mb-2 h-px bg-border" />
        <div className="flex items-center gap-1">
          {(visibility.sidebarUserBar || visibility.sidebarSettingsBtn) && (
            <AccountMenu
              isAdmin={!!auth?.is_admin}
              authEnabled={auth?.auth_enabled !== false}
              username={accountLabel ?? t('sidebar.user')}
              actions={account}
              trigger={
                <button
                  type="button"
                  aria-label={t('sidebar.account')}
                  // Sized to its own label (capped so a long name can't crowd
                  // the icons out), not stretched across the row.
                  className="flex min-w-0 max-w-[calc(100%-6rem)] items-center gap-1.5 rounded-sm px-2 py-1 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                    {initial}
                  </span>
                  <span className="min-w-0 truncate text-[13px] text-foreground/95 dark:text-inherit">{accountLabel ?? t('sidebar.user')}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              }
            />
          )}
          <Tooltip label={t('tickets.report')}>
            <button
              type="button"
              onClick={onOpenTicketDialog}
              aria-label={t('tickets.report')}
              className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-foreground dark:text-muted-foreground"
            >
              <BugIcon className="size-4" />
            </button>
          </Tooltip>
          <Tooltip label={<span className="flex items-center gap-1.5">{t('sidebar.search')}<KeybindingPill value="mod+k" /></span>}>
            <button
              type="button"
              onClick={onOpenPalette}
              aria-label={t('sidebar.search')}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <SearchIcon className="size-4" />
            </button>
          </Tooltip>
          <Tooltip label={<span className="flex items-center gap-1.5">{t('sidebar.collapseSidebar')}<KeybindingPill value="mod+b" /></span>}>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t('sidebar.collapseSidebar')}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <PanelLeftIcon className="size-4" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** Left navigation. Expanded it is a flush panel separated from the chat by a
 *  divider; collapsed it shrinks to a rail holding nothing but the expand
 *  button — hovering that button previews the whole sidebar, dimmed, and a
 *  click anywhere in the preview commits to it. */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);
  const [peek, setPeek] = useState(false);

  // Ctrl/⌘-B mirrors the footer toggle, matching the tooltip's hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  useEffect(() => { if (!collapsed) setPeek(false); }, [collapsed]);

  if (!collapsed) {
    return (
      <nav className="w-64 shrink-0 border-r border-border" aria-label={t('sidebar.navLabel')}>
        <SidebarBody {...props} />
      </nav>
    );
  }

  return (
    // Zero width: collapsed leaves no panel behind at all, just the button
    // floating over the top-left corner of the chat.
    <nav className="relative w-0 shrink-0" aria-label={t('sidebar.navLabel')}>
      {/* Above the preview, so it keeps its own hover state (and its tooltip)
          while the preview is showing. */}
      <div className="absolute left-2.5 top-2.5 z-50">
        <Tooltip label={<span className="flex items-center gap-1.5">{t('sidebar.expandSidebar')}<KeybindingPill value="mod+b" /></span>} side="right">
          <button
            type="button"
            onClick={toggleSidebar}
            onMouseEnter={() => setPeek(true)}
            onFocus={() => setPeek(true)}
            onBlur={() => setPeek(false)}
            aria-label={t('sidebar.expandSidebar')}
            aria-expanded={peek}
            // Collapsed, this button floats over the chat rather than the
            // panel, so it takes the page's own hover tint.
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelLeftIcon className="size-4" />
          </button>
        </Tooltip>
      </div>
      {/* Hover preview: the expanded sidebar at reduced contrast, laid over the
          chat. It is a picture of what expanding gives you, not a working copy —
          the contents are inert and a click anywhere commits to expanding. */}
      <div
        onMouseEnter={() => setPeek(true)}
        onMouseLeave={() => setPeek(false)}
        className={cn(
          'absolute inset-y-0 left-0 z-40 w-64 border-r border-border bg-sidebar shadow-lg transition-opacity duration-150',
          peek ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <div className="pointer-events-none h-full opacity-55 saturate-[0.9]" aria-hidden>
          <SidebarBody {...props} preview />
        </div>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t('sidebar.expandSidebar')}
          className="absolute inset-0 cursor-pointer"
        />
      </div>
    </nav>
  );
}
