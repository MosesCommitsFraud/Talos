import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, DatabaseIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createRagBase,
  deleteRagBase,
  fetchRagBases,
  updateRagBase,
  type RagBase,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { DEFAULT_RAG_BASE, useRagBase } from '@/state/ragBase';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Input, Textarea } from '../ui/misc';
import { Select } from '../ui/select';

/** Shared query for the knowledge-base catalogue. Counts come from Qdrant and
 *  are cached server-side for 30s, so polling here is cheap; the interval keeps
 *  the document tallies moving while an ingest job runs. */
export function useRagBases() {
  return useQuery({ queryKey: ['rag-bases'], queryFn: fetchRagBases, refetchInterval: 10000 });
}

/** Resolve the persisted selection against what actually exists.
 *
 *  A base can be deleted from another tab (or by the outward REST service), so
 *  the stored id is a hint, not a guarantee — falling back to the default base
 *  beats rendering every panel against a 404. */
export function useActiveRagBase(): { baseId: string; base?: RagBase; bases: RagBase[] } {
  const { baseId, setBaseId } = useRagBase();
  const { data } = useRagBases();
  const bases = data?.bases ?? [];
  const known = bases.some((b) => b.id === baseId);
  useEffect(() => {
    if (bases.length > 0 && !known) setBaseId(DEFAULT_RAG_BASE);
  }, [bases.length, known, setBaseId]);
  const effective = known || bases.length === 0 ? baseId : DEFAULT_RAG_BASE;
  return { baseId: effective, base: bases.find((b) => b.id === effective), bases };
}

/** Compact base picker for the workspace header — everything below it (docs,
 *  uploads, explorer, search) is scoped to whatever is selected here. */
export function RagBaseSelect({ className }: { className?: string }) {
  const { t } = useTranslation();
  const setBaseId = useRagBase((s) => s.setBaseId);
  const { baseId, bases } = useActiveRagBase();
  if (bases.length <= 1) return null;
  return (
    <Select
      className={cn('max-w-[16rem]', className)}
      size="sm"
      value={baseId}
      onChange={setBaseId}
      options={bases.map((b) => ({
        value: b.id,
        label:
          b.content_count == null
            ? b.name
            : `${b.name} · ${t('rag.bases.docCount', { n: b.content_count })}`,
      }))}
    />
  );
}

interface FormState {
  id: string;
  name: string;
  description: string;
  language: string;
}

const EMPTY: FormState = { id: '', name: '', description: '', language: '' };

/** Create/edit form. `editing` is the base being changed, or null for a new one
 *  — the id field only appears for new bases, since it is immutable afterwards
 *  (external callers address bases by it). */
function BaseFormDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: RagBase | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setError('');
    setForm(
      editing
        ? {
            id: editing.id,
            name: editing.name,
            description: editing.description,
            language: editing.language,
          }
        : EMPTY,
    );
  }, [open, editing]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? updateRagBase(editing.id, {
            name: form.name,
            description: form.description,
            language: form.language,
          })
        : createRagBase({
            name: form.name,
            description: form.description,
            language: form.language,
            id: form.id.trim() || undefined,
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rag-bases'] });
      onOpenChange(false);
    },
    onError: (e) => setError((e as Error).message),
  });

  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={editing ? t('rag.bases.editTitle') : t('rag.bases.newTitle')}
        className="w-[min(520px,92vw)]"
      >
        <div className="space-y-4 px-5 py-4">
          <label className="block space-y-1.5">
            <span className="text-[13px] font-semibold">{t('rag.bases.name')}</span>
            <Input
              autoFocus
              value={form.name}
              placeholder={t('rag.bases.namePlaceholder')}
              onChange={(e) => set('name', e.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[13px] font-semibold">{t('rag.bases.description')}</span>
            <Textarea
              className="min-h-[72px] w-full"
              value={form.description}
              placeholder={t('rag.bases.descriptionPlaceholder')}
              onChange={(e) => set('description', e.target.value)}
            />
            <span className="block text-xs text-muted-foreground/80">
              {t('rag.bases.descriptionHint')}
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-[13px] font-semibold">{t('rag.bases.language')}</span>
              <Input
                value={form.language}
                placeholder="de"
                onChange={(e) => set('language', e.target.value)}
              />
            </label>
            {!editing && (
              <label className="block space-y-1.5">
                <span className="text-[13px] font-semibold">{t('rag.bases.id')}</span>
                <Input
                  value={form.id}
                  placeholder={t('rag.bases.idPlaceholder')}
                  onChange={(e) => set('id', e.target.value)}
                />
              </label>
            )}
          </div>
          {editing && (
            <p className="text-xs text-muted-foreground/80">
              {t('rag.bases.idFixed', { id: editing.id })}
            </p>
          )}
          {error && <p className="text-xs text-destructive-foreground">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!form.name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  base,
  onOpenChange,
}: {
  base: RagBase | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setBaseId = useRagBase((s) => s.setBaseId);
  const [error, setError] = useState('');
  const remove = useMutation({
    mutationFn: () => deleteRagBase(base!.id, true),
    onSuccess: () => {
      setBaseId(DEFAULT_RAG_BASE);
      void queryClient.invalidateQueries({ queryKey: ['rag-bases'] });
      void queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
      onOpenChange(false);
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <Dialog open={!!base} onOpenChange={onOpenChange}>
      <DialogContent title={t('rag.bases.deleteTitle')} className="w-[min(480px,92vw)]">
        <div className="space-y-5 px-5 py-4">
          <div className="flex gap-3 rounded-md border border-destructive/25 bg-destructive/5 p-3.5">
            <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-destructive-foreground" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('rag.bases.deleteConfirm', { name: base?.name ?? '' })}
            </p>
          </div>
          {error && <p className="text-xs text-destructive-foreground">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('rag.bases.deleteAction')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One row in the catalogue. Clicking it makes that base the active one for the
 *  whole workspace; the buttons edit or delete it. */
function BaseRow({
  base,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  base: RagBase;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isDefault = base.id === DEFAULT_RAG_BASE;
  return (
    <div
      className={cn(
        'flex items-start gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5',
        active && 'bg-accent/40',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <DatabaseIcon
          className={cn('mt-0.5 size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold tracking-[-0.01em]">{base.name}</span>
            {base.language && (
              <span className="rounded bg-muted px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground">
                {base.language}
              </span>
            )}
            {isDefault && (
              <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                {t('rag.bases.defaultBadge')}
              </span>
            )}
          </span>
          {base.description && (
            <span className="block truncate text-xs text-muted-foreground/80">
              {base.description}
            </span>
          )}
          <span className="block text-[11px] text-muted-foreground tabular-nums">
            {base.available === false
              ? (base.error ?? t('rag.bases.unavailable'))
              : t('rag.bases.counts', {
                  docs: base.content_count ?? 0,
                  chunks: base.chunk_count ?? 0,
                })}
            {' · '}
            <code className="font-mono text-[10px]">{base.id}</code>
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon" variant="ghost" aria-label={t('common.edit')} onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </Button>
        {!isDefault && (
          <Button size="icon" variant="ghost" aria-label={t('common.delete')} onClick={onDelete}>
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The knowledge-base catalogue: which bases exist, what is in them, and the
 *  create/edit/delete actions. Rendered at the top of the /rag workspace, since
 *  every panel under it is scoped to the base selected here. */
export function RagBases() {
  const { t } = useTranslation();
  const setBaseId = useRagBase((s) => s.setBaseId);
  const { baseId, bases } = useActiveRagBase();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RagBase | null>(null);
  const [deleting, setDeleting] = useState<RagBase | null>(null);

  return (
    <section className="space-y-2.5">
      <header className="flex min-h-5 items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-foreground/50 uppercase">
          <span className="inline-block h-px w-3 bg-border" aria-hidden="true" />
          {t('rag.bases.title')}
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <PlusIcon className="size-3.5" /> {t('rag.bases.new')}
        </Button>
      </header>
      <div className="overflow-hidden rounded-md border bg-card text-card-foreground">
        {bases.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">{t('common.loading')}</p>
        ) : (
          bases.map((b) => (
            <BaseRow
              key={b.id}
              base={b}
              active={b.id === baseId}
              onSelect={() => setBaseId(b.id)}
              onEdit={() => {
                setEditing(b);
                setFormOpen(true);
              }}
              onDelete={() => setDeleting(b)}
            />
          ))
        )}
      </div>
      <p className="px-1 text-xs text-muted-foreground/80">{t('rag.bases.hint')}</p>

      <BaseFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <DeleteDialog base={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </section>
  );
}
