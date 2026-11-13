import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addUserMemory,
  deleteAllUserMemories,
  deleteUserMemory,
  fetchUserMemories,
  fetchUserPref,
  saveUserPref,
  updateUserMemory,
  type UserMemories,
  type UserMemoryEntry,
} from '@/api/client';
import { formatRelativeTime } from '@/lib/utils';
import { Button } from '../ui/button';
import { toast, toastSaved } from '../ui/toast';
import { Input, Switch, Textarea } from '../ui/misc';
import { Page, Row, Section } from '../SettingsDialog';

const ENABLED_PREF = 'memories_enabled';
const QUERY_KEY = ['userMemories'];

/** Stored on one line (src/user_memory.py), so the limit applies to this. */
const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');

export function MemoryEditor({
  initial,
  limits,
  onSave,
  onCancel,
}: {
  initial?: UserMemoryEntry;
  limits: UserMemories['limits'];
  onSave: (title: string, text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const length = oneLine(text).length;
  const valid = length > 0 && length <= limits.text && oneLine(title).length <= limits.title;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(oneLine(title), oneLine(text));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border/60 py-3">
      <Input
        autoFocus
        value={title}
        maxLength={limits.title}
        aria-label={t('settings.memory.titleLabel')}
        placeholder={t('settings.memory.titlePlaceholder')}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        className="min-h-[88px] w-full text-[13px] leading-relaxed"
        value={text}
        aria-label={t('settings.memory.textLabel')}
        placeholder={t('settings.memory.textPlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
        }}
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <span className={`text-[11px] tabular-nums ${length > limits.text ? 'text-destructive' : 'text-muted-foreground'}`}>
          {length} / {limits.text}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={!valid || saving} onClick={() => void save()}>{t('common.save')}</Button>
        </div>
      </div>
    </div>
  );
}

export function MemoryRow({ entry, onEdit, onDelete }: { entry: UserMemoryEntry; onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-start gap-2 border-t border-border/60 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold tracking-[-0.01em] break-words">{entry.title}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed break-words text-muted-foreground">{entry.text}</p>
        {entry.updated_at && (
          <p className="mt-1 text-[11px] text-muted-foreground/80">{formatRelativeTime(entry.updated_at)}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-0.5 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('settings.memory.edit', { title: entry.title })}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PencilIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('settings.memory.delete', { title: entry.title })}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Settings → Memory, for every user: what the assistant remembers about them,
 *  and the switch for it. Only ever their own (routes/user_memory_routes.py). */
export function MemoryPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');

  const { data, isLoading, isError } = useQuery({ queryKey: QUERY_KEY, queryFn: fetchUserMemories });
  const { data: enabledPref, isLoading: prefLoading } = useQuery({
    queryKey: ['userPref', ENABLED_PREF],
    queryFn: () => fetchUserPref<boolean>(ENABLED_PREF),
  });
  const enabled = enabledPref !== false;
  const toggle = useMutation({
    mutationFn: (next: boolean) => saveUserPref(ENABLED_PREF, next),
    onSuccess: () => {
      toastSaved();
      return qc.invalidateQueries({ queryKey: ['userPref', ENABLED_PREF] });
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });
  const entries = data?.entries ?? [];

  const remove = async (entry: UserMemoryEntry) => {
    if (!window.confirm(t('settings.memory.deleteConfirm', { title: entry.title }))) return;
    setError('');
    try {
      await deleteUserMemory(entry.id);
      toast('toasts.deleted');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeAll = async () => {
    if (!window.confirm(t('settings.memory.deleteAllConfirm', { count: entries.length }))) return;
    setError('');
    try {
      await deleteAllUserMemories();
      toast('toasts.deleted');
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const full = !!data && entries.length >= data.limits.entries;

  return (
    <Page>
      <Section title={t('settings.memory.title')}>
        {/* Not a Row hint: the dialog hides those, and who can see this matters. */}
        <p className="pb-1 text-[13px] leading-snug text-muted-foreground">{t('settings.memory.enabledHint')}</p>
        <Row label={t('settings.memory.enabled')}>
          <Switch
            checked={enabled}
            disabled={prefLoading || toggle.isPending}
            aria-label={t('settings.memory.enabled')}
            onCheckedChange={(next: boolean) => toggle.mutate(next)}
          />
        </Row>
        {toggle.error && <p role="alert" className="pb-2 text-xs text-destructive">{(toggle.error as Error).message}</p>}
      </Section>

      <Section
        title={data ? t('settings.memory.listTitle', { count: entries.length, limit: data.limits.entries }) : t('settings.memory.listTitleLoading')}
        action={
          entries.length > 0 ? (
            <Button variant="destructive-outline" size="sm" onClick={() => void removeAll()}>
              {t('settings.memory.deleteAll')}
            </Button>
          ) : undefined
        }
      >
        {isLoading && <p className="py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
        {isError && <p role="alert" className="py-6 text-center text-sm text-destructive">{t('settings.memory.loadFailed')}</p>}
        {error && <p role="alert" className="py-2 text-xs text-destructive">{error}</p>}
        {data && entries.length === 0 && editing !== 'new' && (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-[13px] text-muted-foreground">
            <BrainIcon className="size-5 opacity-60" />
            {t('settings.memory.empty')}
          </div>
        )}
        {data &&
          entries.map((entry) =>
            editing === entry.id ? (
              <MemoryEditor
                key={entry.id}
                initial={entry}
                limits={data.limits}
                onCancel={() => setEditing(null)}
                onSave={async (title, text) => {
                  await updateUserMemory(entry.id, title, text);
                  await refresh();
                  setEditing(null);
                }}
              />
            ) : (
              <MemoryRow
                key={entry.id}
                entry={entry}
                onEdit={() => setEditing(entry.id)}
                onDelete={() => void remove(entry)}
              />
            ),
          )}
        {data && editing === 'new' && (
          <MemoryEditor
            limits={data.limits}
            onCancel={() => setEditing(null)}
            onSave={async (title, text) => {
              await addUserMemory(title, text);
              await refresh();
              setEditing(null);
            }}
          />
        )}
        {data && editing !== 'new' && (
          <div className="border-t border-border/60 py-3">
            <Button variant="outline" size="sm" disabled={full} onClick={() => setEditing('new')}>
              <PlusIcon /> {t('settings.memory.add')}
            </Button>
            {full && <p className="mt-2 text-xs text-muted-foreground">{t('settings.memory.full')}</p>}
          </div>
        )}
      </Section>
    </Page>
  );
}
