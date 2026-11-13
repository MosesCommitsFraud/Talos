import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BrainIcon,
  BriefcaseIcon,
  BugIcon,
  CheckIcon,
  ChevronDownIcon,
  DatabaseIcon,
  EllipsisIcon,
  FolderIcon,
  FolderMinusIcon,
  GaugeIcon,
  GlobeIcon,
  HelpCircleIcon,
  KeyboardIcon,
  LogOutIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShapesIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SunIcon,
  SunMoonIcon,
  TicketIcon,
  UsersIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  archiveSession,
  createProject,
  deleteProject,
  deleteSession,
  fetchSessions,
  forkSession,
  logout,
  markImportant,
  renameSession,
  setSessionProject,
  setSessionSection,
  setSessionUnread,
  updateProject,
  type ProjectSummary,
} from '@/api/client';
import { useMoveStoredProjects, useProjects } from '@/lib/useProjects';
import { useAuth } from './auth/AuthGate';
import type { Session } from '@/api/types';
import { selectChatStatus, selectFolderStatus, useChat } from '@/state/chat';
import { applyLang, applyTheme, usePrefs, type SortMode, type Theme } from '@/state/prefs';
import { LANGUAGES } from '@/i18n';
import { useUi } from '@/state/ui';
import { brand } from '@/lib/brand';
import { cn, timestampMs } from '@/lib/utils';
import { anyTitlePending, isTitlePending, placeholderTitleText } from '@/lib/sessionTitle';
import { Skeleton, Tooltip } from './ui/misc';
import { KeybindingPill } from './ui/kbd';
import { matchesBinding, useKeybinds } from '@/lib/keybinds';
import { useNarrowWindow } from '@/lib/useNarrowWindow';
import { BrandImage } from './BrandImage';
import { ListOptionsMenu } from './ListOptionsMenu';
import { runSessionShortcut, SessionMenuPopup, type SessionMenuActions } from './SessionMenu';
import { toast, toastError } from './ui/toast';
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
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from './ui/menu';
import { requestSettingsPanel } from './ComposerAddMenu';

/** Chats rendered before the list asks for "show more" — keeps the DOM small
 *  for users with hundreds of chats while the common case needs no click. */
const CHAT_PAGE = 30;

function compareSessions(mode: SortMode) {
  return (a: Session, b: Session) => {
    if (mode === 'newest') return timestampMs(b.created_at) - timestampMs(a.created_at);
    if (mode === 'name') return (a.name || '').localeCompare(b.name || '');
    return timestampMs(b.last_message_at ?? b.updated_at) - timestampMs(a.last_message_at ?? a.updated_at);
  };
}

function isTypingTarget(element: Element | null) {
  return element instanceof HTMLElement
    && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}

/** The chat menu's letters, live while the mouse rests on a row. Never while
 *  something is being typed: with the cursor in the composer the letter belongs
 *  there, and a "d" must not delete a chat because the mouse happens to sit on it.
 *  An open menu or dialog answers for itself. */
function useHoverShortcuts(run: (key: string) => boolean, enabled: boolean) {
  const runRef = useRef(run);
  runRef.current = run;
  const stopRef = useRef<(() => void) | null>(null);
  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled]);
  return {
    onMouseEnter: () => {
      stop();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.repeat) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key.length !== 1) return;
        if (isTypingTarget(document.activeElement)) return;
        if (document.querySelector('[role="menu"],[role="dialog"],[role="alertdialog"]')) return;
        if (runRef.current(event.key.toLowerCase())) event.preventDefault();
      };
      window.addEventListener('keydown', onKeyDown);
      stopRef.current = () => window.removeEventListener('keydown', onKeyDown);
    },
    onMouseLeave: stop,
  };
}

/** A section's header: no surface of its own, so it scrolls along with its chats. */
const SECTION_HEADER_CLASS = 'flex h-7 items-center px-2';
/** The Pinned and Chats headers stay in view, covering the chats scrolling past. */
const LIST_HEADER_CLASS = cn(SECTION_HEADER_CLASS, 'sticky top-0 z-10 bg-sidebar');

/** A notification dot: blue when something finished or is unread, yellow when a
 *  chat waits for the user. An SVG circle, not a rounded box: a box this small is
 *  snapped to whole pixels and comes out uneven at fractional positions. */
function StatusDot({
  tone,
  label,
  className,
}: {
  tone: 'done' | 'attention';
  label: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 8 8"
      role="img"
      aria-label={label}
      className={cn('size-[7px] shrink-0', tone === 'attention' ? 'fill-warning' : 'fill-primary', className)}
    >
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
}

/** The small solid triangle after a name whose contents fold away. */
function FoldCaret({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 8 8"
      aria-hidden
      className={cn('size-2 shrink-0 fill-current transition-transform', collapsed && '-rotate-90')}
    >
      <path d="M1 2.25h6L4 6.25z" />
    </svg>
  );
}

/** Splits a list of chats into top-level rows and the forks nested under each.
 *  Forks of forks sit flat under the chat they all started from, since the
 *  sidebar has no width for deeper indents. A fork whose source is not in this
 *  list (deleted, archived, pinned or filed elsewhere) is simply a row of its own. */
function nestForks(list: Session[]) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const rootOf = (session: Session) => {
    const seen = new Set([session.id]);
    let current = session;
    for (;;) {
      const parent = current.forked_from ? byId.get(current.forked_from) : undefined;
      if (!parent || seen.has(parent.id)) return current;
      seen.add(parent.id);
      current = parent;
    }
  };
  const roots: Session[] = [];
  const forks = new Map<string, Session[]>();
  for (const session of list) {
    const root = rootOf(session);
    if (root === session) roots.push(session);
    else forks.set(root.id, [...(forks.get(root.id) ?? []), session]);
  }
  return { roots, forks };
}

/** Width of the fade a clipped title ends in. */
const TITLE_FADE_PX = 20;

/** A title too long for its row ends in a short fade, then slowly pans only the
 *  hidden portion on hover. The animation stops at the end so the full title can
 *  be read without looping, and goes the fade's width further so the last letters
 *  end up clear of it. */
function ScrollableSessionTitle({ children, working }: { children: string; working?: boolean }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const [overflows, setOverflows] = useState(false);

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
    const hidden = Math.ceil(text.offsetWidth - viewport.clientWidth);
    if (hidden <= 1) return;
    const distance = hidden + TITLE_FADE_PX;
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

  // Fading only what is actually clipped: the row makes room for the three dots
  // on hover, so a title can start overflowing without having changed.
  useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const measure = () => setOverflows(text.offsetWidth > viewport.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={viewportRef}
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      style={
        overflows
          ? { maskImage: `linear-gradient(to right, black calc(100% - ${TITLE_FADE_PX}px), transparent)` }
          : undefined
      }
      onMouseEnter={start}
      onMouseLeave={stop}
    >
      <span ref={textRef} className={cn('inline-block', working && 'shimmer-text-muted')}>{children}</span>
    </span>
  );
}

/** A project as the chat menu offers it. */
type ProjectOption = { value: string; label: string };

function SessionRow({
  session,
  projects,
  sections,
  hasForks,
}: {
  session: Session;
  projects: ProjectOption[];
  sections: string[];
  /** Forks are nested under this row, so it gets the caret that folds them. */
  hasForks?: boolean;
}) {
  const { t } = useTranslation();
  const activeId = useChat((s) => s.sessionId);
  const status = useChat(selectChatStatus(session.id));
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const queryClient = useQueryClient();
  // 'rename' edits the chat name; 'project' and 'section' type a new one to move into.
  const [mode, setMode] = useState<'idle' | 'rename' | 'project' | 'section'>('idle');
  const [draft, setDraft] = useState('');
  const addSection = usePrefs((s) => s.addSection);
  const forksCollapsed = usePrefs((s) => s.collapsedForks.includes(session.id));
  const toggleForksCollapsed = usePrefs((s) => s.toggleForksCollapsed);
  const pinned = !!session.is_important;
  const isActive = session.id === activeId;
  const unread = !!session.unread || status === 'completed';
  const titlePending = isTitlePending(session);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const beginRename = () => { setDraft(session.name); setMode('rename'); };

  // Refresh either way: on failure the list snaps back to what the server
  // actually has, instead of showing a move that never happened.
  const refreshProjects = () => {
    void refresh();
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['projectChats'] });
    void queryClient.invalidateQueries({ queryKey: ['projectFiles'] });
  };
  const moveToProject = (project: string | null) =>
    void setSessionProject(session.id, project)
      .catch((err) => console.error('Talos: moving chat to project failed', err))
      .finally(refreshProjects);
  const moveToSection = (section: string | null) =>
    void setSessionSection(session.id, section)
      .catch((err) => console.error('Talos: moving chat to section failed', err))
      .finally(refresh);

  const markRead = () => {
    useChat.setState((s) => {
      if (!s.completed[session.id]) return s;
      const completed = { ...s.completed };
      delete completed[session.id];
      return { completed };
    });
    if (session.unread) {
      void setSessionUnread(session.id, false)
        .catch((err) => console.error('Talos: marking chat read failed', err))
        .finally(refresh);
    }
  };

  // Opening a chat is what reads it. Only on arrival, not whenever the flag is
  // set, or marking the chat on screen as unread would undo itself at once.
  useEffect(() => {
    if (isActive) markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  const fork = async () => {
    try {
      const forked = await forkSession(session.id);
      await refresh();
      // The new chat opens, so it has to be on screen as well.
      if (forksCollapsed) toggleForksCollapsed(session.id);
      void openSession(forked.id);
      if (!forked.files_forked) toast('sidebar.forkFilesMissing');
    } catch (err) {
      console.error('Talos: forking chat failed', err);
      toast('sidebar.forkFailed');
    }
  };

  const menuActions: SessionMenuActions = {
    togglePin: () => void markImportant(session.id, !pinned).then(refresh),
    toggleUnread: () => {
      if (unread) markRead();
      else void setSessionUnread(session.id, true).then(refresh);
    },
    rename: beginRename,
    fork: () => void fork(),
    moveToSection,
    newSection: () => { setDraft(''); setMode('section'); },
    moveToProject,
    newProject: () => { setDraft(''); setMode('project'); },
    archive: () => void archiveSession(session.id).then(refresh),
    remove: () => {
      void deleteSession(session.id).then(() => {
        if (isActive) newChat();
        refresh();
      });
    },
  };

  const hoverShortcuts = useHoverShortcuts(
    (key) => runSessionShortcut(key, menuActions, pinned),
    mode === 'idle',
  );

  const commit = async () => {
    const value = draft.trim();
    setMode('idle');
    if (mode === 'rename') {
      if (value && value !== session.name) { await renameSession(session.id, value); refresh(); }
    } else if (mode === 'project') {
      if (value) {
        try {
          const created = await createProject(value);
          await setSessionProject(session.id, created.id);
        } catch (err) { console.error('Talos: creating project failed', err); }
        refreshProjects();
      }
    } else if (mode === 'section') {
      if (value && value !== (session.section ?? '')) {
        try { await setSessionSection(session.id, value); addSection(value); }
        catch (err) { console.error('Talos: creating section failed', err); }
        refresh();
      }
    }
  };

  if (mode !== 'idle') {
    const placeholders = { rename: undefined, project: 'sidebar.projectPlaceholder', section: 'sidebar.sectionPlaceholder' };
    const placeholder = placeholders[mode];
    return (
      <input
        autoFocus
        value={draft}
        placeholder={placeholder && t(placeholder)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') setMode('idle');
        }}
        className="my-px h-[30px] w-full rounded-md border border-ring bg-transparent px-2 text-sm outline-none"
      />
    );
  }

  const openRow = {
    onClick: () => void openSession(session.id),
    onDoubleClick: beginRename,
  };
  // A running chat needs no dot, its title is moving. Otherwise yellow when it
  // waits for the user, blue when it finished in the background or is unread.
  const showDot = status === 'awaiting' || status === 'completed' || (!!session.unread && !status);
  // The room for the three dots is kept free for good where something must not
  // move when they appear: the fork caret stays put, and the dot sits in their
  // spot. Other rows only make room on hover, which gives titles more width.
  const keepDotsRoom = !!hasForks || showDot;

  return (
    <ContextMenu>
      {/* The highlight lives on a wrapper: title, fold caret, the rest of the row
          and the three dots are buttons side by side, since a button cannot hold
          another. A right-click marks the wrapper itself, the dots' menu marks its
          trigger inside. On hover the wrapper makes room for the dots. */}
      <ContextMenuTrigger asChild>
        <div
          {...hoverShortcuts}
          className={cn(
            'group relative my-px flex h-[30px] items-center rounded-md text-sm transition-colors',
            keepDotsRoom
              ? 'pe-7'
              : 'hover:pe-7 data-[state=open]:pe-7 has-[[data-state=open]]:pe-7 has-[:focus-visible]:pe-7 [@media(hover:none)]:pe-7',
            isActive
              ? 'bg-sidebar-active'
              : 'hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent has-[[data-state=open]]:bg-sidebar-accent',
          )}
        >
          <button
            type="button"
            {...openRow}
            className={cn(
              'flex h-full min-w-0 items-center gap-2 rounded-md ps-2 text-left',
              titlePending && 'flex-1',
            )}
          >
            {pinned && <PinIcon className="size-3 shrink-0 -rotate-45 text-muted-foreground" />}
            {/* Until the model has written a title, the row shows a skeleton
                instead of the placeholder ("Chat: <first words>") the backend
                parks on the session — a title that changes under the user reads
                worse than one that is visibly still loading. */}
            {titlePending ? (
              <div className="min-w-0 flex-1">
                <Skeleton
                  className="my-[3px] h-3.5"
                  text={placeholderTitleText(session.name)}
                  label={t('sidebar.titlePending')}
                />
              </div>
            ) : (
              <ScrollableSessionTitle working={status === 'working'}>
                {session.name || t('common.untitled')}
              </ScrollableSessionTitle>
            )}
            {status === 'working' && <span className="sr-only">{t('sidebar.running')}</span>}
          </button>
          {hasForks && (
            <button
              type="button"
              aria-expanded={!forksCollapsed}
              aria-label={t(forksCollapsed ? 'sidebar.showForks' : 'sidebar.hideForks')}
              onClick={() => toggleForksCollapsed(session.id)}
              className="flex h-full w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            >
              <FoldCaret collapsed={forksCollapsed} />
            </button>
          )}
          {/* The rest of the row opens the chat as well; a mouse target only, the
              title's button is the one in the tab order. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            {...openRow}
            className={cn(
              'flex h-full min-w-fit flex-1 items-center justify-end rounded-md text-left',
              !keepDotsRoom && 'pe-2 group-hover:min-w-0 group-hover:pe-0 group-has-[[data-state=open]]:min-w-0 group-has-[[data-state=open]]:pe-0',
            )}
          />
          {showDot && (
            <StatusDot
              tone={status === 'awaiting' ? 'attention' : 'done'}
              label={t(
                status === 'awaiting'
                  ? 'sidebar.awaiting'
                  : status === 'completed'
                    ? 'sidebar.completed'
                    : 'sidebar.unread',
              )}
              className="pointer-events-none absolute inset-y-0 right-[13px] my-auto group-hover:hidden group-has-[[data-state=open]]:hidden"
            />
          )}
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t('sidebar.chatOptions')}
                className="absolute inset-y-0 right-1 my-auto flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-data-[state=open]:opacity-100 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <EllipsisIcon className="size-4" />
              </button>
            </MenuTrigger>
            <SessionMenuPopup
              kind="dropdown"
              align="start"
              session={session}
              unread={unread}
              projects={projects}
              sections={sections}
              actions={menuActions}
            />
          </Menu>
        </div>
      </ContextMenuTrigger>
      <SessionMenuPopup
        kind="context"
        session={session}
        unread={unread}
        projects={projects}
        sections={sections}
        actions={menuActions}
      />
    </ContextMenu>
  );
}

/** Chats with their forks nested underneath, joined by a thin rounded line.
 *  `limit` caps the top-level rows; forks come along with their chat. */
function ChatRows({
  list,
  projects,
  sections,
  limit,
}: {
  list: Session[];
  projects: ProjectOption[];
  sections: string[];
  limit?: number;
}) {
  const collapsedForks = usePrefs((s) => s.collapsedForks);
  const showForks = usePrefs((s) => s.showForks);
  const { roots, forks } = nestForks(list);
  return (
    <>
      {roots.slice(0, limit).map((root) => {
        const nested = showForks ? forks.get(root.id) ?? [] : [];
        return (
          <div key={root.id}>
            <SessionRow session={root} projects={projects} sections={sections} hasForks={nested.length > 0} />
            {!collapsedForks.includes(root.id) && nested.map((fork, index) => (
              <div key={fork.id} className="relative ps-5">
                {index < nested.length - 1 && (
                  <span aria-hidden className="absolute inset-y-0 left-2 border-l border-muted-foreground/40" />
                )}
                <span
                  aria-hidden
                  className="absolute -top-px left-2 h-[17px] w-[11px] rounded-bl-[6px] border-b border-l border-muted-foreground/40"
                />
                <SessionRow session={fork} projects={projects} sections={sections} />
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** A section's own block header: name and fold caret, its sort order, and a plus
 *  for a new chat inside it. Renamed or removed from its context menu. Like a project it has no row of its own on the
 *  server — it is a label on its chats plus an entry in prefs, so both operations
 *  are a batch update of its members. */
function SectionHeader({
  name,
  members,
  sortMode,
  listMenu,
}: {
  name: string;
  members: Session[];
  sortMode: SortMode;
  listMenu: Omit<React.ComponentProps<typeof ListOptionsMenu>, 'sortMode' | 'onSortChange' | 'className'>;
}) {
  const { t } = useTranslation();
  const collapsed = usePrefs((s) => s.collapsedSections.includes(name));
  const toggle = usePrefs((s) => s.toggleSectionCollapsed);
  const setSectionSort = usePrefs((s) => s.setSectionSort);
  const newChatIn = useChat((s) => s.newChatIn);
  const openProject = useUi((s) => s.openProject);
  const setView = useUi((s) => s.setView);
  const renameSectionPref = usePrefs((s) => s.renameSectionPref);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);

  const setSection = async (target: string | null) => {
    try {
      await Promise.all(members.map((s) => setSessionSection(s.id, target)));
      renameSectionPref(name, target);
    } catch (err) {
      console.error('Talos: updating section failed', err);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  };

  const commitRename = async () => {
    const value = draft.trim();
    setRenaming(false);
    if (value && value !== name) await setSection(value);
  };

  if (renaming) {
    return (
      <input
        autoFocus
        value={draft}
        placeholder={t('sidebar.sectionPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commitRename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitRename();
          if (e.key === 'Escape') { setDraft(name); setRenaming(false); }
        }}
        className="h-7 w-full rounded-md border border-ring bg-transparent px-2 text-xs font-medium outline-none"
      />
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={SECTION_HEADER_CLASS}>
          <button
            type="button"
            onClick={() => toggle(name)}
            aria-expanded={!collapsed}
            className="flex h-full min-w-0 items-center gap-1.5 text-left text-xs font-medium"
          >
            <span className="min-w-0 truncate">{name}</span>
            <FoldCaret collapsed={collapsed} />
          </button>
          {collapsed && members.length > 0 && (
            <span className="ms-1.5 shrink-0 text-[11px] tabular-nums text-muted-foreground">{members.length}</span>
          )}
          <div className="ms-auto -me-1.5 flex shrink-0 items-center">
            <ListOptionsMenu
              {...listMenu}
              sortMode={sortMode}
              onSortChange={(mode) => setSectionSort(name, mode)}
              className="text-foreground/80"
            />
            <Tooltip label={t('sidebar.newChat')}>
              <button
                type="button"
                aria-label={t('sidebar.newChat')}
                onClick={() => { newChatIn({ section: name, projectId: openProject }); setView('chat'); }}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-foreground"
              >
                <PlusIcon className="size-4" />
              </button>
            </Tooltip>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={() => { setDraft(name); setRenaming(true); }}>
          <PencilIcon /> {t('sidebar.renameSection')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Deletes the section only — its chats move back to the flat list. */}
        <ContextMenuItem onSelect={() => void setSection(null)}>
          <FolderMinusIcon /> {t('sidebar.deleteSection')}
          <span className="ms-auto ps-2 text-[11px] text-muted-foreground">{t('sidebar.deleteSectionHint')}</span>
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** One row in the Projects section. Selecting it opens the project's page and
 *  narrows the chat list below to the user's chats in it. Its creator can rename or
 *  delete it from the context menu. */
function ProjectRow({
  project,
  members,
  active,
  onSelect,
}: {
  project: ProjectSummary;
  /** The user's chats in this project, pinned ones included. */
  members: Session[];
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const status = useChat(selectFolderStatus(members.map((s) => s.id)));
  const name = project.name;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
  const beginRename = () => {
    if (!project.is_creator) return;
    setDraft(name);
    setRenaming(true);
  };
  const commitRename = async () => {
    const value = draft.trim();
    setRenaming(false);
    if (!value || value === name) return;
    try { await updateProject(project.id, { name: value }); }
    catch (err) { console.error('Talos: renaming project failed', err); }
    refresh();
  };
  const remove = async () => {
    if (!window.confirm(t('projects.deleteConfirm', { name }))) return;
    try {
      await deleteProject(project.id);
      if (useUi.getState().openProject === project.id) useUi.getState().setOpenProject(null);
    } catch (err) { console.error('Talos: deleting project failed', err); }
    refresh();
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

  const row = (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={beginRename}
      className={cn(
        'group my-px flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors',
        active ? 'bg-sidebar-active' : 'hover:bg-sidebar-accent',
      )}
    >
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className={cn('min-w-0 flex-1 truncate', status === 'working' && 'shimmer-text-muted')}
        title={status === 'working' ? t('sidebar.projectWorking') : undefined}
      >
        {name}
      </span>
      {(status === 'awaiting' || status === 'completed') && (
        <StatusDot
          tone={status === 'awaiting' ? 'attention' : 'done'}
          label={t(status === 'awaiting' ? 'sidebar.projectAwaiting' : 'sidebar.projectCompleted')}
        />
      )}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{project.chat_count}</span>
    </button>
  );
  if (!project.is_creator) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={beginRename}>
          <PencilIcon /> {t('sidebar.renameProject')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => void remove()}>
          <FolderMinusIcon /> {t('sidebar.deleteProject')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** Primary nav row (New / Projects / Artifacts / Customize). */
/* Every row in the sidebar carries `my-px` and a matching notch off its own
 * padding: the pitch of the list is unchanged, but two highlighted rows next to
 * each other (the hovered one and the selected one) are separated by a hairline
 * instead of merging into one block. */
function NavRow({
  icon,
  label,
  onClick,
  emphasis,
  active,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  /** Keybinding revealed at the row's right edge on hover. */
  shortcut?: string;
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
        'group/nav my-px flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0',
        emphasis || active ? 'bg-sidebar-active' : 'hover:bg-sidebar-accent',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {shortcut && (
        <span className="opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
          <KeybindingPill value={shortcut} />
        </span>
      )}
    </button>
  );
}

/** The sidebar's search field. Not a real input: a click (or the search
 *  shortcut, shown on hover) opens the command palette, which does the search. */
function SearchBar({ onOpen, shortcut }: { onOpen: () => void; shortcut?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/nav mb-1.5 flex h-[30px] w-full items-center gap-2.5 rounded-lg border border-input px-[calc(0.5rem-1px)] text-sm shadow-xs/5 outline-none transition-colors hover:bg-sidebar-accent focus-visible:border-ring dark:bg-input/20"
    >
      {/* Same slot as a NavRow's icon, and the padding above nets out the border,
          so icon and label line up with the rows below. */}
      <span className="flex size-5 shrink-0 items-center justify-center">
        <SearchIcon className="size-[18px] opacity-80" />
      </span>
      {/* DM Sans sits high in its line box: with the line centered, its capitals
          have 2 px more room below than above, which one pixel down evens out. */}
      <span className="relative top-px min-w-0 flex-1 truncate text-left">{t('sidebar.search')}</span>
      {shortcut && (
        <span className="opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
          <KeybindingPill value={shortcut} />
        </span>
      )}
    </button>
  );
}

/** The account dropdown anchored to the footer avatar. Headed by who is signed
 *  in (the username is the account's mail address), then three bands: what is
 *  yours to set (settings, usage, language, design, shortcuts), where to turn
 *  (help, report a problem, archive), and for admins the pages that run the
 *  deployment. Log out stands alone at the foot. */
function AccountMenu({
  trigger,
  authEnabled,
  username,
  displayName,
  isAdmin,
  actions,
  onReport,
}: {
  trigger: React.ReactNode;
  authEnabled: boolean;
  username: string;
  displayName?: string | null;
  isAdmin: boolean;
  actions: AccountActions;
  onReport: () => void;
}) {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const tick = (on: boolean) => (
    <CheckIcon className={cn('ms-auto size-3.5 text-primary', on ? 'opacity-100' : 'opacity-0')} />
  );
  const themes: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
    { value: 'system', label: t('settings.appearance.system'), icon: <MonitorIcon /> },
    { value: 'light', label: t('settings.appearance.light'), icon: <SunIcon /> },
    { value: 'dark', label: t('settings.appearance.dark'), icon: <MoonIcon /> },
  ];
  return (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuPopup side="top" align="start" sideOffset={6} className="w-52">
        <div className="px-2 pt-1 pb-1.5">
          <div className="truncate text-xs font-semibold text-muted-foreground" title={username}>{username}</div>
          {displayName && displayName !== username && (
            <div className="truncate text-[11px] leading-tight text-muted-foreground/80">
              {displayName}
              {isAdmin && ` · ${t('settings.account.administrator')}`}
            </div>
          )}
        </div>
        <MenuItem onSelect={actions.onOpenSettings}>
          <SettingsIcon /> {t('sidebar.menu.settings')}
        </MenuItem>
        <MenuItem onSelect={() => requestSettingsPanel('usage', 'all')}>
          <GaugeIcon /> {t('settings.nav.usage')}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>
            <GlobeIcon /> {t('settings.appearance.language')}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-40">
            {LANGUAGES.map((l) => (
              <MenuItem key={l.value} onSelect={() => { setLang(l.value); applyLang(l.value); }}>
                {l.label}
                {tick(lang === l.value)}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            <SunMoonIcon /> {t('settings.appearance.theme')}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-40">
            {themes.map((th) => (
              <MenuItem key={th.value} onSelect={() => { setTheme(th.value); applyTheme(th.value); }}>
                {th.icon} {th.label}
                {tick(theme === th.value)}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuItem onSelect={() => requestSettingsPanel('shortcuts', 'all')}>
          <KeyboardIcon /> {t('settings.nav.shortcuts')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={actions.onOpenHelp}>
          <HelpCircleIcon /> {t('sidebar.menu.help')}
        </MenuItem>
        <MenuItem onSelect={onReport}>
          <BugIcon /> {t('tickets.report')}
        </MenuItem>
        <MenuItem onSelect={actions.onOpenArchive}>
          <ArchiveIcon /> {t('sidebar.menu.archive')}
        </MenuItem>
        {isAdmin && (
          <>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>
                <ShieldIcon /> {t('sidebar.menu.administration')}
              </MenuSubTrigger>
              <MenuSubPopup className="min-w-48">
                <MenuItem onSelect={() => requestSettingsPanel('models', 'admin')}>
                  <SlidersHorizontalIcon /> {t('sidebar.menu.adminPanel')}
                </MenuItem>
                <MenuItem onSelect={() => setView('users')}>
                  <UsersIcon /> {t('users.title')}
                </MenuItem>
                <MenuItem onSelect={() => setView('rag')}>
                  <DatabaseIcon /> {t('sidebar.menu.rag')}
                </MenuItem>
                <MenuItem onSelect={() => setView('memories')}>
                  <BrainIcon /> {t('memories.title')}
                </MenuItem>
                <MenuItem onSelect={() => setView('tickets')}>
                  <TicketIcon /> {t('sidebar.menu.tickets')}
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          </>
        )}
        <MenuSeparator />
        {/* Always there, so it is found where one looks for it; without
            sign-in there is nothing to sign out of, and the row says so. */}
        <MenuItem
          disabled={!authEnabled}
          title={authEnabled ? undefined : t('settings.account.authDisabled')}
          onSelect={() => void logout()}
        >
          <LogOutIcon /> {t('sidebar.menu.logOut')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

interface AccountActions {
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenArchive: () => void;
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
function SidebarBody({ onOpenPalette, account, onOpenTicketDialog, preview, onCollapse }: SidebarProps & { preview?: boolean; onCollapse?: () => void }) {
  const { t } = useTranslation();
  // While a chat is still waiting for its generated title, poll fast so the
  // skeleton is replaced the moment the backend's naming task finishes;
  // otherwise the list only needs the lazy 30s refresh.
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: (query) => (anyTitlePending(query.state.data) ? 2_000 : 30_000),
  });
  const queryClient = useQueryClient();
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
  const { data: projects } = useProjects();
  useMoveStoredProjects();
  const storedSections = usePrefs((s) => s.sections);
  const collapsedSections = usePrefs((s) => s.collapsedSections);
  const sectionSort = usePrefs((s) => s.sectionSort);
  const collapsedForks = usePrefs((s) => s.collapsedForks);
  const listGroup = usePrefs((s) => s.listGroup);
  const showForks = usePrefs((s) => s.showForks);
  const showEmptySections = usePrefs((s) => s.showEmptySections);
  const unreadOnly = usePrefs((s) => s.unreadOnly);
  const setListOptions = usePrefs((s) => s.setListOptions);
  const addSection = usePrefs((s) => s.addSection);
  const revealAllChats = usePrefs((s) => s.revealAllChats);
  // Chats with a dot on them. Read as narrowly as this because the sidebar must
  // not re-render on every streamed token of a running chat.
  const completed = useChat((s) => s.completed);
  const awaitingIds = useChat((s) =>
    Object.entries(s.runtimes).filter(([, rt]) => rt.awaitingInput).map(([id]) => id).join(' '),
  );
  const togglePref = usePrefs((s) => s.toggleSidebar);
  // As a drawer the collapse button closes the drawer; the preference is for
  // windows wide enough to have the choice.
  const toggleSidebar = onCollapse ?? togglePref;
  const keybinds = useKeybinds();

  const sorter = compareSessions(sortMode);

  const active = (sessions ?? []).filter((s) => !s.archived);
  const sortedProjects = (projects ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const projectOptions = sortedProjects.map((p) => ({ value: p.id, label: p.name }));
  const openProjectName = sortedProjects.find((p) => p.id === openProject)?.name ?? '';
  // An open project narrows the list to its chats; otherwise the list is the
  // loose chats, with pinned ones floated into their own section on top.
  const awaiting = awaitingIds.split(' ');
  const shown = unreadOnly
    ? active.filter((s) => s.unread || completed[s.id] || awaiting.includes(s.id))
    : active;
  const inProject = openProject !== null ? shown.filter((s) => s.project_id === openProject) : [];
  const loose = shown.filter((s) => !s.project_id);
  const pinned = openProject === null ? loose.filter((s) => s.is_important).sort(sorter) : [];
  const listed = openProject === null ? loose.filter((s) => !s.is_important).sort(sorter) : inProject.slice().sort(sorter);
  // Sections are the union of the labels chats carry and the ones created here
  // but still empty. Every one is offered in the
  // menu; the list itself shows empty ones outside a project only, where they
  // were created, rather than repeating them inside every project. An unread
  // filter leaves out the empty ones too: it is a list of what needs reading.
  const sectionNames = [
    ...new Set([
      ...active.map((s) => s.section).filter((n): n is string => !!n),
      ...storedSections,
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const grouped = listGroup === 'section';
  const listedSections = grouped
    ? sectionNames.filter(
        (name) =>
          listed.some((s) => s.section === name)
          || (openProject === null && showEmptySections && !unreadOnly),
      )
    : [];
  const rows = grouped ? listed.filter((s) => !s.section) : listed;
  const [creatingSection, setCreatingSection] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CHAT_PAGE);
  // A different list (project / sort order) starts collapsed again.
  useEffect(() => setVisibleCount(CHAT_PAGE), [openProject, sortMode]);
  const hiddenCount = Math.max(0, nestForks(rows).roots.length - visibleCount);
  // Every chat with a blue dot, whatever the list is narrowed to: marked unread,
  // or finished in the background and not looked at yet. A chat waiting on an
  // answer (yellow dot) is not unread; its question is still open afterwards.
  const unreadIds = active.filter((s) => s.unread || completed[s.id]).map((s) => s.id);
  const markAllRead = () => {
    const count = unreadIds.length;
    if (count === 0) return;
    const flagged = active.filter((s) => s.unread).map((s) => s.id);
    useChat.setState((s) => {
      const left = { ...s.completed };
      for (const id of unreadIds) delete left[id];
      return { completed: left };
    });
    // The dots go at once; the refetch below puts back any the server refused.
    queryClient.setQueryData<typeof sessions>(['sessions'], (list) =>
      list?.map((s) => (s.unread && !s.archived ? { ...s, unread: false } : s)),
    );
    void Promise.allSettled(flagged.map((id) => setSessionUnread(id, false))).then((results) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (results.some((r) => r.status === 'rejected')) {
        console.error('Talos: marking all chats read failed', results);
        toastError('toasts.allReadFailed');
      } else {
        toast('toasts.allRead', { count });
      }
    });
  };
  const listMenu = {
    onMarkAllRead: markAllRead,
    unreadCount: unreadIds.length,
    onNewSection: () => setCreatingSection(true),
    onViewAll: () => {
      revealAllChats();
      setVisibleCount(Infinity);
    },
    canViewAll:
      hiddenCount > 0 || collapsedSections.length > 0 || collapsedForks.length > 0 || !showForks || unreadOnly,
  };
  const commitNewSection = (name: string) => {
    setCreatingSection(false);
    if (!name) return;
    addSection(name);
    // A section just created has to be on screen, whatever the list was set to.
    setListOptions({ listGroup: 'section', showEmptySections: true });
  };
  const accountLabel = auth?.display_name || auth?.username;
  const initial = (accountLabel ?? 'U').slice(0, 1).toUpperCase();

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-strong">
      {/* Header — the wordmark, at the same height as the rail's expand button
          so nothing below shifts when the sidebar collapses. */}
      <div className="flex h-12 shrink-0 items-center px-3">
        {!preview && (brand.logoLarge ? (
          <BrandImage src={brand.logoLarge} alt={brand.name} align="left" className="h-7 w-full text-foreground" />
        ) : (
          <span className="truncate text-xl font-semibold tracking-tight text-primary">{brand.name}</span>
        ))}
      </div>

      {/* Primary nav — each row below "New" opens its full-page view, and shows
          as selected while that view is the one on screen. */}
      <div className="px-2">
        <SearchBar onOpen={onOpenPalette} shortcut={keybinds.search} />
        <NavRow
          emphasis
          icon={<PlusIcon />}
          label={t('sidebar.new')}
          shortcut={keybinds.new_session}
          onClick={() => { newChat(); setView('chat'); }}
        />
        <NavRow
          icon={<ArchiveIcon />}
          label={t('sidebar.projects')}
          active={view === 'projects' && openProject === null}
          onClick={() => { setOpenProject(null); setView('projects'); }}
        />
        <NavRow
          icon={<ShapesIcon />}
          label={t('sidebar.artifacts')}
          active={view === 'artifacts'}
          onClick={() => setView('artifacts')}
        />
        <NavRow
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
          {sortedProjects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              members={active.filter((s) => s.project_id === project.id)}
              active={project.id === openProject}
              onSelect={() => {
                setOpenProject(project.id);
                setView('projects');
              }}
            />
          ))}
          {sortedProjects.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground/80">
              <PinIcon className="size-3.5 shrink-0 -rotate-45" />
              <span className="min-w-0 truncate">{t('sidebar.noProjects')}</span>
            </div>
          )}
        </div>
      </div>

      {/* The scrolling remainder, one block after the other: pinned chats, each
          section, then the chats in none. Inside an open project a way back out
          takes the top. No bottom padding: the footer divider sits flush against
          the last chat row, and the footer supplies the space below it instead.
          `isolate` keeps the sticky headers' z-index in here: outside, they would
          rise above the film grain on body::after and show as a differently
          colored band. */}
      <div className="isolate mt-3 min-h-0 flex-1 overflow-y-auto px-2">
        {creatingSection && (
          <input
            autoFocus
            placeholder={t('sidebar.sectionPlaceholder')}
            onBlur={(e) => commitNewSection(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNewSection(e.currentTarget.value.trim());
              if (e.key === 'Escape') setCreatingSection(false);
            }}
            className="mb-3 h-7 w-full rounded-md border border-ring bg-transparent px-2 text-xs font-medium outline-none"
          />
        )}
        {pinned.length > 0 && (
          <div className="mb-3">
            <div className={LIST_HEADER_CLASS}>
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <PinIcon className="size-3 -rotate-45" />
                {t('sidebar.pinned')}
              </span>
            </div>
            <ChatRows list={pinned} projects={projectOptions} sections={sectionNames} />
          </div>
        )}
        {listedSections.map((name) => {
          const mode = sectionSort[name] ?? sortMode;
          const members = listed.filter((s) => s.section === name).sort(compareSessions(mode));
          return (
            <div key={name} className="mb-3">
              <SectionHeader name={name} members={members} sortMode={mode} listMenu={listMenu} />
              {!collapsedSections.includes(name) && (
                <ChatRows list={members} projects={projectOptions} sections={sectionNames} />
              )}
            </div>
          );
        })}
        <div>
          {openProject !== null ? (
            <div className={cn(LIST_HEADER_CLASS, 'justify-between')}>
              <button
                type="button"
                onClick={() => setOpenProject(null)}
                className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeftIcon className="size-3 shrink-0" />
                <span className="truncate">{openProjectName}</span>
              </button>
              <ListOptionsMenu {...listMenu} sortMode={sortMode} onSortChange={setSortMode} className="-mr-1.5" />
            </div>
          ) : (rows.length > 0 || listedSections.length === 0) && (
            // Without a section on screen this is the only way to the filter
            // menu, so it stays even when a filter has emptied the list below.
            <div className={cn(LIST_HEADER_CLASS, 'justify-between')}>
              <span className="text-xs font-medium text-muted-foreground">{t('sidebar.chats')}</span>
              <ListOptionsMenu {...listMenu} sortMode={sortMode} onSortChange={setSortMode} className="-mr-1.5" />
            </div>
          )}
          <ChatRows list={rows} projects={projectOptions} sections={sectionNames} limit={visibleCount} />
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount((n) => n + CHAT_PAGE)}
              className="my-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <ChevronDownIcon className="size-3.5" />
              {t('sidebar.showMoreChats', { count: Math.min(hiddenCount, CHAT_PAGE) })}
            </button>
          )}
          {listed.length === 0 && listedSections.length === 0 && pinned.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-xs text-muted-foreground">
              <MessageSquareIcon className="size-4 opacity-60" />
              {t(unreadOnly ? 'sidebar.noUnreadChats' : 'sidebar.noChats')}
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
              authEnabled={auth?.auth_enabled !== false}
              username={auth?.username ?? t('sidebar.user')}
              displayName={auth?.display_name}
              isAdmin={!!auth?.is_admin || auth?.auth_enabled === false}
              actions={account}
              onReport={onOpenTicketDialog}
              trigger={
                <button
                  type="button"
                  aria-label={t('sidebar.account')}
                  // Sized to its own label (capped so a long name can't crowd
                  // the icons out), not stretched across the row.
                  className="flex min-w-0 max-w-[calc(100%-4rem)] items-center gap-1.5 rounded-full py-1 pr-2 pl-1 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                    {initial}
                  </span>
                  <span className="min-w-0 truncate text-[13px]">{accountLabel ?? t('sidebar.user')}</span>
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
          <Tooltip label={<span className="flex items-center gap-1.5">{t('sidebar.collapseSidebar')}<KeybindingPill value={keybinds.toggle_sidebar} /></span>}>
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
  const prefCollapsed = usePrefs((s) => s.sidebarCollapsed);
  const togglePref = usePrefs((s) => s.toggleSidebar);
  // A window too narrow to give the sidebar a column of its own: there it is
  // collapsed to begin with, whatever the preference says, so the content
  // keeps the width. It works like the collapsed sidebar always does — hover
  // previews it, a click opens it and it stays open — only that opening it
  // here is for this visit and leaves the preference for wide windows alone.
  const narrow = useNarrowWindow();
  const narrowOpen = useUi((s) => s.sidebarNarrowOpen);
  const setNarrowOpen = useUi((s) => s.setSidebarNarrowOpen);
  useEffect(() => { if (!narrow) setNarrowOpen(false); }, [narrow, setNarrowOpen]);
  const collapsed = narrow ? !narrowOpen : prefCollapsed;
  const toggleSidebar = useCallback(() => {
    if (narrow) setNarrowOpen(!useUi.getState().sidebarNarrowOpen);
    else togglePref();
  }, [narrow, setNarrowOpen, togglePref]);
  const [peek, setPeek] = useState(false);
  const keybinds = useKeybinds();
  const newChat = useChat((s) => s.newChat);
  const setView = useUi((s) => s.setView);
  const { onOpenPalette } = props;

  // The sidebar's actions by keyboard, with the bindings from Settings →
  // Shortcuts — the same ones the search field, "New" row and collapse
  // tooltip show. Mounted while collapsed too, so they always work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesBinding(e, keybinds.toggle_sidebar)) {
        e.preventDefault();
        toggleSidebar();
      } else if (matchesBinding(e, keybinds.search)) {
        e.preventDefault();
        onOpenPalette();
      } else if (matchesBinding(e, keybinds.new_session)) {
        e.preventDefault();
        newChat();
        setView('chat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keybinds.toggle_sidebar, keybinds.search, keybinds.new_session, toggleSidebar, onOpenPalette, newChat, setView]);

  useEffect(() => { if (!collapsed) setPeek(false); }, [collapsed]);

  if (!collapsed) {
    return (
      <nav className="w-64 shrink-0 border-r border-border" aria-label={t('sidebar.navLabel')}>
        <SidebarBody {...props} onCollapse={toggleSidebar} />
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
        {/* Hovering this button opens the peek preview, which fills the whole
            left column — so the tooltip's 400ms delay lands it on top of the
            preview it just triggered. Suppressed while previewing: the preview
            says more than the label does, and the ⌘B hint still lives on the
            collapse button inside it. */}
        <Tooltip
          open={peek ? false : undefined}
          label={<span className="flex items-center gap-1.5">{t('sidebar.expandSidebar')}<KeybindingPill value={keybinds.toggle_sidebar} /></span>}
          side="right"
        >
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
