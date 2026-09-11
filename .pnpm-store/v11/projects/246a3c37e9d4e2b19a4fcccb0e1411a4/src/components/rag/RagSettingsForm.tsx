import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, RotateCcwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchRagBaseConfig,
  fetchRagConfig,
  saveRagBaseConfig,
  saveRagConfig,
  testRagConfig,
  testRagEndpoint,
  type RagConfig,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { useRagConsole } from '@/state/ragConsole';
import { Page, Row, Section } from '../SettingsDialog';
import { Button } from '../ui/button';
import { Input, Switch, Textarea } from '../ui/misc';
import { Select } from '../ui/select';

interface EndpointTest {
  kind: string;
  modelKey?: keyof RagConfig;
  apiKeyKey?: keyof RagConfig;
  datasetKey?: keyof RagConfig;
}

/** Compact disclosure for optional processing lanes. The feature state remains
 *  visible without rendering every explanatory row at once. */
function RagDisclosure({
  title,
  enabled,
  children,
}: {
  title: string;
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border/60 bg-background/40',
        open && 'sm:col-span-2',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronRightIcon
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        {enabled !== undefined && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              enabled ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
            )}
          >
            {t(enabled ? 'settings.rag.active' : 'settings.rag.inactive')}
          </span>
        )}
      </button>
      {open && <div className="border-t border-border/60">{children}</div>}
    </div>
  );
}

/** The RAG pipeline settings form, in one of two modes.
 *
 *  Without `ragId` it edits the **global defaults** — the values every
 *  knowledge base inherits. With one, it edits that base's overrides: the same
 *  fields, each marked inherited or changed, with a reset that hands a field
 *  back to the global value. Infrastructure (provider, Qdrant, the external
 *  retrieval service) is global-only and hidden in base mode — there is one
 *  vector store, and pretending otherwise would let a settings mistake split
 *  the index in two.
 */
export function RagSettingsForm({ ragId }: { ragId?: string }) {
  const { t } = useTranslation();
  const perBase = !!ragId;
  const queryClient = useQueryClient();
  const pushConsole = useRagConsole((s) => s.push);

  const globalQuery = useQuery({
    queryKey: ['rag-config'],
    queryFn: fetchRagConfig,
    enabled: !perBase,
  });
  const baseQuery = useQuery({
    queryKey: ['rag-base-config', ragId],
    queryFn: () => fetchRagBaseConfig(ragId as string),
    enabled: perBase,
  });

  const loaded = perBase ? baseQuery.data?.config : globalQuery.data;
  const inheritedCfg = baseQuery.data?.inherited;
  const globalKeys = new Set(baseQuery.data?.global_keys ?? []);

  const [draft, setDraft] = useState<RagConfig | null>(null);
  // Keys handed back to the global defaults on the next save. Distinct from
  // "currently equal to global": a field can be reset while the visible value
  // still shows what it will inherit.
  const [inherit, setInherit] = useState<Set<string>>(new Set());
  const [overridden, setOverridden] = useState<Set<string>>(new Set());
  const [testingEp, setTestingEp] = useState<keyof RagConfig | null>(null);

  // Which target the draft was seeded from. One effect seeds and re-seeds, so
  // a separate "clear on target change" effect can't clobber the seed in the
  // same commit — that deadlocked the form on its loading state whenever the
  // config was already cached when the form mounted.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const target = ragId ?? '';
  useEffect(() => {
    if (loaded && seededFor !== target) {
      setDraft(loaded);
      setSeededFor(target);
      setInherit(new Set());
    }
  }, [loaded, seededFor, target]);
  useEffect(() => {
    if (baseQuery.data) setOverridden(new Set(baseQuery.data.overridden));
  }, [baseQuery.data]);

  const save = useMutation({
    mutationFn: (cfg: RagConfig) =>
      perBase
        ? saveRagBaseConfig(ragId as string, cfg, [...inherit])
        : saveRagConfig(cfg).then(() => undefined),
    onSuccess: () => {
      setInherit(new Set());
      void queryClient.invalidateQueries({ queryKey: ['rag-config'] });
      void queryClient.invalidateQueries({ queryKey: ['rag-base-config'] });
      void queryClient.invalidateQueries({ queryKey: ['rag-bases'] });
    },
  });
  const test = useMutation({ mutationFn: testRagConfig });

  if (!draft) {
    return (
      <Page>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </Page>
    );
  }

  const set = (k: keyof RagConfig, v: unknown) => {
    setDraft({ ...draft, [k]: v } as RagConfig);
    // Touching a field cancels a pending reset for it — otherwise the save
    // would silently discard the edit the user just made.
    if (inherit.has(k as string)) {
      const next = new Set(inherit);
      next.delete(k as string);
      setInherit(next);
    }
  };
  const str = (k: keyof RagConfig) => String(draft[k] ?? '');

  const resetToInherited = (k: keyof RagConfig) => {
    if (!inheritedCfg) return;
    setDraft({ ...draft, [k]: inheritedCfg[k] } as RagConfig);
    setInherit(new Set(inherit).add(k as string));
    const next = new Set(overridden);
    next.delete(k as string);
    setOverridden(next);
  };

  /** Inherited/changed marker + reset, shown next to each field in base mode. */
  const marker = (k: keyof RagConfig) => {
    if (!perBase || globalKeys.has(k as string)) return undefined;
    const key = k as string;
    const isInherited =
      inherit.has(key) || (!overridden.has(key) && draft[k] === inheritedCfg?.[k]);
    return (
      <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
        <span
          className={cn(
            'rounded-full px-1.5 py-px text-[10px] font-medium',
            isInherited ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
          )}
        >
          {t(isInherited ? 'rag.settings.inherited' : 'rag.settings.overridden')}
        </span>
        {!isInherited && (
          <button
            type="button"
            onClick={() => resetToInherited(k)}
            title={t('rag.settings.resetField')}
            aria-label={t('rag.settings.resetField')}
            className="text-muted-foreground hover:text-foreground"
          >
            <RotateCcwIcon className="size-3" />
          </button>
        )}
      </span>
    );
  };

  const testEndpoint = (k: keyof RagConfig, label: string, ep: EndpointTest) => {
    setTestingEp(k);
    testRagEndpoint({
      kind: ep.kind,
      url: str(k),
      model: ep.modelKey ? str(ep.modelKey) : undefined,
      api_key: ep.apiKeyKey ? str(ep.apiKeyKey) : undefined,
      dataset_id: ep.datasetKey ? str(ep.datasetKey) : undefined,
    })
      .then((r) =>
        pushConsole(
          `${label}: ${t('settings.rag.endpointOk')}${r.detail ? ` (${r.detail})` : ''}`,
          'ok',
        ),
      )
      .catch((e) => pushConsole(`${label}: ${(e as Error).message}`, 'error'))
      .finally(() => setTestingEp(null));
  };

  const field = (
    k: keyof RagConfig,
    label: string,
    opts: { type?: string; hint?: string; def?: string | number; test?: EndpointTest } = {},
  ) => {
    const type = opts.type ?? 'text';
    const hint =
      opts.hint || opts.def !== undefined ? (
        <>
          {opts.hint}
          {opts.def !== undefined && (
            <>
              {opts.hint ? ' · ' : ''}
              {t('settings.rag.defaultLabel')}:{' '}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">
                {String(opts.def) || '—'}
              </code>
            </>
          )}
        </>
      ) : undefined;
    return (
      <Row
        label={
          <>
            {label}
            {marker(k)}
          </>
        }
        hint={hint}
        stacked
      >
        {type === 'textarea' ? (
          <Textarea
            className="min-h-[64px] w-full xl:w-56"
            value={String(draft[k] ?? '')}
            onChange={(e) => set(k, e.target.value)}
          />
        ) : (
          <div
            className={cn(
              'flex w-full gap-2 xl:w-auto',
              opts.test ? 'flex-col items-stretch xl:flex-row xl:items-center' : 'items-center',
            )}
          >
            <Input
              className="min-w-0 flex-1 xl:w-48 xl:flex-none"
              type={type}
              step={type === 'number' ? 'any' : undefined}
              value={String(draft[k] ?? '')}
              onChange={(e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value)}
            />
            {opts.test && (
              <Button
                className="self-end xl:self-auto"
                size="sm"
                variant="outline"
                disabled={!str(k).trim() || testingEp !== null}
                onClick={() => testEndpoint(k, label, opts.test!)}
              >
                {testingEp === k ? t('settings.rag.testing') : t('settings.rag.test')}
              </Button>
            )}
          </div>
        )}
      </Row>
    );
  };

  const toggle = (k: keyof RagConfig, label: string, hint: string, dflt = false) => (
    <Row
      label={
        <>
          {label}
          {marker(k)}
        </>
      }
      hint={hint}
    >
      <Switch
        checked={draft[k] === undefined ? dflt : !!draft[k]}
        onCheckedChange={(v) => set(k, v)}
      />
    </Row>
  );

  const external = (draft.provider || 'internal') === 'external';

  return (
    <Page className="gap-5 p-0 [&_.settings-row-hint]:line-clamp-2 [&_.settings-row-hint:hover]:line-clamp-none">
      {perBase && (
        <p className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          {t('rag.settings.baseIntro')}
        </p>
      )}

      <Section title={t('settings.rag.pipeline')}>
        {!perBase && (
          <>
            <Row label={t('settings.rag.ragEnabled')} hint={t('settings.rag.hint.enabled')}>
              <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
            </Row>
            <Row label={t('settings.rag.provider')} hint={t('settings.rag.hint.provider')} stacked>
              <Select
                className="w-full xl:w-48"
                value={draft.provider || 'internal'}
                onChange={(v) => set('provider', v)}
                options={[
                  { value: 'internal', label: t('settings.rag.providerInternal') },
                  { value: 'external', label: t('settings.rag.providerExternal') },
                ]}
              />
            </Row>
          </>
        )}
        {!perBase && external ? (
          <>
            {field('external_url', t('settings.rag.externalUrl'), { hint: t('settings.rag.hint.externalUrl'), def: 'http://ragflow/api/v1/retrieval', test: { kind: 'external', apiKeyKey: 'external_api_key', datasetKey: 'external_dataset_id' } })}
            {field('external_api_key', t('settings.rag.externalApiKey'), { type: 'password', hint: t('settings.rag.hint.externalApiKey') })}
            {field('external_dataset_id', t('settings.rag.externalDatasetId'), { hint: t('settings.rag.hint.externalDatasetId') })}
            {field('external_top_k', t('settings.rag.externalTopK'), { type: 'number', hint: t('settings.rag.hint.externalTopK'), def: 5 })}
          </>
        ) : (
          <>
            {field('embedding_url', t('settings.rag.embeddingUrl'), { hint: t('settings.rag.hint.embeddingUrl'), def: 'http://host:8001/v1/embeddings', test: { kind: 'embedding', modelKey: 'embedding_model' } })}
            {field('embedding_model', t('settings.rag.embeddingModel'), { hint: t('settings.rag.hint.embeddingModel'), def: 'qwen3-embed' })}
            {!perBase && field('qdrant_url', t('settings.rag.qdrantUrl'), { hint: t('settings.rag.hint.qdrantUrl'), def: 'http://qdrant:6333', test: { kind: 'qdrant', apiKeyKey: 'qdrant_api_key' } })}
            {!perBase && field('qdrant_api_key', t('settings.rag.qdrantApiKey'), { type: 'password', hint: t('settings.rag.hint.qdrantApiKey') })}
            {field('rerank_url', t('settings.rag.rerankUrl'), { hint: t('settings.rag.hint.rerankUrl'), def: 'http://host:8002/v1/rerank', test: { kind: 'rerank', modelKey: 'rerank_model', apiKeyKey: 'rerank_api_key' } })}
            {field('rerank_model', t('settings.rag.rerankModel'), { hint: t('settings.rag.hint.rerankModel'), def: 'qwen3-reranker' })}
            {field('rerank_api_key', t('settings.rag.rerankApiKey'), { type: 'password', hint: t('settings.rag.hint.rerankApiKey') })}
            {field('sparse_model', t('settings.rag.sparseModel'), { hint: t('settings.rag.hint.sparseModel'), def: 'Qdrant/bm25' })}
          </>
        )}
      </Section>

      {!external && (
        <Section title={t('settings.rag.searchTuning')}>
          {field('chat_top_k', t('settings.rag.chatTopK'), { type: 'number', hint: t('settings.rag.hint.chatTopK'), def: 5 })}
          {field('search_top_k', t('settings.rag.searchTopK'), { type: 'number', hint: t('settings.rag.hint.searchTopK'), def: 5 })}
          {field('candidate_top_k', t('settings.rag.candidateTopK'), { type: 'number', hint: t('settings.rag.hint.candidateTopK'), def: 40 })}
          {field('rerank_min_score', t('settings.rag.rerankMinScore'), { type: 'number', hint: t('settings.rag.hint.rerankMinScore'), def: 0.3 })}
          {field('similarity_threshold', t('settings.rag.similarityThreshold'), { type: 'number', hint: t('settings.rag.hint.similarityThreshold'), def: 0 })}
          {field('max_context_chars', t('settings.rag.maxContextChars'), { type: 'number', hint: t('settings.rag.hint.maxContextChars'), def: 10000 })}
          {field('query_prefix', t('settings.rag.queryPrefix'), { type: 'textarea', hint: t('settings.rag.hint.queryPrefix'), def: '' })}
          {field('context_prompt', t('settings.rag.contextPrompt'), { type: 'textarea', hint: t('settings.rag.hint.contextPrompt'), def: '' })}
          {toggle('auto_inject_enabled', t('settings.rag.autoInjectEnabled'), t('settings.rag.hint.autoInjectEnabled'), true)}
        </Section>
      )}

      {!external && (
        <Section title={t('settings.rag.processing')} padded>
          <div className="grid gap-2 sm:grid-cols-2">
            <RagDisclosure title={t('settings.rag.asrTitle')} enabled={!!draft.video_asr_enabled}>
              {toggle('video_asr_enabled', t('settings.rag.asrEnabled'), t('settings.rag.hint.asrEnabled'))}
              {draft.video_asr_enabled && (
                <>
                  {field('video_asr_url', t('settings.rag.asrUrl'), { hint: t('settings.rag.hint.asrUrl'), def: 'http://host:8003/v1/audio/transcriptions', test: { kind: 'asr' } })}
                  {field('video_asr_language', t('settings.rag.asrLanguage'), { hint: t('settings.rag.hint.asrLanguage'), def: 'auto' })}
                  {field('video_asr_prompt', t('settings.rag.asrPrompt'), { type: 'textarea', hint: t('settings.rag.hint.asrPrompt') })}
                  {toggle('video_asr_correct_enabled', t('settings.rag.asrCorrect'), t('settings.rag.hint.asrCorrect'))}
                  {toggle('video_frames_enabled', t('settings.rag.videoFramesEnabled'), t('settings.rag.hint.videoFramesEnabled'))}
                  {draft.video_frames_enabled && (
                    <>
                      {field('video_frames_interval_sec', t('settings.rag.videoFramesInterval'), { type: 'number', hint: t('settings.rag.hint.videoFramesInterval'), def: 8 })}
                      {field('video_frames_max', t('settings.rag.videoFramesMax'), { type: 'number', hint: t('settings.rag.hint.videoFramesMax'), def: 300 })}
                    </>
                  )}
                </>
              )}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.imageTitle')} enabled={!!draft.image_pixel_enabled}>
              {toggle('image_pixel_enabled', t('settings.rag.imageEnabled'), t('settings.rag.hint.imageEnabled'))}
              {draft.image_pixel_enabled && (
                <>
                  {field('image_embed_url', t('settings.rag.imageUrl'), { hint: t('settings.rag.hint.imageUrl'), def: 'http://host:8004/v1/embeddings', test: { kind: 'image_embed', modelKey: 'image_embed_model' } })}
                  {field('image_embed_model', t('settings.rag.imageModel'), { hint: t('settings.rag.hint.imageModel'), def: 'qwen3-vl-embed' })}
                </>
              )}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.codeTitle')} enabled={!!draft.code_lane_enabled}>
              {toggle('code_lane_enabled', t('settings.rag.codeEnabled'), t('settings.rag.hint.codeEnabled'))}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.queryTitle')} enabled={!!draft.query_rewrite_enabled}>
              {toggle('query_rewrite_enabled', t('settings.rag.queryRewriteEnabled'), t('settings.rag.hint.queryRewriteEnabled'))}
            </RagDisclosure>
            <RagDisclosure
              title={t('settings.rag.contextualTitle')}
              enabled={!!draft.contextual_retrieval_enabled || (draft.auto_keywords_n || 0) > 0 || (draft.auto_questions_n || 0) > 0}
            >
              {toggle('contextual_retrieval_enabled', t('settings.rag.contextualEnabled'), t('settings.rag.hint.contextualEnabled'))}
              {field('auto_keywords_n', t('settings.rag.autoKeywords'), { type: 'number', hint: t('settings.rag.hint.autoKeywords'), def: 0 })}
              {field('auto_questions_n', t('settings.rag.autoQuestions'), { type: 'number', hint: t('settings.rag.hint.autoQuestions'), def: 0 })}
              {(draft.contextual_retrieval_enabled || (draft.auto_keywords_n || 0) > 0 || (draft.auto_questions_n || 0) > 0) && (
                <>
                  {field('llm_url', t('settings.rag.llmUrl'), { hint: t('settings.rag.hint.llmUrl'), def: 'http://host:8000/v1/chat/completions', test: { kind: 'llm', modelKey: 'llm_model' } })}
                  {field('llm_model', t('settings.rag.llmModel'), { hint: t('settings.rag.hint.llmModel'), def: 'qwen3-llm' })}
                </>
              )}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.parentTitle')} enabled={!!draft.expand_to_parent_enabled}>
              {toggle('expand_to_parent_enabled', t('settings.rag.expandToParent'), t('settings.rag.hint.expandToParent'))}
              {draft.expand_to_parent_enabled && field('parent_max_chars', t('settings.rag.parentMaxChars'), { type: 'number', hint: t('settings.rag.hint.parentMaxChars'), def: 2000 })}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.pdfVlmTitle')} enabled={!!draft.pdf_vlm_enabled}>
              {toggle('pdf_vlm_enabled', t('settings.rag.pdfVlmEnabled'), t('settings.rag.hint.pdfVlmEnabled'))}
              {draft.pdf_vlm_enabled && (
                <>
                  {field('vlm_url', t('settings.rag.vlmUrl'), { hint: t('settings.rag.hint.vlmUrl'), def: 'http://host:8000/v1/chat/completions', test: { kind: 'vlm', modelKey: 'vlm_model' } })}
                  {field('vlm_model', t('settings.rag.vlmModel'), { hint: t('settings.rag.hint.vlmModel'), def: 'qwen3-llm' })}
                  {field('caption_language', t('settings.rag.captionLanguage'), { hint: t('settings.rag.hint.captionLanguage'), def: '' })}
                </>
              )}
            </RagDisclosure>
            <RagDisclosure title={t('settings.rag.redactTitle')} enabled={!!draft.redact_pii_enabled}>
              {toggle('redact_pii_enabled', t('settings.rag.redactEnabled'), t('settings.rag.hint.redactEnabled'))}
            </RagDisclosure>
          </div>
        </Section>
      )}

      {/* Pinned so a long form never hides the save button. */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-3">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
        {!perBase && (
          <Button
            size="sm"
            variant="outline"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t('settings.rag.testing') : t('settings.rag.testConnection')}
          </Button>
        )}
        {save.isError && (
          <span className="text-xs text-destructive-foreground">
            {(save.error as Error).message}
          </span>
        )}
        {test.isSuccess && (
          <span
            className={cn(
              'text-xs',
              test.data?.ok === false ? 'text-destructive-foreground' : 'text-success',
            )}
          >
            {test.data?.ok === false ? t('settings.rag.testFailed') : t('settings.rag.ok')}
          </span>
        )}
      </div>
    </Page>
  );
}
