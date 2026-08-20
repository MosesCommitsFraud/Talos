import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  DatabaseIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from 'lucide-react';
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
  const { data, isFetching } = useRagBases();
  const bases = data?.bases ?? [];
  const known = bases.some((b) => b.id === baseId);
  // Only fall back once the catalogue has settled. A base created a moment ago
  // is legitimately absent from the last response, and resetting on that stale
  // list would bounce the user out of the base they just made.
  const stale = isFetching || bases.length === 0;
  useEffect(() => {
    if (!stale && !known) setBaseId(DEFAULT_RAG_BASE);
  }, [stale, known, setBaseId]);
  const effective = known || stale ? baseId : DEFAULT_RAG_BASE;
  return { baseId: effective, base: bases.find((b) => b.id === effective), bases };
}

/** Compact base picker, for surfaces that act on one base but aren't the
 *  overview (the activity rail's context, mainly). */
export function RagBaseSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { data } = useRagBases();
  const bases = data?.bases ?? [];
  if (bases.length <= 1) return null;
  return (
    <Select
      className={cn('max-w-[16rem]', className)}
      size="sm"
      value={value}
      onChange={onChange}
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
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: RagBase | null;
  onCreated?: (base: RagBase) => void;
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
    onSuccess: async (base) => {
      // Refetch before navigating, not just invalidate: the target base has to
      // be in the catalogue by the time the workspace renders its header, or
      // it briefly shows the previously selected base's name.
      await queryClient.refetchQueries({ queryKey: ['rag-bases'] });
      onOpenChange(false);
      // Newly created bases are empty, so drop the user straight into them —
      // the next thing they want is to put something in.
      if (!editing && base?.id) onCreated?.(base);
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
            <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
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
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t('rag.bases.deleteAction')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One knowledge base as a card: what it holds, in which language, and how far
 *  its pipeline differs from the global defaults. */
function BaseCard({
  base,
  onOpen,
  onEdit,
  onDelete,
}: {
  base: RagBase;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isDefault = base.id === DEFAULT_RAG_BASE;
  const nonEmptyScopes = (base.scopes ?? []).filter((s) => s.content_count > 0);
  return (
    <div className="group flex flex-col overflow-hidden rounded-md border bg-card text-card-foreground transition-colors hover:border-ring/50">
      <button type="button" onClick={onOpen} className="flex-1 px-4 py-3.5 text-left">
        <span className="flex items-center gap-2">
          <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">
            {base.name}
          </span>
          {base.language && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground">
              {base.language}
            </span>
          )}
        </span>
        <span className="mt-1.5 line-clamp-2 block min-h-[2rem] text-xs text-muted-foreground/80">
          {base.description || t('rag.bases.noDescription')}
        </span>
        <span className="mt-2 block text-[11px] text-muted-foreground tabular-nums">
          {base.available === false
            ? (base.error ?? t('rag.bases.unavailable'))
            : t('rag.bases.counts', {
                docs: base.content_count ?? 0,
                chunks: base.chunk_count ?? 0,
              })}
        </span>
        {/* Sub-indexes are counted separately from the corpus above, so say so
            rather than letting the card look like it is missing documents. */}
        {nonEmptyScopes.length > 0 && (
          <span className="mt-1 block text-[11px] text-muted-foreground/80">
            {t('rag.scopes.plusMini', {
              names: nonEmptyScopes
                .map((s) => t(`rag.scopes.item.${s.id}.name`, s.name))
                .join(', '),
            })}
          </span>
        )}
      </button>
      <div className="flex items-center gap-1 border-t border-border/60 px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate px-1 font-mono text-[10px] text-muted-foreground">
          {base.id}
        </code>
        {isDefault && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            {t('rag.bases.defaultBadge')}
          </span>
        )}
        {(base.override_count ?? 0) > 0 && (
          <span
            className="shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] text-primary"
            title={t('rag.bases.overridesHint')}
          >
            <SlidersHorizontalIcon className="mr-1 inline size-2.5" />
            {base.override_count}
          </span>
        )}
        <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </Button>
        {!isDefault && (
          <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} onClick={onDelete}>
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The knowledge-base overview — its own space in the /rag workspace.
 *
 *  Deliberately separate from the pipeline settings: this answers "which
 *  knowledge bases exist and what is in them", while a base's own space
 *  answers "what is inside this one and how is it tuned".
 */
export function RagOverview({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useRagBases();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RagBase | null>(null);
  const [deleting, setDeleting] = useState<RagBase | null>(null);
  const bases = data?.bases ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-muted-foreground">{t('rag.overview.intro')}</p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <PlusIcon className="size-3.5" /> {t('rag.bases.new')}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {bases.map((b) => (
            <BaseCard
              key={b.id}
              base={b}
              onOpen={() => onOpen(b.id)}
              onEdit={() => {
                setEditing(b);
                setFormOpen(true);
              }}
              onDelete={() => setDeleting(b)}
            />
          ))}
        </div>
      )}

      <BaseFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onCreated={(b) => onOpen(b.id)}
      />
      <DeleteDialog base={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}
