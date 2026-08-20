import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BoxesIcon, FileTextIcon, FolderOpenIcon, SearchIcon, UploadCloudIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteRagDocument,
  fetchRagDocuments,
  personalAddDirectory,
  personalReload,
  personalUpload,
  ragSearch,
  type RagDocument,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { ragIdParam } from '@/state/ragBase';
import { Page, Row, Section } from '../SettingsDialog';
import { Button } from '../ui/button';
import { Input } from '../ui/misc';
import { Select } from '../ui/select';
import { RagExplorer } from './RagExplorer';

interface SearchHit {
  filename?: string;
  modality?: string;
  similarity?: number | null;
  rerank_score?: number | null;
  snippet?: string;
}

/** "What is in this knowledge base": add content, see every indexed document,
 *  and try a retrieval against it.
 *
 *  This is the working surface of the /rag management area — the settings for
 *  the same base live on their own tab, so filling a base and tuning it never
 *  compete for the same screen.
 */
export function RagContent({ baseId }: { baseId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const ragId = ragIdParam(baseId);
  const fileInput = useRef<HTMLInputElement>(null);

  const [dir, setDir] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [uploadRedact, setUploadRedact] = useState<boolean | null>(null);
  const [searchQ, setSearchQ] = useState('');
  const [searchK, setSearchK] = useState(5);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchErr, setSearchErr] = useState('');
  const [explorerOpen, setExplorerOpen] = useState(false);

  const docs = useQuery({
    queryKey: ['rag-documents', baseId],
    queryFn: () => fetchRagDocuments(ragId),
    refetchInterval: 5000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['rag-jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
    void queryClient.invalidateQueries({ queryKey: ['rag-bases'] });
  };

  const run = (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    fn()
      .then(() => {
        setMsg({ text: ok, ok: true });
        refresh();
      })
      .catch((e) => setMsg({ text: (e as Error).message, ok: false }));
  };

  const remove = useMutation({
    mutationFn: (source: string) => deleteRagDocument(source, ragId),
    onSuccess: refresh,
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });

  const search = () => {
    setSearchErr('');
    setHits(null);
    void ragSearch(searchQ, searchK, ragId)
      .then((r) => setHits(((r as { results?: SearchHit[] }).results ?? []) as SearchHit[]))
      .catch((e) => setSearchErr((e as Error).message));
  };

  const list: RagDocument[] = docs.data?.documents ?? [];

  return (
    <Page className="gap-5 p-0">
      <Section title={t('rag.content.add')} padded>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              <UploadCloudIcon className="size-3.5" /> {t('settings.rag.uploadFiles')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) {
                  run(
                    () =>
                      personalUpload(Array.from(e.target.files!), {
                        redactPii: uploadRedact,
                        ragId,
                      }),
                    t('settings.rag.uploadQueued'),
                  );
                }
                e.target.value = '';
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => run(personalReload, t('settings.rag.reindexStarted'))}
            >
              {t('settings.rag.reloadIndex')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setExplorerOpen(true)}>
              <FolderOpenIcon className="size-3.5" /> {t('rag.explorer.open')}
            </Button>
          </div>

          <Row label={t('settings.rag.uploadRedact')} stacked>
            <Select
              className="w-44 text-xs"
              value={uploadRedact === null ? 'default' : uploadRedact ? 'on' : 'off'}
              onChange={(v) => setUploadRedact(v === 'default' ? null : v === 'on')}
              options={[
                { value: 'default', label: t('settings.rag.uploadRedactDefault') },
                { value: 'on', label: t('settings.rag.uploadRedactOn') },
                { value: 'off', label: t('settings.rag.uploadRedactOff') },
              ]}
            />
          </Row>

          <div className="flex gap-2">
            <Input
              placeholder={t('settings.rag.addDirectory')}
              value={dir}
              onChange={(e) => setDir(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!dir.trim()}
              onClick={() =>
                run(() => personalAddDirectory(dir, ragId), t('settings.rag.directoryAdded'))
              }
            >
              {t('common.add')}
            </Button>
          </div>
          {msg && (
            <p className={cn('text-xs', msg.ok ? 'text-success' : 'text-destructive-foreground')}>
              {msg.text}
            </p>
          )}
        </div>
      </Section>

      <Section
        title={t('settings.rag.indexedDocs')}
        action={
          list.length > 0 ? (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {t('settings.rag.docCount', { n: list.length })}
            </span>
          ) : undefined
        }
        padded
      >
        {docs.data && docs.data.available === false ? (
          <p className="text-xs text-destructive-foreground">
            {docs.data.error || t('settings.rag.ragUnavailable')}
          </p>
        ) : list.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('rag.content.empty')}</p>
        ) : (
          <div className="space-y-1">
            {list.map((d) => (
              <div
                key={d.source}
                className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-xs"
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate" title={d.source}>
                  {d.filename}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {t('settings.rag.chunksN', { n: d.chunks })}
                </span>
                <button
                  className="shrink-0 text-muted-foreground hover:text-destructive-foreground"
                  onClick={() => remove.mutate(d.source)}
                >
                  {t('common.delete')}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Purpose-bound sub-indexes. Listed apart from the corpus above, and
          read-only: they belong to the feature that fills them, and deleting
          one from here would silently break that feature. */}
      {(docs.data?.scopes ?? []).length > 0 && (
        <Section title={t('rag.scopes.title')} padded>
          <p className="pb-2 text-xs text-muted-foreground/80">{t('rag.scopes.intro')}</p>
          <div className="space-y-2">
            {(docs.data?.scopes ?? []).map((s) => (
              <div key={s.id} className="rounded-lg border border-border/60 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <BoxesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  {/* Server-side catalogue is English; fall back to it when a
                      locale has no wording of its own for this scope. */}
                  <span className="text-[13px] font-semibold">
                    {t(`rag.scopes.item.${s.id}.name`, s.name)}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                    {t('rag.scopes.badge')}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {s.content_count === 0
                      ? t('rag.scopes.empty')
                      : t('rag.bases.counts', {
                          docs: s.content_count,
                          chunks: s.chunk_count,
                        })}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground/80">
                  {t(`rag.scopes.item.${s.id}.purpose`, s.purpose)}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('rag.scopes.managedAt', {
                    where: t(`rag.scopes.where.${s.managed_at}`, s.managed_at),
                  })}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={t('rag.content.tryRetrieval')} padded>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder={t('settings.rag.testSearch')}
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQ.trim()) search();
              }}
            />
            <Input
              type="number"
              className="w-16"
              value={searchK}
              onChange={(e) => setSearchK(Number(e.target.value) || 5)}
            />
            <Button size="sm" variant="outline" disabled={!searchQ.trim()} onClick={search}>
              <SearchIcon className="size-3.5" /> {t('settings.rag.search')}
            </Button>
          </div>
          {searchErr && <p className="text-xs text-destructive-foreground">{searchErr}</p>}
          {/* Rendered as rows rather than raw JSON: this is the view an admin
              uses to judge retrieval quality, so the score and the passage
              have to be readable at a glance. */}
          {hits && hits.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('rag.content.noHits')}</p>
          )}
          {hits && hits.length > 0 && (
            <div className="space-y-1.5">
              {hits.map((h, i) => (
                <div key={i} className="rounded-lg border border-border/60 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="min-w-0 truncate font-medium">{h.filename || '—'}</span>
                    {h.modality && h.modality !== 'text' && (
                      <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                        {h.modality}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                      {(h.rerank_score ?? h.similarity ?? 0).toFixed(4)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">
                    {h.snippet}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      <RagExplorer open={explorerOpen} onOpenChange={setExplorerOpen} />
    </Page>
  );
}
