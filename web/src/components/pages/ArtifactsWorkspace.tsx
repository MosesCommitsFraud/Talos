import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  CodeIcon,
  EllipsisVerticalIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  LayoutGridIcon,
  ListIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PresentationIcon,
  ShapesIcon,
  SheetIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  artifactDownloadUrl,
  deleteLibraryArtifact,
  fetchAllArtifacts,
  updateLibraryArtifact,
} from '@/api/client';
import type { LibraryArtifact } from '@/api/types';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { artifactDisplayName, displayName, fileExt, isPreviewable, previewKind } from '@/lib/files';
import { cn, timestampMs } from '@/lib/utils';
import { FilePreviewFace, hasVisualPreview } from '../AttachmentTile';
import { FileTypeIcon } from '../FileTypeIcon';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogSection } from '../ui/dialog';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../ui/menu';
import { Input, Tooltip } from '../ui/misc';
import { SearchInput } from '../ui/search';
import { toast } from '../ui/toast';
import { EmptyState, Page } from './parts';

/* ── Model ─────────────────────────────────────────────────────────────── */

/** Filter buckets for the type menu — what a reader means by "kind of thing",
 *  coarser than file extensions. */
type Category = 'document' | 'presentation' | 'spreadsheet' | 'web' | 'code' | 'image' | 'other';
const CATEGORIES: { id: Category; icon: ReactNode }[] = [
  { id: 'document', icon: <FileTextIcon /> },
  { id: 'presentation', icon: <PresentationIcon /> },
  { id: 'spreadsheet', icon: <SheetIcon /> },
  { id: 'web', icon: <GlobeIcon /> },
  { id: 'code', icon: <CodeIcon /> },
  { id: 'image', icon: <ImageIcon /> },
  { id: 'other', icon: <FileIcon /> },
];
const CATEGORY_ICON = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.icon])) as Record<Category, ReactNode>;

/** A tint per kind, so a long list can be scanned by type at a glance. */
const CATEGORY_TONE: Record<Category, string> = {
  document: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  presentation: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
  spreadsheet: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  web: 'bg-violet-500/12 text-violet-600 dark:text-violet-400',
  code: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  image: 'bg-pink-500/12 text-pink-600 dark:text-pink-400',
  other: 'bg-muted text-muted-foreground',
};

/** One library row, with everything the views need worked out once. */
interface Item {
  key: string;
  raw: LibraryArtifact;
  path: string;
  sessionId: string | null;
  name: string;
  mime?: string;
  category: Category;
  mtime: number;
  pinned: boolean;
  canOpen: boolean;
}

function categoryOf(name: string, mime?: string): Category {
  switch (previewKind(name, mime)) {
    case 'markdown':
    case 'text':
    case 'word':
    case 'pdf':
      return 'document';
    case 'presentation':
      return 'presentation';
    case 'excel':
    case 'csv':
      return 'spreadsheet';
    case 'html':
      return 'web';
    case 'code':
      return 'code';
    case 'image':
      return 'image';
    default:
      return 'other';
  }
}

function toItem(a: LibraryArtifact): Item {
  const path = String(a.path ?? a.name ?? '');
  const name = artifactDisplayName(path, typeof a.name === 'string' ? a.name : undefined);
  const mime = typeof a.mime === 'string' ? a.mime : undefined;
  const sessionId = a.session_id ?? null;
  return {
    key: `${sessionId ?? 'orphan'}:${path}`,
    raw: a,
    path,
    sessionId,
    name,
    mime,
    category: categoryOf(name, mime),
    mtime: timestampMs(a.mtime ?? 0),
    pinned: !!a.pinned,
    // The preview panel fetches through the chat's artifact routes, so an
    // artifact whose chat is gone can be listed but not opened.
    canOpen: !!sessionId && isPreviewable(name, mime),
  };
}

/** "Sep 30" this year, "Sep 30, 2025" before, the time of day for today. */
function editedLabel(ms: number, lang: string): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(lang, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Month heading for the list view: "October" this year, "August 2025" before. */
function monthLabel(ms: number, lang: string): string {
  const d = new Date(ms);
  return d.toLocaleDateString(lang, {
    month: 'long',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Consecutive runs of items that share a month (input is newest first). */
function groupByMonth(items: Item[], lang: string): { label: string; items: Item[] }[] {
  const groups: { label: string; items: Item[] }[] = [];
  for (const item of items) {
    const label = item.mtime ? monthLabel(item.mtime, lang) : '—';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/* ── Shared bits ───────────────────────────────────────────────────────── */

/** The ⋮ menu both views share. Copy-link is deliberately absent: artifacts
 *  are private to their owner, there is nothing to share a link to. */
function ItemMenu({
  item,
  onPin,
  onRename,
  onDelete,
  className,
}: {
  item: Item;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('artifacts.actions')}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            className,
          )}
        >
          <EllipsisVerticalIcon className="size-4" />
        </button>
      </MenuTrigger>
      {/* React events bubble through the portal to the row/tile underneath,
          which would open the artifact on every click or Enter in here. */}
      <MenuPopup align="end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <MenuItem onSelect={onPin}>
          {item.pinned ? <PinOffIcon /> : <PinIcon />} {t(item.pinned ? 'artifacts.unpin' : 'artifacts.pin')}
        </MenuItem>
        <MenuItem onSelect={onRename}>
          <PencilIcon /> {t('artifacts.rename')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon /> {t('artifacts.delete')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** What the tile shows above its title: a real thumbnail for images and PDFs,
 *  the opening lines for documents, the type glyph for everything else. */
function TilePreview({ item }: { item: Item }) {
  const snippet = typeof item.raw.snippet === 'string' ? item.raw.snippet.trim() : '';
  if (item.sessionId && hasVisualPreview(item.name, item.mime)) {
    return (
      <FilePreviewFace
        url={artifactDownloadUrl(item.sessionId, item.path)}
        name={item.name}
        mime={item.mime}
        width={360}
        height={168}
      />
    );
  }
  if (snippet) {
    const code = item.category === 'code' || item.category === 'web';
    return (
      <div
        className={cn(
          'size-full overflow-hidden px-4 pt-3.5 text-[11px] leading-[1.45] whitespace-pre-wrap break-words text-muted-foreground [mask-image:linear-gradient(to_bottom,black_55%,transparent)]',
          code && 'font-mono text-[10.5px]',
        )}
      >
        {snippet}
      </div>
    );
  }
  return (
    <div className="flex size-full items-center justify-center">
      <FileTypeIcon path={item.name} mime={item.mime} className="size-10 text-muted-foreground/70" />
    </div>
  );
}

function TypeBadge({ item, className }: { item: Item; className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg [&_svg]:size-[46%]',
        CATEGORY_TONE[item.category],
        className,
      )}
    >
      {CATEGORY_ICON[item.category]}
    </span>
  );
}

/* ── Views ─────────────────────────────────────────────────────────────── */

interface ViewProps {
  items: Item[];
  onOpen: (item: Item) => void;
  onPin: (item: Item) => void;
  onRename: (item: Item) => void;
  onDelete: (item: Item) => void;
}

function ListRow({ item, onOpen, onPin, onRename, onDelete }: Omit<ViewProps, 'items'> & { item: Item }) {
  const { t, i18n } = useTranslation();
  const edited = item.mtime ? t('artifacts.edited', { date: editedLabel(item.mtime, i18n.language) }) : '';
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={!item.canOpen}
      title={item.name}
      onClick={() => item.canOpen && onOpen(item)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && item.canOpen) {
          e.preventDefault();
          onOpen(item);
        }
      }}
      className={cn(
        'group -mx-3 flex items-center gap-4 rounded-xl px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        item.canOpen ? 'cursor-pointer hover:bg-accent/60' : 'cursor-default',
      )}
    >
      <TypeBadge item={item} className="size-11" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] text-strong">{displayName(item.name)}</span>
          {item.pinned && <PinIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        </div>
        {(item.raw.session_name || edited) && (
          <div className="truncate text-xs text-muted-foreground/80">
            {/* Narrow screens have no room for the date column. */}
            {edited && (
              <span className="sm:hidden">
                {edited}
                {item.raw.session_name && ' · '}
              </span>
            )}
            {item.raw.session_name && t('artifacts.fromChat', { name: item.raw.session_name })}
          </div>
        )}
      </div>
      <span className="hidden shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground/70 sm:inline">
        {fileExt(item.name) || t('artifacts.file')}
      </span>
      <span className="hidden shrink-0 text-right text-sm whitespace-nowrap text-muted-foreground sm:inline sm:min-w-32">
        {edited}
      </span>
      <ItemMenu
        item={item}
        onPin={() => onPin(item)}
        onRename={() => onRename(item)}
        onDelete={() => onDelete(item)}
      />
    </div>
  );
}

function ListView(props: ViewProps & { grouped: boolean }) {
  const { i18n } = useTranslation();
  const { items, grouped, ...handlers } = props;
  if (!grouped) {
    return (
      <div className="flex flex-col">
        {items.map((item) => <ListRow key={item.key} item={item} {...handlers} />)}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {groupByMonth(items, i18n.language).map((g) => (
        <section key={g.label}>
          <h2 className="mb-1 text-sm text-muted-foreground">{g.label}</h2>
          <div className="flex flex-col">
            {g.items.map((item) => <ListRow key={item.key} item={item} {...handlers} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Tile({ item, onOpen, onPin, onRename, onDelete }: Omit<ViewProps, 'items'> & { item: Item }) {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={!item.canOpen}
      title={item.name}
      onClick={() => item.canOpen && onOpen(item)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && item.canOpen) {
          e.preventDefault();
          onOpen(item);
        }
      }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border bg-card outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        item.canOpen ? 'cursor-pointer hover:border-ring/40' : 'cursor-default',
      )}
    >
      <div className="relative h-42 border-b bg-muted/30">
        <TilePreview item={item} />
        <span className="absolute bottom-0 left-4 translate-y-1/2 rounded-md bg-card">
          <TypeBadge item={item} className="size-7 rounded-md" />
        </span>
        {item.pinned && (
          <span className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground backdrop-blur-sm">
            <PinIcon className="size-3.5" />
          </span>
        )}
        <ItemMenu
          item={item}
          onPin={() => onPin(item)}
          onRename={() => onRename(item)}
          onDelete={() => onDelete(item)}
          className="absolute top-2 right-2 bg-background/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </div>
      <div className="min-w-0 px-4 pt-5 pb-3.5">
        <div className="truncate text-[15px] text-strong">{displayName(item.name)}</div>
        <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {item.mtime ? <span>{t('artifacts.edited', { date: editedLabel(item.mtime, i18n.language) })}</span> : null}
          {item.raw.session_name && (
            <>
              <span>·</span>
              <span className="truncate">{item.raw.session_name}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GridView({ items, ...handlers }: ViewProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => <Tile key={item.key} item={item} {...handlers} />)}
    </div>
  );
}

/* ── Dialogs ───────────────────────────────────────────────────────────── */

function RenameDialog({ item, onClose, onSubmit }: { item: Item | null; onClose: () => void; onSubmit: (name: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [forKey, setForKey] = useState<string | null>(null);
  // Re-seed the field whenever a different artifact is opened for renaming.
  if ((item?.key ?? null) !== forKey) {
    setForKey(item?.key ?? null);
    if (item) setDraft(displayName(item.name));
  }
  const value = draft.trim();
  const submit = () => {
    if (!item || !value) return;
    if (value !== displayName(item.name)) onSubmit(value);
    onClose();
  };
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={t('artifacts.renameTitle')} className="w-[min(440px,92vw)]">
        <DialogSection>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="flex items-center gap-2">
              <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} />
              {item && fileExt(item.name) && (
                <span className="shrink-0 text-sm text-muted-foreground">.{fileExt(item.name)}</span>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={!value}>{t('artifacts.rename')}</Button>
            </div>
          </form>
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ item, onClose, onConfirm }: { item: Item | null; onClose: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('artifacts.deleteTitle')}
        description={item ? t('artifacts.deleteConfirm', { name: item.name }) : undefined}
        className="w-[min(440px,92vw)]"
      >
        <DialogSection className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {t('artifacts.delete')}
          </Button>
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

const QUERY_KEY = ['artifacts', 'all'];

/** The /artifacts page: everything the assistant has produced for this user,
 *  across every chat — as dated rows or preview tiles, with pinned artifacts
 *  on top. Clicking a previewable file opens it in the same document panel
 *  the chat uses. */
export function ArtifactsWorkspace() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const openPreview = useUi((s) => s.openPreview);
  const setView = useUi((s) => s.setView);
  const view = usePrefs((s) => s.artifactsView);
  const setArtifactsView = usePrefs((s) => s.setArtifactsView);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAllArtifacts,
    staleTime: 30_000,
  });

  const all = (data ?? []).map(toItem);
  const counts = new Map<Category, number>();
  for (const item of all) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);

  const needle = query.trim().toLowerCase();
  const visible = all.filter((item) => {
    if (category && item.category !== category) return false;
    if (!needle) return true;
    return `${item.name} ${item.raw.session_name ?? ''}`.toLowerCase().includes(needle);
  });
  const pinned = visible
    .filter((i) => i.pinned)
    .sort((a, b) => (b.raw.pinned_at ?? 0) - (a.raw.pinned_at ?? 0));
  const rest = visible.filter((i) => !i.pinned);

  /** Apply a change to the cached list right away; the refetch afterwards
   *  brings in whatever the server decided (a renamed file's new path). */
  const patchCache = (item: Item, change: (a: LibraryArtifact) => LibraryArtifact | null) => {
    // A fetch already in flight would land after this and undo it.
    void queryClient.cancelQueries({ queryKey: QUERY_KEY });
    queryClient.setQueryData<LibraryArtifact[]>(QUERY_KEY, (prev) =>
      (prev ?? []).flatMap((a) => {
        if (toItem(a).key !== item.key) return [a];
        const next = change(a);
        return next ? [next] : [];
      }),
    );
  };

  const run = async (work: Promise<unknown>, errorKey: string) => {
    try {
      await work;
    } catch (err) {
      console.error('Talos: artifact update failed', err);
      toast(errorKey);
    } finally {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  };

  const ref = (item: Item) => ({ path: item.path, sessionId: item.sessionId });

  const handlers = {
    onOpen: (item: Item) => {
      // The document panel is part of the chat surface, so opening one from
      // here goes back to the chat with the panel already showing the file.
      openPreview({ sessionId: item.sessionId!, path: item.path, name: item.name, mime: item.mime });
      setView('chat');
    },
    onPin: (item: Item) => {
      const next = !item.pinned;
      patchCache(item, (a) => ({ ...a, pinned: next, pinned_at: next ? Date.now() / 1000 : undefined }));
      void run(updateLibraryArtifact(ref(item), { pinned: next }), 'artifacts.updateFailed');
    },
    onRename: (item: Item) => setRenaming(item),
    onDelete: (item: Item) => setDeleting(item),
  };

  const rename = (item: Item, name: string) => {
    const ext = fileExt(item.name);
    patchCache(item, (a) => ({ ...a, name: ext ? `${name}.${ext}` : name }));
    void run(updateLibraryArtifact(ref(item), { name }), 'artifacts.renameFailed');
  };

  const remove = (item: Item) => {
    patchCache(item, () => null);
    void run(
      deleteLibraryArtifact(ref(item)).then(() => {
        // Gone from the chat too: its file cards come from the per-chat list,
        // a generated image also sits in the loaded messages themselves.
        void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
        if (typeof item.raw.url === 'string') useChat.getState().forgetImage(item.raw.url);
        const open = useUi.getState().preview;
        if (open && open.sessionId === item.sessionId && open.path === item.path) useUi.getState().closePreview();
      }),
      'artifacts.deleteFailed',
    );
  };

  const filtering = !!needle || !!category;

  return (
    <Page
      title={t('sidebar.artifacts')}
      belowTitle={
        category ? (
          <button
            type="button"
            onClick={() => setCategory(null)}
            aria-label={t('artifacts.clearFilter')}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card ps-1 pe-2 text-xs text-foreground transition-colors hover:bg-accent"
          >
            <span className={cn('flex size-5 items-center justify-center rounded-full [&_svg]:size-3', CATEGORY_TONE[category])}>
              {CATEGORY_ICON[category]}
            </span>
            {t(`artifacts.types.${category}`)}
            <XIcon className="size-3.5 text-muted-foreground" />
          </button>
        ) : undefined
      }
      actions={
        <>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('artifacts.searchPlaceholder')}
            wrapperClassName="w-56"
          />
          <Tooltip label={t(view === 'list' ? 'artifacts.gridView' : 'artifacts.listView')}>
            <Button
              variant="ghost-muted"
              size="icon"
              aria-label={t(view === 'list' ? 'artifacts.gridView' : 'artifacts.listView')}
              onClick={() => setArtifactsView(view === 'list' ? 'grid' : 'list')}
            >
              {view === 'list' ? <LayoutGridIcon /> : <ListIcon />}
            </Button>
          </Tooltip>
          <Menu>
            <Tooltip label={t('artifacts.filterType')}>
              <MenuTrigger asChild>
                <Button
                  variant="ghost-muted"
                  size="icon"
                  aria-label={t('artifacts.filterType')}
                  className={cn(category && 'bg-accent text-foreground')}
                >
                  <SlidersHorizontalIcon />
                </Button>
              </MenuTrigger>
            </Tooltip>
            <MenuPopup align="end" className="min-w-52">
              <MenuItem onSelect={() => setCategory(null)}>
                <span className="-ms-0.5 flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
                  <ShapesIcon />
                </span>
                {t('artifacts.types.all')}
                <span className="ms-auto flex items-center ps-4">
                  {!category && <CheckIcon className="size-4 text-primary" />}
                </span>
              </MenuItem>
              <MenuSeparator />
              {CATEGORIES.map((c) => (
                <MenuItem key={c.id} disabled={!counts.get(c.id)} onSelect={() => setCategory(c.id)}>
                  <span className={cn('-ms-0.5 flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5', CATEGORY_TONE[c.id])}>
                    {c.icon}
                  </span>
                  {t(`artifacts.types.${c.id}`)}
                  <span className="ms-auto flex items-center gap-2 ps-4 text-xs tabular-nums text-muted-foreground">
                    {counts.get(c.id) ?? 0}
                    {category === c.id && <CheckIcon className="size-4 text-primary" />}
                  </span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </>
      }
    >
      {isLoading && <p className="py-16 text-center text-sm text-muted-foreground">{t('common.loading')}</p>}
      {isError && (
        <p className="py-16 text-center text-sm text-destructive-foreground">{t('artifacts.loadError')}</p>
      )}
      {!isLoading && !isError && visible.length === 0 && (
        <EmptyState
          icon={<ShapesIcon />}
          title={t(filtering ? 'artifacts.noMatches' : 'artifacts.emptyTitle')}
          hint={filtering ? undefined : t('artifacts.emptyHint')}
          action={
            category ? (
              <Button variant="outline" onClick={() => setCategory(null)}>
                {t('artifacts.clearFilter')}
              </Button>
            ) : undefined
          }
        />
      )}
      {visible.length > 0 && (
        <div className="flex flex-col gap-8">
          {pinned.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm text-muted-foreground">{t('artifacts.pinned')}</h2>
              {view === 'list' ? (
                <ListView items={pinned} grouped={false} {...handlers} />
              ) : (
                <GridView items={pinned} {...handlers} />
              )}
            </section>
          )}
          {rest.length > 0 &&
            (view === 'list' ? (
              <ListView items={rest} grouped {...handlers} />
            ) : (
              <section>
                {pinned.length > 0 && <h2 className="mb-2 text-sm text-muted-foreground">{t('artifacts.all')}</h2>}
                <GridView items={rest} {...handlers} />
              </section>
            ))}
        </div>
      )}
      <RenameDialog item={renaming} onClose={() => setRenaming(null)} onSubmit={(name) => renaming && rename(renaming, name)} />
      <DeleteDialog item={deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove(deleting)} />
    </Page>
  );
}
