import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BracesIcon, FileTextIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteRagChunk,
  fetchRagChunks,
  fetchRagDocuments,
  type RagChunk,
  updateRagChunk,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { Markdown } from '../Markdown';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Input, Textarea } from '../ui/misc';

/** One chunk: rendered markdown by default, switches to a textarea editor that
 *  re-embeds the chunk in place on save. */
function ChunkCard({ source, chunk }: { source: string; chunk: RagChunk }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [draft, setDraft] = useState(chunk.content);

  // Re-sync when the underlying chunk changes (e.g. after a save refetch).
  useEffect(() => { if (!editing) setDraft(chunk.content); }, [chunk.content, editing]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rag-chunks', source] });
  const save = useMutation({
    mutationFn: () => updateRagChunk(source, chunk.id, draft),
    onSuccess: () => { setEditing(false); void invalidate(); },
  });
  const remove = useMutation({
    mutationFn: () => deleteRagChunk(source, chunk.id),
    onSuccess: () => { void invalidate(); void queryClient.invalidateQueries({ queryKey: ['rag-documents'] }); },
  });

  const badges = [
    chunk.language && `${chunk.language}`,
    chunk.symbol && `${chunk.symbol}`,
    chunk.modality && chunk.modality !== 'text' && chunk.modality,
    chunk.section_id && `§ ${chunk.section_id.slice(0, 8)}`,
  ].filter(Boolean) as string[];

  return (
    <div className="rounded-lg border border-border/60">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">#{chunk.seq}</span>
        {badges.map((b) => (
          <span key={b} className="rounded bg-muted px-1.5 py-0.5 font-mono">{b}</span>
        ))}
        <span className="ml-auto tabular-nums">{t('rag.explorer.chars', { n: chunk.content.length })}</span>
        <button
          type="button"
          aria-label={t('rag.explorer.rawMeta')}
          title={t('rag.explorer.rawMeta')}
          onClick={() => setShowMeta((v) => !v)}
          className={cn('hover:text-foreground', showMeta ? 'text-foreground' : 'text-muted-foreground')}
        >
          <BracesIcon className="size-3.5" />
        </button>
        {!editing && (
          <>
            <button
              type="button"
              aria-label={t('rag.explorer.edit')}
              title={t('rag.explorer.edit')}
              onClick={() => { setDraft(chunk.content); setEditing(true); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <PencilIcon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('rag.explorer.deleteChunk')}
              title={t('rag.explorer.deleteChunk')}
              disabled={remove.isPending}
              onClick={() => { if (window.confirm(t('rag.explorer.deleteConfirm'))) remove.mutate(); }}
              className="text-muted-foreground hover:text-destructive-foreground disabled:opacity-50"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </>
        )}
      </div>

      {showMeta && (
        <pre className="overflow-x-auto border-b bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
          {JSON.stringify({ id: chunk.id, ...chunk.metadata }, null, 2)}
        </pre>
      )}

      {/* Ingest enrichment that's embedded but never shown in citations — useful
          to see while debugging recall. */}
      {(chunk.context || chunk.aux_terms) && !editing && (
        <div className="space-y-1 border-b bg-muted/30 px-3 py-1.5 text-[11px]">
          {chunk.context && (
            <div><span className="font-semibold text-muted-foreground">{t('rag.explorer.context')}: </span>{chunk.context}</div>
          )}
          {chunk.aux_terms && (
            <div className="whitespace-pre-wrap"><span className="font-semibold text-muted-foreground">{t('rag.explorer.auxTerms')}: </span>{chunk.aux_terms}</div>
          )}
        </div>
      )}

      {editing ? (
        <div className="space-y-2 p-3">
          <Textarea
            className="min-h-[160px] font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">{t('rag.explorer.editHint')}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={save.isPending || !draft.trim() || draft === chunk.content} onClick={() => save.mutate()}>
              {save.isPending ? t('rag.explorer.saving') : t('rag.explorer.saveReembed')}
            </Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); setDraft(chunk.content); }}>
              {t('common.cancel')}
            </Button>
            {save.isError && <span className="text-[11px] text-destructive-foreground">{(save.error as Error).message}</span>}
          </div>
        </div>
      ) : (
        <div className="px-3 py-2 text-sm">
          <Markdown text={chunk.content} />
        </div>
      )}
    </div>
  );
}

/** Full file list + chunk inspector for the /rag workspace. Opens from the
 *  activity rail. Read shows the exact text stored in Qdrant; editing re-embeds
 *  a single chunk in place. */
export function RagExplorer({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const docs = useQuery({ queryKey: ['rag-documents'], queryFn: fetchRagDocuments, enabled: open });
  const chunks = useQuery({
    queryKey: ['rag-chunks', selected],
    queryFn: () => fetchRagChunks(selected as string),
    enabled: open && !!selected,
  });

  const docList = docs.data?.documents ?? [];
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? docList.filter((d) => d.filename.toLowerCase().includes(q) || d.source.toLowerCase().includes(q))
    : docList;
  const selectedDoc = docList.find((d) => d.source === selected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('rag.explorer.title')}
        className="h-[85vh] w-[min(1100px,95vw)] max-h-[85vh]"
      >
        <div className="flex h-full min-h-0">
          {/* File list */}
          <div className="flex w-72 shrink-0 flex-col border-r">
            <div className="border-b px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-foreground/50 uppercase">
              {t('rag.explorer.files', { n: q ? filtered.length : docList.length })}
            </div>
            <div className="border-b p-1.5">
              <Input
                className="h-7 text-xs"
                placeholder={t('rag.explorer.searchFiles')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {docs.data && docs.data.available === false ? (
                <p className="px-2 py-2 text-xs text-destructive-foreground">{docs.data.error || t('settings.rag.ragUnavailable')}</p>
              ) : docList.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">{t('settings.rag.noDocs')}</p>
              ) : filtered.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">{t('rag.explorer.noMatches')}</p>
              ) : (
                filtered.map((d) => (
                  <button
                    key={d.source}
                    type="button"
                    onClick={() => setSelected(d.source)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                      d.source === selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    <FileTextIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={d.source}>{d.filename}</span>
                    <span className="shrink-0 tabular-nums opacity-70">{d.chunks}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Chunk inspector */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('rag.explorer.pickFile')}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b px-4 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={selected}>{selectedDoc?.filename ?? selected}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {t('settings.rag.chunksN', { n: chunks.data?.chunks?.length ?? selectedDoc?.chunks ?? 0 })}
                  </span>
                  <button
                    type="button"
                    aria-label={t('common.refresh')}
                    title={t('common.refresh')}
                    onClick={() => void chunks.refetch()}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <RotateCcwIcon className={cn('size-3.5', chunks.isFetching && 'animate-spin')} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                  {chunks.isLoading ? (
                    <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                  ) : (chunks.data?.chunks?.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('rag.explorer.noChunks')}</p>
                  ) : (
                    chunks.data!.chunks.map((c) => <ChunkCard key={c.id} source={selected} chunk={c} />)
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
