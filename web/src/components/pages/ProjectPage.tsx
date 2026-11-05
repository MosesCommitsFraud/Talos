import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  BrainIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  LogOutIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addProjectMember,
  addProjectMemory,
  createProjectFolder,
  deleteLibraryArtifact,
  deleteProject,
  deleteProjectMemory,
  fetchProject,
  fetchProjectCandidates,
  fetchProjectChats,
  fetchProjectFiles,
  fetchProjectMembers,
  fetchProjectMemories,
  removeProjectMember,
  updateProject,
  updateProjectMemory,
  uploadProjectFile,
  type ProjectChat,
  type ProjectFile,
  type ProjectFiles,
  type ProjectMember,
  type ProjectSummary,
} from '@/api/client';
import { artifactDisplayName, displayName } from '@/lib/files';
import { formatRelativeTime } from '@/lib/utils';
import { useAuth } from '../auth/AuthGate';
import { Composer } from '../Composer';
import { FileTypeIcon } from '../FileTypeIcon';
import { openSessionFile } from '../OutputCard';
import { MemoryEditor, MemoryRow } from '../settings/MemoryPanel';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogSection } from '../ui/dialog';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../ui/menu';
import { useChat } from '@/state/chat';
import { useUi } from '@/state/ui';
import { EmptyState } from './parts';

const REFRESH_MS = 15_000;
const FIELD_CLASS =
  'w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-shadow focus:border-ring focus:ring-[3px] focus:ring-ring/25 dark:bg-input/20';
const ROW_ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

/** One block of the right column: a line with what it is and how many, its action on
 *  the right, and what it holds folding out underneath. */
function Panel({
  icon,
  title,
  count,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-border/60 py-3 first:pt-0">
      <div className="flex min-h-7 items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex min-w-0 flex-1 items-center gap-2.5 text-left text-sm font-medium text-foreground"
        >
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
          <span className="truncate">{title}</span>
          {count && <span className="shrink-0 text-xs font-normal text-muted-foreground">{count}</span>}
          <ChevronRightIcon
            className={`size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[transform,opacity] group-hover:opacity-100 ${open ? 'rotate-90' : ''}`}
          />
        </button>
        {action}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

function AddButton({ label, ...props }: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-md px-1.5 py-0.5 text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
      {...props}
    >
      {label}
    </button>
  );
}

/* ── The workspace ── */

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: ProjectFile[];
}

/** The workspace as a tree. A file's folders count even if the sandbox didn't list
 *  them, and documents and images, which live in the database, sit at the top. */
function buildTree(data: ProjectFiles | undefined): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [] };
  const folderAt = (path: string): Folder => {
    let current = root;
    for (const name of path.split('/').filter(Boolean)) {
      const next = current.path ? `${current.path}/${name}` : name;
      let child = current.folders.find((f) => f.name === name);
      if (!child) {
        child = { name, path: next, folders: [], files: [] };
        current.folders.push(child);
      }
      current = child;
    }
    return current;
  };
  for (const dir of data?.dirs ?? []) folderAt(dir);
  for (const file of data?.artifacts ?? []) {
    const slash = file.source === 'workspace' ? file.path.lastIndexOf('/') : -1;
    (slash > 0 ? folderAt(file.path.slice(0, slash)) : root).files.push(file);
  }
  const sort = (folder: Folder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function WorkspacePanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isError } = useQuery({
    queryKey: ['projectFiles', projectId],
    queryFn: () => fetchProjectFiles(projectId),
    refetchInterval: REFRESH_MS,
  });
  const tree = useMemo(() => buildTree(data), [data]);
  const [error, setError] = useState('');
  const [newFolderIn, setNewFolderIn] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef('');
  const folderAfterClose = useRef<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['projectFiles', projectId] });
  const attempt = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };

  const pickFiles = (folder: string) => {
    uploadTarget.current = folder;
    picker.current?.click();
  };
  const upload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    setUploading(true);
    await attempt(async () => {
      for (const file of list) await uploadProjectFile(projectId, file, uploadTarget.current);
    });
    setUploading(false);
    if (picker.current) picker.current.value = '';
  };
  const commitFolder = (name: string) => {
    const parent = newFolderIn;
    setNewFolderIn(null);
    if (!name || parent === null) return;
    void attempt(() => createProjectFolder(projectId, parent ? `${parent}/${name}` : name));
  };
  const remove = (path: string, sessionId: string, label: string) => {
    if (!window.confirm(t('projects.deleteFileConfirm', { name: label }))) return;
    void attempt(() => deleteLibraryArtifact({ path, sessionId }));
  };

  const addMenu = (folder: string, trigger: React.ReactNode) => (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      {/* The new folder's name field appears only once the menu has let go of the
          focus: it would take it right back, and the empty field would close. */}
      <MenuPopup
        align="end"
        onCloseAutoFocus={(e) => {
          if (folderAfterClose.current === null) return;
          e.preventDefault();
          setNewFolderIn(folderAfterClose.current);
          folderAfterClose.current = null;
        }}
      >
        <MenuItem onSelect={() => pickFiles(folder)}>
          <UploadIcon /> {t('projects.uploadFile')}
        </MenuItem>
        <MenuItem onSelect={() => { folderAfterClose.current = folder; }}>
          <FolderPlusIcon /> {t('projects.newFolder')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  const fileCount = data?.artifacts.length ?? 0;
  const empty = !!data && fileCount === 0 && tree.folders.length === 0;

  return (
    <Panel
      icon={<FileIcon />}
      title={t('projects.workspace')}
      count={data ? t('projects.fileCount', { count: fileCount }) : undefined}
      action={addMenu('', <AddButton label={t('projects.add')} disabled={uploading} />)}
    >
      <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
      {uploading && <p className="pb-1 text-xs text-muted-foreground">{t('projects.uploading')}</p>}
      {error && <p role="alert" className="pb-1 text-xs text-destructive">{error}</p>}
      {(isError || data?.error) && (
        <p role="alert" className="pb-1 text-xs text-destructive">{t('projects.workspaceUnavailable')}</p>
      )}
      {newFolderIn === '' && <FolderNameInput onDone={commitFolder} />}
      {empty && newFolderIn === null && (
        <p className="py-1 text-xs text-muted-foreground">{t('projects.workspaceEmpty')}</p>
      )}
      <FolderContents
        folder={tree}
        depth={0}
        projectRef={data?.ref ?? ''}
        newFolderIn={newFolderIn}
        onCommitFolder={commitFolder}
        addMenu={addMenu}
        onRemove={remove}
      />
    </Panel>
  );
}

function FolderNameInput({ onDone, depth = 0 }: { onDone: (name: string) => void; depth?: number }) {
  const { t } = useTranslation();
  return (
    <input
      autoFocus
      placeholder={t('projects.folderPlaceholder')}
      aria-label={t('projects.newFolder')}
      style={{ marginLeft: depth * 12 }}
      onBlur={(e) => onDone(e.target.value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(e.currentTarget.value.trim());
        if (e.key === 'Escape') onDone('');
      }}
      className="mb-1 h-7 w-[calc(100%-4px)] rounded-md border border-ring bg-transparent px-2 text-sm outline-none"
    />
  );
}

function FolderContents({
  folder,
  depth,
  projectRef,
  newFolderIn,
  onCommitFolder,
  addMenu,
  onRemove,
}: {
  folder: Folder;
  depth: number;
  projectRef: string;
  newFolderIn: string | null;
  onCommitFolder: (name: string) => void;
  addMenu: (folder: string, trigger: React.ReactNode) => React.ReactNode;
  onRemove: (path: string, sessionId: string, label: string) => void;
}) {
  const shared = { projectRef, newFolderIn, onCommitFolder, addMenu, onRemove };
  return (
    <>
      {folder.folders.map((child) => (
        <FolderRow key={child.path} folder={child} depth={depth} {...shared} />
      ))}
      {folder.files.map((file) => (
        <FileRow key={`${file.session_id}:${file.path}`} file={file} depth={depth} onRemove={onRemove} />
      ))}
    </>
  );
}

function FolderRow({
  folder,
  depth,
  projectRef,
  newFolderIn,
  onCommitFolder,
  addMenu,
  onRemove,
}: {
  folder: Folder;
  depth: number;
  projectRef: string;
  newFolderIn: string | null;
  onCommitFolder: (name: string) => void;
  addMenu: (folder: string, trigger: React.ReactNode) => React.ReactNode;
  onRemove: (path: string, sessionId: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(depth === 0);
  const addingHere = newFolderIn === folder.path;
  // A folder being added to has to show where the new one goes.
  const expanded = open || addingHere;
  return (
    <>
      <div className="group flex items-center rounded-md hover:bg-accent/60" style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          title={folder.path}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1 text-left text-sm"
        >
          <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{folder.name}</span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 pr-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {addMenu(
            folder.path,
            <button type="button" aria-label={t('projects.addTo', { name: folder.name })} className={ROW_ICON_BUTTON}>
              <PlusIcon className="size-3.5" />
            </button>,
          )}
          <button
            type="button"
            aria-label={t('common.delete')}
            onClick={() => onRemove(folder.path, projectRef, folder.name)}
            className={ROW_ICON_BUTTON}
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </span>
      </div>
      {expanded && (
        <>
          {addingHere && <FolderNameInput onDone={onCommitFolder} depth={depth + 1} />}
          <FolderContents
            folder={folder}
            depth={depth + 1}
            projectRef={projectRef}
            newFolderIn={newFolderIn}
            onCommitFolder={onCommitFolder}
            addMenu={addMenu}
            onRemove={onRemove}
          />
        </>
      )}
    </>
  );
}

function FileRow({
  file,
  depth,
  onRemove,
}: {
  file: ProjectFile;
  depth: number;
  onRemove: (path: string, sessionId: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const name = artifactDisplayName(file.path, file.name);
  // An image's row goes with its owner alone; files and documents are everyone's.
  const canDelete = file.source === 'workspace' || file.source === 'document';
  const open = () =>
    openSessionFile(file.session_id, {
      path: file.path,
      name,
      size: file.size,
      mime: file.mime,
      version: file.version,
      mtime: file.mtime,
      source: file.source,
    });
  return (
    <div className="group flex items-center rounded-md hover:bg-accent/60" style={{ paddingLeft: depth * 12 }}>
      <button type="button" onClick={open} title={name} className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1 text-left text-sm">
        <FileTypeIcon path={name} mime={file.mime} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{file.source === 'workspace' ? name : displayName(name)}</span>
      </button>
      {canDelete && (
        <button
          type="button"
          aria-label={t('common.delete')}
          onClick={() => onRemove(file.path, file.session_id, name)}
          className={`${ROW_ICON_BUTTON} mr-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/* ── Memories ── */

function MemoriesPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ['projectMemories', projectId];
  const { data, isError } = useQuery({
    queryKey,
    queryFn: () => fetchProjectMemories(projectId),
    refetchInterval: REFRESH_MS,
  });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const entries = data?.entries ?? [];
  const full = !!data && entries.length >= data.limits.entries;

  const remove = async (id: number, title: string) => {
    if (!window.confirm(t('settings.memory.deleteConfirm', { title }))) return;
    setError('');
    try {
      await deleteProjectMemory(projectId, id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Panel
      icon={<BrainIcon />}
      title={t('projects.memories')}
      count={data ? String(entries.length) : undefined}
      action={<AddButton label={t('projects.add')} disabled={!data || full} onClick={() => setEditing('new')} />}
    >
      {isError && <p role="alert" className="text-xs text-destructive">{t('settings.memory.loadFailed')}</p>}
      {error && <p role="alert" className="pb-1 text-xs text-destructive">{error}</p>}
      {data && entries.length === 0 && editing !== 'new' && (
        <p className="py-1 text-xs text-muted-foreground">{t('projects.memoriesEmpty')}</p>
      )}
      {data && entries.map((entry) =>
        editing === entry.id ? (
          <MemoryEditor
            key={entry.id}
            initial={entry}
            limits={data.limits}
            onCancel={() => setEditing(null)}
            onSave={async (title, text) => {
              await updateProjectMemory(projectId, entry.id, title, text);
              await refresh();
              setEditing(null);
            }}
          />
        ) : (
          <MemoryRow
            key={entry.id}
            entry={entry}
            onEdit={() => setEditing(entry.id)}
            onDelete={() => void remove(entry.id, entry.title)}
          />
        ),
      )}
      {data && editing === 'new' && (
        <MemoryEditor
          limits={data.limits}
          onCancel={() => setEditing(null)}
          onSave={async (title, text) => {
            await addProjectMemory(projectId, title, text);
            await refresh();
            setEditing(null);
          }}
        />
      )}
    </Panel>
  );
}

/* ── Members ── */

const memberLabel = (m: { username: string | null; display_name?: string | null }) =>
  m.display_name || m.username || '';

function MembersPanel({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectId = project.id;
  const { data: members } = useQuery({
    queryKey: ['projectMembers', projectId],
    queryFn: () => fetchProjectMembers(projectId),
  });
  const { data: candidates } = useQuery({
    queryKey: ['projectCandidates', projectId],
    queryFn: () => fetchProjectCandidates(projectId),
    enabled: project.is_creator,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['projectMembers', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['projectCandidates', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  const add = useMutation({ mutationFn: (username: string) => addProjectMember(projectId, username), onSettled: refresh });
  const remove = useMutation({ mutationFn: (username: string) => removeProjectMember(projectId, username), onSettled: refresh });
  const confirmRemove = (member: ProjectMember) => {
    if (window.confirm(t('projects.removeMemberConfirm', { name: memberLabel(member) }))) remove.mutate(member.username);
  };
  const failure = (add.error ?? remove.error) as Error | null;

  return (
    <Panel
      icon={<UsersIcon />}
      title={t('projects.members')}
      count={String(project.member_count)}
      action={
        project.is_creator ? (
          <Menu>
            <MenuTrigger asChild>
              <AddButton label={t('projects.add')} />
            </MenuTrigger>
            <MenuPopup align="end" className="max-h-72 overflow-y-auto">
              {(candidates ?? []).map((user) => (
                <MenuItem key={user.username} onSelect={() => add.mutate(user.username)}>
                  {memberLabel(user)}
                </MenuItem>
              ))}
              {candidates?.length === 0 && (
                <MenuItem disabled>{t('projects.noCandidates')}</MenuItem>
              )}
            </MenuPopup>
          </Menu>
        ) : undefined
      }
    >
      {failure && <p role="alert" className="pb-1 text-xs text-destructive">{failure.message}</p>}
      {(members ?? []).map((member) => (
        <div key={member.username} className="group flex items-center gap-2.5 rounded-md py-1 pl-1">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-medium uppercase text-foreground">
            {memberLabel(member).slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{memberLabel(member)}</span>
          {member.is_creator && (
            <span className="shrink-0 text-xs text-muted-foreground">{t('projects.creator')}</span>
          )}
          {project.is_creator && !member.is_creator && (
            <button
              type="button"
              aria-label={t('projects.removeMember', { name: memberLabel(member) })}
              onClick={() => confirmRemove(member)}
              className={`${ROW_ICON_BUTTON} mr-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </Panel>
  );
}

/* ── Chats ── */

function ChatRow({ chat, mine }: { chat: ProjectChat; mine: boolean }) {
  const { t } = useTranslation();
  const openSession = useChat((s) => s.openSession);
  return (
    <button
      type="button"
      onClick={() => void openSession(chat.id)}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-sidebar-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {chat.name || t('projects.untitledChat')}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {mine ? t('projects.chatByYou') : (chat.owner_display_name || chat.owner)}
          {chat.last_message_at && ` · ${formatRelativeTime(chat.last_message_at)}`}
        </span>
      </span>
      {!mine && (
        <span title={t('projects.readOnlyHint')} className="shrink-0 text-muted-foreground">
          <EyeIcon className="size-3.5" />
        </span>
      )}
    </button>
  );
}

function ChatList({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const { data: chats, isError } = useQuery({
    queryKey: ['projectChats', projectId],
    queryFn: () => fetchProjectChats(projectId),
    refetchInterval: REFRESH_MS,
  });
  if (isError) {
    return <p role="alert" className="py-6 text-center text-sm text-destructive">{t('projects.chatsLoadFailed')}</p>;
  }
  if (chats?.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2.5 py-16 text-center text-sm text-muted-foreground">
        <MessageSquareIcon className="size-5" />
        {t('projects.chatsEmpty')}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {(chats ?? []).map((chat) => (
        <ChatRow key={chat.id} chat={chat} mine={chat.owner === auth?.username} />
      ))}
    </div>
  );
}

/* ── The page ── */

function EditProjectDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const save = useMutation({
    mutationFn: () => updateProject(project.id, { name: name.trim(), description: description.trim() }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
      ]);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={t('projects.editTitle')} className="w-[min(520px,92vw)]">
        <DialogSection className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="project-edit-name" className="block text-sm font-medium text-foreground">
              {t('projects.nameField')}
            </label>
            <input id="project-edit-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={FIELD_CLASS} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="project-edit-goal" className="block text-sm font-medium text-foreground">
              {t('projects.descriptionField')}
            </label>
            <textarea
              id="project-edit-goal"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${FIELD_CLASS} resize-y`}
            />
            <p className="text-xs text-muted-foreground">{t('projects.descriptionHint')}</p>
          </div>
          {save.error && <p role="alert" className="text-xs text-destructive">{(save.error as Error).message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
          </div>
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}

function ProjectMenu({ project, onEdit, onGone }: { project: ProjectSummary; onEdit: () => void; onGone: () => void }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [error, setError] = useState('');
  const attempt = (work: () => Promise<unknown>) =>
    void work().then(onGone, (e: Error) => setError(e.message));
  return (
    <div className="flex items-center gap-2">
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
      <Menu>
        <MenuTrigger
          aria-label={t('projects.moreOptions')}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-44">
          {project.is_creator ? (
            <>
              <MenuItem onSelect={onEdit}>
                <PencilIcon /> {t('projects.edit')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onSelect={() => {
                  if (window.confirm(t('projects.deleteConfirm', { name: project.name }))) {
                    attempt(() => deleteProject(project.id));
                  }
                }}
              >
                <Trash2Icon /> {t('sidebar.deleteProject')}
              </MenuItem>
            </>
          ) : (
            <MenuItem
              variant="destructive"
              onSelect={() => {
                if (window.confirm(t('projects.leaveConfirm', { name: project.name }))) {
                  attempt(() => removeProjectMember(project.id, auth?.username ?? ''));
                }
              }}
            >
              <LogOutIcon /> {t('projects.leave')}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** A project's page: start a chat, every chat anyone has in it, and beside them the
 *  shared workspace, its memory and who is in it. */
export function ProjectPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setOpenProject = useUi((s) => s.setOpenProject);
  const [editing, setEditing] = useState(false);
  const { data: project, isError } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => fetchProject(projectId),
    retry: false,
  });

  // The composer on this page starts a chat in the project; sending goes to it.
  useEffect(() => {
    useChat.getState().newChatIn({ projectId });
    return () => useChat.getState().clearDraftPlacement();
  }, [projectId]);

  const backToList = () => setOpenProject(null);
  const gone = () => {
    backToList();
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  if (isError) {
    return (
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[1100px] px-8 py-8">
          <EmptyState
            icon={<FolderIcon />}
            title={t('projects.notFound')}
            action={<Button variant="outline" onClick={backToList}>{t('projects.backToList')}</Button>}
          />
        </div>
      </main>
    );
  }

  return (
    // Relative: the composer's drop overlay spreads over the nearest <main>.
    <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
      {/* A container: the columns go by the room the page has, which an open file
          beside it takes away, not by the width of the window. */}
      <div className="@container mx-auto w-full max-w-[1100px] px-8 py-6">
        <button
          type="button"
          onClick={backToList}
          className="-ml-1 mb-3 flex items-center gap-1 rounded px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3" /> {t('sidebar.projects')}
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-strong">{project?.name ?? ' '}</h1>
            {project?.description && (
              <p className="mt-2 max-w-[80ch] whitespace-pre-line text-sm text-muted-foreground">{project.description}</p>
            )}
          </div>
          {project && <ProjectMenu project={project} onEdit={() => setEditing(true)} onGone={gone} />}
        </div>

        <div className="mt-6 grid gap-x-12 gap-y-8 @3xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <div className="-mx-4">
              <Composer />
            </div>
            <div className="mt-4">
              <ChatList projectId={projectId} />
            </div>
          </div>
          <aside className="min-w-0">
            <WorkspacePanel projectId={projectId} />
            <MemoriesPanel projectId={projectId} />
            {project && <MembersPanel project={project} />}
          </aside>
        </div>
      </div>
      {editing && project && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}
    </main>
  );
}

/** In place of the composer in someone else's chat: it runs as its owner, and only
 *  they write in it. The way on is a chat of one's own in the same project. */
export function ReadOnlyChatNotice({
  chat,
}: {
  chat: { owner: string | null; projectId: string | null };
}) {
  const { t } = useTranslation();
  const setOpenProject = useUi((s) => s.setOpenProject);
  const setView = useUi((s) => s.setView);
  const { data: members } = useQuery({
    queryKey: ['projectMembers', chat.projectId],
    queryFn: () => fetchProjectMembers(chat.projectId!),
    enabled: !!chat.projectId,
  });
  const owner = members?.find((m) => m.username === chat.owner);
  return (
    <div className="mx-auto w-full max-w-[800px] px-4 pb-3">
      <div className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-sm text-muted-foreground">
        <EyeIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {t('projects.readOnlyChat', { owner: owner ? memberLabel(owner) : (chat.owner ?? '') })}
        </span>
        {chat.projectId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpenProject(chat.projectId);
              setView('projects');
            }}
          >
            {t('projects.readOnlyNewChat')}
          </Button>
        )}
      </div>
    </div>
  );
}
