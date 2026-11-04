import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, BrainIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addMemory,
  deleteMemory,
  fetchMemories,
  updateMemory,
  type MemoriesOverview,
  type MemoryDatabase,
  type MemoryEntry,
} from '@/api/client';
import { useUi } from '@/state/ui';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useAuth } from '../auth/AuthGate';
import { Button } from '../ui/button';
import { SearchInput } from '../ui/search';

/** Notes are stored on one line (src/db_memory.py), so the counter has to measure
 *  what will be saved, not what is in the box. */
const stored = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');

function NoteEditor({
  initial,
  room,
  entryLimit,
  onSave,
  onCancel,
}: {
  initial: string;
  /** Characters this note may take without overrunning the database's budget. */
  room: number;
  entryLimit: number;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const length = stored(text).length;
  const limit = Math.min(entryLimit, room);
  const tooLong = length > limit;

  const save = async () => {
    if (!length || tooLong || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(stored(text));
    } catch (e) {
      setError((e as Error).message.split('\n', 1)[0]);
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border bg-card/40 p-3">
      <textarea
        autoFocus
        value={text}
        rows={3}
        aria-label={t('memories.noteLabel')}
        placeholder={t('memories.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
        }}
        className="w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <span className={cn('text-[11px] tabular-nums text-muted-foreground', tooLong && 'text-destructive')}>
          {t(room < entryLimit ? 'memories.counterRoom' : 'memories.counter', { count: length, limit })}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={!length || tooLong || saving} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NoteRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: MemoryEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const unknown = t('tickets.unknownUser');
  const changed = entry.updated_at !== entry.created_at || entry.updated_by !== entry.created_by;
  return (
    <li className="group flex items-start gap-2 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed break-words">{entry.text}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          #{entry.id} · {t('memories.writtenBy', { user: entry.created_by || unknown })}
          {entry.created_at && ` · ${formatRelativeTime(entry.created_at)}`}
          {changed &&
            ` · ${t('memories.changedBy', { user: entry.updated_by || unknown })}` +
              (entry.updated_at ? ` · ${formatRelativeTime(entry.updated_at)}` : '')}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('memories.edit', { id: entry.id })}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PencilIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('memories.delete', { id: entry.id })}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

function DatabaseSection({
  database,
  overview,
  query,
  onChanged,
}: {
  database: MemoryDatabase;
  overview: MemoriesOverview;
  query: string;
  onChanged: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');
  const free = overview.total_limit - database.used;
  const number = (n: number) => n.toLocaleString(i18n.language);
  const entries = database.entries.filter((entry) => {
    const q = query.trim().toLowerCase();
    return (
      !q ||
      entry.text.toLowerCase().includes(q) ||
      (entry.created_by ?? '').toLowerCase().includes(q) ||
      (entry.updated_by ?? '').toLowerCase().includes(q)
    );
  });

  const remove = async (entry: MemoryEntry) => {
    if (!window.confirm(t('memories.deleteConfirm', { id: entry.id }))) return;
    setError('');
    try {
      await deleteMemory(entry.id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="space-y-2">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-sm font-medium">{database.name}</h2>
        {database.removed && <span className="text-[11px] text-muted-foreground">{t('memories.removed')}</span>}
        {!database.removed && !database.enabled && (
          <span className="text-[11px] text-muted-foreground">{t('memories.disabled')}</span>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {t('memories.usage', { used: number(database.used), limit: number(overview.total_limit) })}
        </span>
      </header>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {entries.length === 0 && (
        <p className="py-1 text-sm text-muted-foreground">
          {query.trim() ? t('memories.noMatch') : t('memories.noNotes')}
        </p>
      )}
      <ul className="space-y-1.5">
        {entries.map((entry) =>
          editing === entry.id ? (
            <li key={entry.id}>
              <NoteEditor
                initial={entry.text}
                room={free + entry.text.length}
                entryLimit={overview.entry_limit}
                onCancel={() => setEditing(null)}
                onSave={async (text) => {
                  await updateMemory(entry.id, text);
                  await onChanged();
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <NoteRow
              key={entry.id}
              entry={entry}
              onEdit={() => setEditing(entry.id)}
              onDelete={() => void remove(entry)}
            />
          ),
        )}
      </ul>
      {!database.removed &&
        (editing === 'new' ? (
          <NoteEditor
            initial=""
            room={free}
            entryLimit={overview.entry_limit}
            onCancel={() => setEditing(null)}
            onSave={async (text) => {
              await addMemory(database.id, text);
              await onChanged();
              setEditing(null);
            }}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <PlusIcon /> {t('memories.add')}
          </Button>
        ))}
    </section>
  );
}

/** The /memories workspace: what the model has noted about each database, which
 *  reaches every user's chats. Admin-only, so wrong notes can be caught here. */
export function MemoriesWorkspace() {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);
  const queryClient = useQueryClient();
  const auth = useAuth();
  // The menu and palette entries are already gated, but `#/memories` is
  // deep-linkable, so a non-admin landing here goes back to chat.
  const isAdmin = auth?.is_admin !== false;
  const [query, setQuery] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['memories'],
    queryFn: fetchMemories,
    enabled: isAdmin,
  });

  useEffect(() => {
    if (!isAdmin) setView('chat');
  }, [isAdmin, setView]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['memories'] });

  const databases = useMemo(() => {
    const all = data?.databases ?? [];
    // While searching, only the databases with a hit; otherwise every database
    // that can hold notes, and an empty switched-off one has nothing to show.
    const q = query.trim().toLowerCase();
    return all.filter((d) =>
      q
        ? d.entries.some(
            (e) =>
              e.text.toLowerCase().includes(q) ||
              (e.created_by ?? '').toLowerCase().includes(q) ||
              (e.updated_by ?? '').toLowerCase().includes(q),
          )
        : d.enabled || d.entries.length > 0,
    );
  }, [data, query]);

  if (!isAdmin) return null;

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
        <header className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView('chat')}
              aria-label={t('rag.backToChat')}
              className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
            <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{t('memories.title')}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{t('memories.intro')}</p>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('memories.search')}
          />
        </header>

        {isLoading && <p className="py-8 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
        {isError && <p role="alert" className="py-8 text-center text-sm text-destructive">{t('memories.loadFailed')}</p>}
        {data && databases.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <BrainIcon className="size-5 opacity-60" />
            {query.trim() ? t('memories.noMatch') : t('memories.noDatabases')}
          </div>
        )}
        {data &&
          databases.map((database) => (
            <DatabaseSection
              key={database.id}
              database={database}
              overview={data}
              query={query}
              onChanged={refresh}
            />
          ))}
      </div>
    </main>
  );
}
