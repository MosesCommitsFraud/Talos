import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderIcon, FolderMinusIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSessions, setSessionFolder } from '@/api/client';
import type { Session } from '@/api/types';
import { usePrefs, type Project } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { formatRelativeTime, timestampMs } from '@/lib/utils';
import { Button } from '../ui/button';
import { SearchInput } from '../ui/search';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from '../ui/menu';
import { CardGrid, EmptyState, Page } from './parts';

type SortKey = 'updated' | 'name';

/** One project card: name, what it's for, and when it last saw activity.
 *  Clicking it opens the project — the sidebar's chat list narrows to its
 *  chats, which is where the project's contents actually live. */
function ProjectCard({
  project,
  chats,
  onOpen,
}: {
  project: Project;
  chats: Session[];
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const renameProjectPref = usePrefs((s) => s.renameProjectPref);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);

  // A project is a label on its chats, so renaming or deleting one is a batch
  // update of every member (plus the prefs entry that carries its description).
  const setFolder = async (target: string | null) => {
    try {
      await Promise.all(chats.map((s) => setSessionFolder(s.id, target)));
      renameProjectPref(project.name, target);
    } catch (err) {
      console.error('Talos: updating project failed', err);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  };

  const commitRename = async () => {
    const value = draft.trim();
    setRenaming(false);
    if (value && value !== project.name) await setFolder(value);
  };

  const lastActive = chats.length
    ? Math.max(...chats.map((s) => timestampMs(s.last_message_at ?? s.updated_at)))
    : project.createdAt
      ? timestampMs(project.createdAt)
      : 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          onDoubleClick={() => { setDraft(project.name); setRenaming(true); }}
          className="flex h-40 w-full flex-col rounded-xl border bg-card p-4 text-left transition-colors hover:border-ring/40 hover:bg-sidebar-accent"
        >
          {renaming ? (
            <input
              autoFocus
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') { setDraft(project.name); setRenaming(false); }
              }}
              className="w-full rounded-lg border border-ring bg-transparent px-2 py-1 text-sm outline-none"
            />
          ) : (
            <span className="truncate text-[15px] font-semibold text-strong">{project.name}</span>
          )}
          {project.description && (
            <span className="mt-2 line-clamp-3 text-[13px] text-muted-foreground">
              {project.description}
            </span>
          )}
          <span className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
            <span>{t('projects.chatCount', { count: chats.length })}</span>
            {lastActive > 0 && (
              <>
                <span>·</span>
                <span>{formatRelativeTime(lastActive)}</span>
              </>
            )}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={() => { setDraft(project.name); setRenaming(true); }}>
          <PencilIcon /> {t('sidebar.renameProject')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => void setFolder(null)}>
          <FolderMinusIcon /> {t('sidebar.deleteProject')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** The /projects page: every project as a card. Projects live half on the
 *  server (the folder label its chats carry) and half in prefs (description,
 *  and the entry that keeps an empty project alive), so the list is the union
 *  of both. */
export function ProjectsWorkspace() {
  const { t } = useTranslation();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions });
  const storedProjects = usePrefs((s) => s.projects);
  const setOpenProject = useUi((s) => s.setOpenProject);
  const setView = useUi((s) => s.setView);
  const setCreateOpen = useUi((s) => s.setCreateProjectOpen);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');

  const active = (sessions ?? []).filter((s) => !s.archived);
  const chatsOf = (name: string) => active.filter((s) => s.folder === name);
  // Folders the server knows about but prefs doesn't (created on another
  // device, or before projects had descriptions) still belong on the page.
  const known = new Set(storedProjects.map((p) => p.name));
  const projects: Project[] = [
    ...storedProjects,
    ...[...new Set(active.map((s) => s.folder).filter((f): f is string => !!f))]
      .filter((name) => !known.has(name))
      .map((name) => ({ name })),
  ];

  const lastActive = (p: Project) => {
    const chats = chatsOf(p.name);
    if (chats.length) {
      return Math.max(...chats.map((s) => timestampMs(s.last_message_at ?? s.updated_at)));
    }
    return p.createdAt ? timestampMs(p.createdAt) : 0;
  };

  const needle = query.trim().toLowerCase();
  const visible = projects
    .filter((p) =>
      !needle ||
      p.name.toLowerCase().includes(needle) ||
      (p.description ?? '').toLowerCase().includes(needle),
    )
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : lastActive(b) - lastActive(a),
    );

  const open = (name: string) => {
    setOpenProject(name);
    setView('chat');
  };

  return (
    <Page
      title={t('sidebar.projects')}
      actions={
        <>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('projects.searchPlaceholder')}
            wrapperClassName="w-56"
          />
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost-muted">
                {t(sort === 'name' ? 'projects.sortName' : 'projects.sortUpdated')}
              </Button>
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onSelect={() => setSort('updated')}>{t('projects.sortUpdated')}</MenuItem>
              <MenuItem onSelect={() => setSort('name')}>{t('projects.sortName')}</MenuItem>
            </MenuPopup>
          </Menu>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon /> {t('projects.new')}
          </Button>
        </>
      }
    >
      {visible.length === 0 ? (
        <EmptyState
          icon={<FolderIcon />}
          title={t(needle ? 'projects.noMatches' : 'projects.emptyTitle')}
          hint={needle ? undefined : t('projects.emptyHint')}
          action={
            needle ? undefined : (
              <Button onClick={() => setCreateOpen(true)}>
                <PlusIcon /> {t('projects.new')}
              </Button>
            )
          }
        />
      ) : (
        <CardGrid>
          {visible.map((p) => (
            <ProjectCard
              key={p.name}
              project={p}
              chats={chatsOf(p.name)}
              onOpen={() => open(p.name)}
            />
          ))}
        </CardGrid>
      )}
    </Page>
  );
}
