import { useQueryClient } from '@tanstack/react-query';
import { FolderIcon, PencilIcon, PlusIcon, Trash2Icon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteProject, updateProject, type ProjectSummary } from '@/api/client';
import { useProjects } from '@/lib/useProjects';
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

/** One project card: name, what it's for, who and how much is in it. Clicking it
 *  opens the project's page. */
function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
  const beginRename = () => {
    if (!project.is_creator) return;
    setDraft(project.name);
    setRenaming(true);
  };
  const commitRename = async () => {
    const value = draft.trim();
    setRenaming(false);
    if (!value || value === project.name) return;
    try {
      await updateProject(project.id, { name: value });
    } catch (err) {
      console.error('Talos: renaming project failed', err);
    }
    refresh();
  };
  const remove = async () => {
    if (!window.confirm(t('projects.deleteConfirm', { name: project.name }))) return;
    try {
      await deleteProject(project.id);
    } catch (err) {
      console.error('Talos: deleting project failed', err);
    }
    refresh();
  };

  const card = (
    <button
      type="button"
      onClick={onOpen}
      onDoubleClick={beginRename}
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
        <span className="mt-2 line-clamp-3 text-[13px] text-muted-foreground">{project.description}</span>
      )}
      <span className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
        <span>{t('projects.chatCount', { count: project.chat_count })}</span>
        {project.member_count > 1 && (
          <>
            <span>·</span>
            <UsersIcon className="size-3" />
            <span>{project.member_count}</span>
          </>
        )}
        {project.last_active_at && (
          <>
            <span>·</span>
            <span>{formatRelativeTime(project.last_active_at)}</span>
          </>
        )}
      </span>
    </button>
  );

  // Only the creator changes a project, so for everyone else there is no menu.
  if (!project.is_creator) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onSelect={beginRename}>
          <PencilIcon /> {t('sidebar.renameProject')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => void remove()}>
          <Trash2Icon /> {t('sidebar.deleteProject')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** The /projects page: every project the user is in, as a card. */
export function ProjectsWorkspace() {
  const { t } = useTranslation();
  const { data } = useProjects();
  const setOpenProject = useUi((s) => s.setOpenProject);
  const setCreateOpen = useUi((s) => s.setCreateProjectOpen);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');

  const needle = query.trim().toLowerCase();
  const visible = (data ?? [])
    .filter((p) =>
      !needle ||
      p.name.toLowerCase().includes(needle) ||
      p.description.toLowerCase().includes(needle),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : timestampMs(b.last_active_at) - timestampMs(a.last_active_at),
    );

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
      {data && visible.length === 0 ? (
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
            <ProjectCard key={p.id} project={p} onOpen={() => setOpenProject(p.id)} />
          ))}
        </CardGrid>
      )}
    </Page>
  );
}
