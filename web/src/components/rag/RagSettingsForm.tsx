import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, InfoIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  fetchRagBaseConfig,
  fetchRagConfig,
  saveRagBaseConfig,
  saveRagConfig,
  testRagConfig,
  testRagEndpoint,
  type RagConfig,
  type RagLane,
  type RagLaneMode,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { useRagConsole } from '@/state/ragConsole';
import { useUi } from '@/state/ui';
import { Page, Section, Segmented } from '../SettingsDialog';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogSection } from '../ui/dialog';
import { Input, Switch, Textarea, Tooltip } from '../ui/misc';

interface EndpointTest {
  kind: string;
  modelKey?: keyof RagConfig;
  apiKeyKey?: keyof RagConfig;
  datasetKey?: keyof RagConfig;
}

/** The pipeline in the order data moves through it: what it talks to, how
 *  documents get in, how they come back out. */
type Tab = 'services' | 'ingest' | 'search';

/** Which fields live on which tab, so a base can show how many it overrides
 *  there without the user opening each tab to find out. */
const TAB_KEYS: Record<Tab, Array<keyof RagConfig>> = {
  services: [
    'embedding_url', 'embedding_model', 'rerank_url', 'rerank_model', 'rerank_api_key',
    'sparse_model', 'vlm_url', 'vlm_model', 'llm_url', 'llm_model', 'video_asr_url',
    'image_embed_url', 'image_embed_model',
  ],
  ingest: [
    'video_asr_mode', 'video_asr_language', 'video_asr_prompt', 'video_asr_correct_enabled',
    'video_frames_mode', 'video_frames_interval_sec', 'video_frames_max', 'pdf_vlm_mode',
    'caption_language', 'image_pixel_enabled', 'code_lane_mode', 'chunk_max_chars',
    'chunk_overlap_chars', 'embedding_tokenizer', 'embedding_max_tokens',
    'contextual_retrieval_enabled', 'auto_keywords_n', 'auto_questions_n', 'redact_pii_enabled',
  ],
  search: [
    'chat_top_k', 'search_top_k', 'candidate_top_k', 'rerank_min_score', 'similarity_threshold',
    'max_context_chars', 'auto_inject_enabled', 'query_rewrite_enabled',
    'expand_to_parent_enabled', 'parent_max_chars', 'context_window', 'query_prefix',
    'context_prompt',
  ],
};

/** The full explanation of a setting, on demand. Some of these run to several
 *  sentences, which is why they don't sit permanently in the form. */
function InfoHint({ text, def }: { text?: string; def?: string | number }) {
  const { t } = useTranslation();
  if (!text && (def === undefined || def === '')) return null;
  return (
    <Tooltip
      side="top"
      label={
        <span className="block max-w-sm space-y-1 py-0.5 leading-snug">
          {text && <span className="block">{text}</span>}
          {def !== undefined && def !== '' && (
            <span className="block text-muted-foreground">
              {t('settings.rag.defaultLabel')}:{' '}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">{String(def)}</code>
            </span>
          )}
        </span>
      }
    >
      <button
        type="button"
        aria-label={text}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        <InfoIcon className="size-3.5" />
      </button>
    </Tooltip>
  );
}

/** One optional capability: what it does in a sentence, its control on the
 *  right, and any settings of its own directly below while it is in use. */
function FeatureRow({
  label,
  note,
  hint,
  marker,
  control,
  status,
  dimmed,
  children,
}: {
  label: string;
  note: string;
  hint: string;
  marker?: ReactNode;
  control: ReactNode;
  status?: ReactNode;
  dimmed?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="border-t border-border/60 py-3 first:border-t-0">
      <div
        className={cn(
          'flex flex-col gap-2 @lg:flex-row @lg:items-start @lg:justify-between @lg:gap-6',
          dimmed && 'opacity-60',
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
            {label}
            <InfoHint text={hint} />
            {marker}
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{note}</p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1 @lg:items-end">
          {control}
          {status}
        </div>
      </div>
      {children && (
        <div className="mt-3 grid gap-3 border-l-2 border-border/60 pl-4 @lg:grid-cols-2">
          {children}
        </div>
      )}
    </div>
  );
}

/** One thing the pipeline connects to: name, who needs it, its address. */
function ServiceBlock({
  title,
  use,
  action,
  children,
}: {
  title: string;
  use: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border/60 py-4 first:border-t-0 first:pt-2">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{use}</p>
        </div>
        {action}
      </div>
      <div className="grid gap-3 @xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {children}
      </div>
    </div>
  );
}

/** The RAG pipeline settings form, in one of two modes.
 *
 *  Without `ragId` it edits the **global defaults** — the values every
 *  knowledge base inherits. With one, it edits that base's overrides: the same
 *  fields, with changed ones marked and resettable back to the global value.
 *  Infrastructure (provider, Qdrant, the external retrieval service) is
 *  global-only and hidden in base mode — there is one vector store, and
 *  pretending otherwise would let a settings mistake split the index in two.
 *
 *  Every endpoint lives on the Services tab, because several features share one
 *  (the vision model serves both documents and keyframes). The other tabs only
 *  decide what runs, so nothing has to be hunted down inside another feature.
 *
 *  Save and discard are rendered into `actionsEl`, the workspace header: that
 *  stays in place while the form scrolls, without covering any of it.
 */
export function RagSettingsForm({
  ragId,
  actionsEl,
}: {
  ragId?: string;
  actionsEl?: HTMLElement | null;
}) {
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
  // What the draft is compared against to decide whether there is anything to
  // save. Not `loaded`: secrets are never echoed back and the server normalizes
  // values, so a saved form would otherwise stay dirty forever.
  const [baseline, setBaseline] = useState<RagConfig | null>(null);
  // Keys handed back to the global defaults on the next save. Distinct from
  // "currently equal to global": a field can be reset while the visible value
  // still shows what it will inherit.
  const [inherit, setInherit] = useState<Set<string>>(new Set());
  const [overridden, setOverridden] = useState<Set<string>>(new Set());
  const [testingEp, setTestingEp] = useState<keyof RagConfig | null>(null);
  const [epResults, setEpResults] = useState<
    Partial<Record<keyof RagConfig, { ok: boolean; detail?: string }>>
  >({});
  // A base is usually opened to tune it; the global page to set up the services.
  const [tab, setTab] = useState<Tab>(ragId ? 'search' : 'services');

  // Which target the draft was seeded from. One effect seeds and re-seeds, so
  // a separate "clear on target change" effect can't clobber the seed in the
  // same commit — that deadlocked the form on its loading state whenever the
  // config was already cached when the form mounted.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const target = ragId ?? '';
  useEffect(() => {
    if (loaded && seededFor !== target) {
      setDraft(loaded);
      setBaseline(loaded);
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
    onSuccess: (_result, cfg) => {
      setBaseline(cfg);
      setInherit(new Set());
      void queryClient.invalidateQueries({ queryKey: ['rag-config'] });
      void queryClient.invalidateQueries({ queryKey: ['rag-base-config'] });
      void queryClient.invalidateQueries({ queryKey: ['rag-bases'] });
    },
  });
  const test = useMutation({ mutationFn: testRagConfig });

  const dirty =
    !!draft && (inherit.size > 0 || JSON.stringify(draft) !== JSON.stringify(baseline));

  // While there is something to lose, leaving waits for the user's answer. A
  // closing tab can't wait for this dialog, so it gets the browser's own prompt.
  const setLeaveGuard = useUi((s) => s.setLeaveGuard);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    setLeaveGuard((proceed) => setPendingLeave(() => proceed));
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      setLeaveGuard(null);
    };
  }, [dirty, setLeaveGuard]);

  if (!draft) {
    return (
      <Page className="p-0 sm:px-0">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </Page>
    );
  }

  const discard = () => {
    setDraft(baseline);
    setInherit(new Set());
    setOverridden(new Set(baseQuery.data?.overridden ?? []));
    save.reset();
  };

  const set = (k: keyof RagConfig, v: unknown) => {
    setDraft({ ...draft, [k]: v } as RagConfig);
    // A result describes the values it was run with, not the ones now showing.
    if (Object.keys(epResults).length) setEpResults({});
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

  const isOverride = (k: keyof RagConfig) => {
    if (!perBase || globalKeys.has(k as string)) return false;
    const key = k as string;
    return !(inherit.has(key) || (!overridden.has(key) && draft[k] === inheritedCfg?.[k]));
  };

  /** Marks a field this base changes, with a reset. Inherited is the normal
   *  case and stays unmarked, so the few real differences stand out. */
  const marker = (k: keyof RagConfig) => {
    if (!isOverride(k)) return undefined;
    return (
      <span className="inline-flex items-center gap-1">
        <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
          {t('rag.settings.overridden')}
        </span>
        <button
          type="button"
          onClick={() => resetToInherited(k)}
          title={t('rag.settings.resetField')}
          aria-label={t('rag.settings.resetField')}
          className="text-muted-foreground hover:text-foreground"
        >
          <RotateCcwIcon className="size-3" />
        </button>
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
      .then((r) => {
        setEpResults((prev) => ({ ...prev, [k]: { ok: true, detail: r.detail } }));
        pushConsole(
          `${label}: ${t('settings.rag.endpointOk')}${r.detail ? ` (${r.detail})` : ''}`,
          'ok',
        );
      })
      .catch((e) => {
        const detail = (e as Error).message;
        setEpResults((prev) => ({ ...prev, [k]: { ok: false, detail } }));
        pushConsole(`${label}: ${detail}`, 'error');
      })
      .finally(() => setTestingEp(null));
  };

  const testAction = (k: keyof RagConfig, label: string, ep: EndpointTest) => {
    const result = epResults[k];
    return (
      <div className="flex shrink-0 items-center gap-2">
        {result && (
          <span
            title={result.detail}
            className={cn(
              'inline-flex items-center gap-1 text-xs',
              result.ok ? 'text-success' : 'text-destructive-foreground',
            )}
          >
            {result.ok ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
            {t(result.ok ? 'settings.rag.ok' : 'settings.rag.testFailed')}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!str(k).trim() || testingEp !== null}
          onClick={() => testEndpoint(k, label, ep)}
        >
          {testingEp === k ? t('settings.rag.testing') : t('settings.rag.test')}
        </Button>
      </div>
    );
  };

  /** Probes the *saved* config, unlike the per-service buttons, so it is only
   *  offered once the form matches what would be tested. */
  const connectionTest = () => {
    const failed = test.isError || (test.isSuccess && test.data?.ok === false);
    return (
      <div className="flex items-center gap-2">
        {(test.isError || test.isSuccess) && (
          <span className={cn('text-xs', failed ? 'text-destructive-foreground' : 'text-success')}>
            {t(failed ? 'settings.rag.testFailed' : 'settings.rag.ok')}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={test.isPending || dirty}
          title={t('settings.rag.testSavedHint')}
          onClick={() => test.mutate()}
        >
          {test.isPending ? t('settings.rag.testing') : t('settings.rag.testConnection')}
        </Button>
      </div>
    );
  };

  const field = (
    k: keyof RagConfig,
    label: string,
    opts: { type?: string; hint?: string; def?: string | number; className?: string } = {},
  ) => {
    const type = opts.type ?? 'text';
    const id = `rag-${k as string}`;
    // Saved secrets never come back to the client, so the field alone can't
    // tell "nothing set" from "set and hidden".
    const secretSet = type === 'password' && !!loaded?.[`${k as string}_set` as keyof RagConfig];
    const placeholder = secretSet
      ? t('settings.rag.secretSet')
      : type === 'text' && opts.def
        ? String(opts.def)
        : undefined;
    return (
      <div key={k as string} className={cn('flex min-w-0 flex-col justify-end gap-1.5', opts.className)}>
        <div className="flex min-h-5 flex-wrap items-center gap-1.5 text-[13px] text-foreground">
          <label htmlFor={id}>{label}</label>
          <InfoHint text={opts.hint} def={opts.def} />
          {marker(k)}
        </div>
        {type === 'textarea' ? (
          <Textarea
            id={id}
            className="min-h-[64px]"
            value={String(draft[k] ?? '')}
            onChange={(e) => set(k, e.target.value)}
          />
        ) : (
          <Input
            id={id}
            type={type}
            step={type === 'number' ? 'any' : undefined}
            autoComplete={type === 'password' ? 'new-password' : undefined}
            placeholder={placeholder}
            value={String(draft[k] ?? '')}
            onChange={(e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value)}
          />
        )}
      </div>
    );
  };

  const toggle = (
    k: keyof RagConfig,
    label: string,
    note: string,
    hint: string,
    opts: { dflt?: boolean; children?: ReactNode } = {},
  ) => (
    <FeatureRow
      label={label}
      note={note}
      hint={hint}
      marker={marker(k)}
      control={
        <Switch
          aria-label={label}
          checked={draft[k] === undefined ? !!opts.dflt : !!draft[k]}
          onCheckedChange={(v) => set(k, v)}
        />
      }
    >
      {opts.children}
    </FeatureRow>
  );

  // Extraction lanes run in one of three modes; "auto" = as soon as the
  // endpoint the lane needs is configured. The status line under the mode
  // reports what the *saved* config does (the server also sees endpoints set
  // through the environment).
  const laneEndpoint: Record<RagLane, keyof RagConfig | null> = {
    video_asr: 'video_asr_url',
    pdf_vlm: 'vlm_url',
    video_frames: 'vlm_url',
    code_lane: null,
  };
  const laneModeOf = (lane: RagLane): RagLaneMode => {
    const raw = draft[`${lane}_mode` as keyof RagConfig] as RagLaneMode | undefined;
    if (raw === 'auto' || raw === 'on' || raw === 'off') return raw;
    return draft[`${lane}_enabled` as keyof RagConfig] ? 'on' : 'auto';
  };
  const laneActive = (lane: RagLane): boolean => {
    if (laneModeOf(lane) === 'off') return false;
    if (lane === 'video_frames' && !laneActive('video_asr')) return false;
    const key = laneEndpoint[lane];
    if (!key) return true;
    return !!String(draft[key] ?? '').trim() || !!loaded?.lanes?.[lane]?.active;
  };
  const laneStatus = (lane: RagLane) => {
    const saved = loaded?.lanes?.[lane];
    if (!saved) return undefined;
    if (saved.active || saved.mode === 'off') {
      return (
        <span className={cn('text-[11px] leading-tight', saved.active ? 'text-success' : 'text-muted-foreground')}>
          {t(saved.active ? 'settings.rag.laneRunning' : 'settings.rag.laneOff')}
        </span>
      );
    }
    const what = t(`settings.rag.laneNeeds.${saved.waiting_for}`, saved.waiting_for);
    const text = t('settings.rag.laneWaiting', { what });
    // A missing endpoint is fixed on another tab, so the line leads there.
    return saved.waiting_for.endsWith('_url') ? (
      <button
        type="button"
        onClick={() => setTab('services')}
        className="text-[11px] leading-tight text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {text}
      </button>
    ) : (
      <span className="text-[11px] leading-tight text-muted-foreground">{text}</span>
    );
  };
  const lane = (
    id: RagLane,
    label: string,
    note: string,
    hint: string,
    opts: { dimmed?: boolean; children?: ReactNode } = {},
  ) => {
    const key = `${id}_mode` as keyof RagConfig;
    return (
      <FeatureRow
        label={label}
        note={note}
        hint={hint}
        marker={marker(key)}
        dimmed={opts.dimmed}
        status={laneStatus(id)}
        control={
          <Segmented
            label={label}
            value={laneModeOf(id)}
            onChange={(v) => set(key, v)}
            options={[
              { value: 'auto', label: t('settings.rag.laneMode.auto') },
              { value: 'on', label: t('settings.rag.laneMode.on') },
              { value: 'off', label: t('settings.rag.laneMode.off') },
            ]}
          />
        }
      >
        {opts.children}
      </FeatureRow>
    );
  };

  const external = (draft.provider || 'internal') === 'external';
  const tabs: Tab[] = external ? ['services'] : ['services', 'ingest', 'search'];
  const shownTab = tabs.includes(tab) ? tab : tabs[0];
  const enriches =
    !!draft.contextual_retrieval_enabled ||
    (draft.auto_keywords_n || 0) > 0 ||
    (draft.auto_questions_n || 0) > 0;

  const servicesTab = !perBase && external ? (
    <Section title={t('settings.rag.group.external')} action={connectionTest()}>
      <ServiceBlock
        title={t('settings.rag.providerExternal')}
        use={t('settings.rag.hint.provider')}
        action={testAction('external_url', t('settings.rag.externalUrl'), {
          kind: 'external',
          apiKeyKey: 'external_api_key',
          datasetKey: 'external_dataset_id',
        })}
      >
        {field('external_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.externalUrl'), def: 'http://ragflow/api/v1/retrieval' })}
        {field('external_api_key', t('settings.rag.service.apiKey'), { type: 'password', hint: t('settings.rag.hint.externalApiKey') })}
        {field('external_dataset_id', t('settings.rag.externalDatasetId'), { hint: t('settings.rag.hint.externalDatasetId') })}
        {field('external_top_k', t('settings.rag.externalTopK'), { type: 'number', hint: t('settings.rag.hint.externalTopK'), def: 5 })}
      </ServiceBlock>
    </Section>
  ) : (
    <>
      <Section title={t('settings.rag.group.core')} action={!perBase ? connectionTest() : undefined}>
        <ServiceBlock
          title={t('settings.rag.service.embedding')}
          use={t('settings.rag.service.embeddingUse')}
          action={testAction('embedding_url', t('settings.rag.embeddingUrl'), { kind: 'embedding', modelKey: 'embedding_model' })}
        >
          {field('embedding_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.embeddingUrl'), def: 'http://host:8001/v1/embeddings' })}
          {field('embedding_model', t('settings.rag.service.model'), { hint: t('settings.rag.hint.embeddingModel'), def: 'qwen3-embed' })}
        </ServiceBlock>
        {!perBase && (
          <ServiceBlock
            title={t('settings.rag.service.qdrant')}
            use={t('settings.rag.service.qdrantUse')}
            action={testAction('qdrant_url', t('settings.rag.qdrantUrl'), { kind: 'qdrant', apiKeyKey: 'qdrant_api_key' })}
          >
            {field('qdrant_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.qdrantUrl'), def: 'http://qdrant:6333' })}
            {field('qdrant_api_key', t('settings.rag.service.apiKey'), { type: 'password', hint: t('settings.rag.hint.qdrantApiKey') })}
          </ServiceBlock>
        )}
        <ServiceBlock
          title={t('settings.rag.service.rerank')}
          use={t('settings.rag.service.rerankUse')}
          action={testAction('rerank_url', t('settings.rag.rerankUrl'), { kind: 'rerank', modelKey: 'rerank_model', apiKeyKey: 'rerank_api_key' })}
        >
          {field('rerank_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.rerankUrl'), def: 'http://host:8002/v1/rerank' })}
          {field('rerank_model', t('settings.rag.service.model'), { hint: t('settings.rag.hint.rerankModel'), def: 'qwen3-reranker' })}
          {field('rerank_api_key', t('settings.rag.service.apiKey'), { type: 'password', hint: t('settings.rag.hint.rerankApiKey') })}
        </ServiceBlock>
        <ServiceBlock title={t('settings.rag.sparseModel')} use={t('settings.rag.service.sparseUse')}>
          {field('sparse_model', t('settings.rag.service.model'), { hint: t('settings.rag.hint.sparseModel'), def: 'Qdrant/bm25' })}
        </ServiceBlock>
      </Section>
      {!external && (
        <Section title={t('settings.rag.group.optional')}>
          <ServiceBlock
            title={t('settings.rag.vlmModel')}
            use={t('settings.rag.service.vlmUse')}
            action={testAction('vlm_url', t('settings.rag.vlmUrl'), { kind: 'vlm', modelKey: 'vlm_model' })}
          >
            {field('vlm_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.vlmUrl'), def: 'http://host:8000/v1/chat/completions' })}
            {field('vlm_model', t('settings.rag.service.model'), { hint: t('settings.rag.hint.vlmModel'), def: 'qwen3-llm' })}
          </ServiceBlock>
          <ServiceBlock
            title={t('settings.rag.service.llm')}
            use={t('settings.rag.service.llmUse')}
            action={testAction('llm_url', t('settings.rag.llmUrl'), { kind: 'llm', modelKey: 'llm_model' })}
          >
            {field('llm_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.llmUrl'), def: 'http://host:8000/v1/chat/completions' })}
            {field('llm_model', t('settings.rag.service.model'), { hint: t('settings.rag.hint.llmModel'), def: 'qwen3-llm' })}
          </ServiceBlock>
          <ServiceBlock
            title={t('settings.rag.service.asr')}
            use={t('settings.rag.service.asrUse')}
            action={testAction('video_asr_url', t('settings.rag.asrUrl'), { kind: 'asr' })}
          >
            {field('video_asr_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.asrUrl'), def: 'http://host:8003/v1/audio/transcriptions' })}
          </ServiceBlock>
          <ServiceBlock
            title={t('settings.rag.service.image')}
            use={t('settings.rag.service.imageUse')}
            action={testAction('image_embed_url', t('settings.rag.imageUrl'), { kind: 'image_embed', modelKey: 'image_embed_model' })}
          >
            {field('image_embed_url', t('settings.rag.service.url'), { hint: t('settings.rag.hint.imageUrl'), def: 'http://host:8004/v1/embeddings' })}
            {field('image_embed_model', t('settings.rag.service.model'), { hint: t('settings.rag.hint.imageModel'), def: 'qwen3-vl-embed' })}
          </ServiceBlock>
        </Section>
      )}
    </>
  );

  const ingestTab = (
    <>
      <Section title={t('settings.rag.group.sources')}>
        {lane('video_asr', t('settings.rag.asrEnabled'), t('settings.rag.note.asr'), t('settings.rag.hint.asrEnabled'), {
          children: laneModeOf('video_asr') !== 'off' && (
            <>
              {field('video_asr_language', t('settings.rag.asrLanguage'), { hint: t('settings.rag.hint.asrLanguage'), def: 'auto' })}
              <div className="flex min-w-0 flex-col justify-end gap-1.5">
                <div className="flex min-h-5 flex-wrap items-center gap-1.5 text-[13px] text-foreground">
                  {t('settings.rag.asrCorrect')}
                  <InfoHint text={t('settings.rag.hint.asrCorrect')} />
                  {marker('video_asr_correct_enabled')}
                </div>
                <div className="flex h-8 items-center">
                  <Switch
                    aria-label={t('settings.rag.asrCorrect')}
                    checked={!!draft.video_asr_correct_enabled}
                    onCheckedChange={(v) => set('video_asr_correct_enabled', v)}
                  />
                </div>
              </div>
              {field('video_asr_prompt', t('settings.rag.asrPrompt'), { type: 'textarea', hint: t('settings.rag.hint.asrPrompt'), className: '@lg:col-span-2' })}
            </>
          ),
        })}
        {lane('video_frames', t('settings.rag.videoFramesEnabled'), t('settings.rag.note.frames'), t('settings.rag.hint.videoFramesEnabled'), {
          dimmed: laneModeOf('video_asr') === 'off',
          children: laneActive('video_frames') && (
            <>
              {field('video_frames_interval_sec', t('settings.rag.videoFramesInterval'), { type: 'number', hint: t('settings.rag.hint.videoFramesInterval'), def: 8 })}
              {field('video_frames_max', t('settings.rag.videoFramesMax'), { type: 'number', hint: t('settings.rag.hint.videoFramesMax'), def: 300 })}
            </>
          ),
        })}
        {lane('pdf_vlm', t('settings.rag.pdfVlmEnabled'), t('settings.rag.note.vision'), t('settings.rag.hint.pdfVlmEnabled'), {
          children: laneModeOf('pdf_vlm') !== 'off' && (
            field('caption_language', t('settings.rag.captionLanguage'), { hint: t('settings.rag.hint.captionLanguage') })
          ),
        })}
        {toggle('image_pixel_enabled', t('settings.rag.imageEnabled'), t('settings.rag.note.image'), t('settings.rag.hint.imageEnabled'))}
        {lane('code_lane', t('settings.rag.codeEnabled'), t('settings.rag.note.code'), t('settings.rag.hint.codeEnabled'))}
      </Section>

      <Section title={t('settings.rag.group.chunking')}>
        <div className="grid gap-3 pt-2 @lg:grid-cols-2">
          {field('chunk_max_chars', t('settings.rag.chunkMaxChars'), { type: 'number', hint: t('settings.rag.hint.chunkMaxChars'), def: 6000 })}
          {field('chunk_overlap_chars', t('settings.rag.chunkOverlapChars'), { type: 'number', hint: t('settings.rag.hint.chunkOverlapChars'), def: 200 })}
          {field('embedding_tokenizer', t('settings.rag.embeddingTokenizer'), { hint: t('settings.rag.hint.embeddingTokenizer') })}
          {field('embedding_max_tokens', t('settings.rag.embeddingMaxTokens'), { type: 'number', hint: t('settings.rag.hint.embeddingMaxTokens'), def: 0 })}
        </div>
      </Section>

      <Section title={t('settings.rag.group.enrichment')}>
        {toggle('contextual_retrieval_enabled', t('settings.rag.contextualEnabled'), t('settings.rag.note.contextual'), t('settings.rag.hint.contextualEnabled'))}
        <div className="grid gap-3 border-t border-border/60 pt-3 @lg:grid-cols-2">
          {field('auto_keywords_n', t('settings.rag.autoKeywords'), { type: 'number', hint: t('settings.rag.hint.autoKeywords'), def: 0 })}
          {field('auto_questions_n', t('settings.rag.autoQuestions'), { type: 'number', hint: t('settings.rag.hint.autoQuestions'), def: 0 })}
        </div>
        {enriches && !str('llm_url').trim() && (
          <button
            type="button"
            onClick={() => setTab('services')}
            className="mt-2 text-left text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {t('settings.rag.note.needsLlm')}
          </button>
        )}
      </Section>

      <Section title={t('settings.rag.group.privacy')}>
        {toggle('redact_pii_enabled', t('settings.rag.redactEnabled'), t('settings.rag.note.redact'), t('settings.rag.hint.redactEnabled'))}
      </Section>
    </>
  );

  const searchTab = (
    <>
      <Section title={t('settings.rag.group.results')}>
        <div className="grid grid-cols-2 gap-3 pt-2 @lg:grid-cols-3">
          {field('chat_top_k', t('settings.rag.chatTopK'), { type: 'number', hint: t('settings.rag.hint.chatTopK'), def: 5 })}
          {field('search_top_k', t('settings.rag.searchTopK'), { type: 'number', hint: t('settings.rag.hint.searchTopK'), def: 5 })}
          {field('candidate_top_k', t('settings.rag.candidateTopK'), { type: 'number', hint: t('settings.rag.hint.candidateTopK'), def: 20 })}
          {field('rerank_min_score', t('settings.rag.rerankMinScore'), { type: 'number', hint: t('settings.rag.hint.rerankMinScore'), def: 0.3 })}
          {field('similarity_threshold', t('settings.rag.similarityThreshold'), { type: 'number', hint: t('settings.rag.hint.similarityThreshold'), def: 0 })}
          {field('max_context_chars', t('settings.rag.maxContextChars'), { type: 'number', hint: t('settings.rag.hint.maxContextChars'), def: 18000 })}
        </div>
      </Section>

      <Section title={t('settings.rag.group.behavior')}>
        {toggle('auto_inject_enabled', t('settings.rag.autoInjectEnabled'), t('settings.rag.note.autoInject'), t('settings.rag.hint.autoInjectEnabled'), { dflt: true })}
        {toggle('query_rewrite_enabled', t('settings.rag.queryRewriteEnabled'), t('settings.rag.note.rewrite'), t('settings.rag.hint.queryRewriteEnabled'))}
        {toggle('expand_to_parent_enabled', t('settings.rag.expandToParent'), t('settings.rag.note.expand'), t('settings.rag.hint.expandToParent'), {
          children: draft.expand_to_parent_enabled && (
            <>
              {field('parent_max_chars', t('settings.rag.parentMaxChars'), { type: 'number', hint: t('settings.rag.hint.parentMaxChars'), def: 12000 })}
              {field('context_window', t('settings.rag.contextWindow'), { type: 'number', hint: t('settings.rag.hint.contextWindow'), def: 1 })}
            </>
          ),
        })}
      </Section>

      <Section title={t('settings.rag.group.prompts')}>
        <div className="grid gap-3 pt-2">
          {field('query_prefix', t('settings.rag.queryPrefix'), { type: 'textarea', hint: t('settings.rag.hint.queryPrefix') })}
          {field('context_prompt', t('settings.rag.contextPrompt'), { type: 'textarea', hint: t('settings.rag.hint.contextPrompt') })}
        </div>
      </Section>
    </>
  );

  const actions = (
    <>
      {save.isError && (
        <span
          role="alert"
          title={(save.error as Error).message}
          className="max-w-56 truncate text-xs text-destructive-foreground"
        >
          {(save.error as Error).message}
        </span>
      )}
      {save.isSuccess && !dirty && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" /> {t('settings.rag.saved')}
        </span>
      )}
      {dirty && (
        <Button size="sm" variant="ghost" disabled={save.isPending} onClick={discard}>
          {t('settings.rag.discard')}
        </Button>
      )}
      <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
        {save.isPending ? t('common.saving') : t('common.save')}
      </Button>
    </>
  );

  return (
    <Page className="@container gap-6 p-0 sm:px-0">
      {actionsEl && createPortal(actions, actionsEl)}

      <Dialog
        open={!!pendingLeave}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setPendingLeave(null);
        }}
      >
        <DialogContent
          className="w-[min(440px,92vw)]"
          title={t('settings.rag.leaveTitle')}
          description={t('settings.rag.leaveText')}
        >
          <DialogSection className="flex flex-col gap-3">
            {save.isError && (
              <p role="alert" className="text-xs text-destructive-foreground">
                {(save.error as Error).message}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => setPendingLeave(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() => {
                  discard();
                  pendingLeave?.();
                  setPendingLeave(null);
                }}
              >
                {t('settings.rag.leaveDiscard')}
              </Button>
              <Button
                size="sm"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(draft, {
                    onSuccess: () => {
                      pendingLeave?.();
                      setPendingLeave(null);
                    },
                  })
                }
              >
                {save.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </DialogSection>
        </DialogContent>
      </Dialog>

      {perBase ? (
        <p className="text-[13px] leading-snug text-muted-foreground">{t('rag.settings.baseIntro')}</p>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 px-4 py-3 @xl:flex-row @xl:items-center @xl:justify-between">
          <div className="flex items-center gap-2.5 text-sm text-foreground">
            <Switch
              aria-label={t('settings.rag.ragEnabled')}
              checked={draft.enabled}
              onCheckedChange={(v) => set('enabled', v)}
            />
            {t('settings.rag.ragEnabled')}
            <InfoHint text={t('settings.rag.hint.enabled')} />
          </div>
          <div className="flex flex-wrap items-center gap-2.5 text-sm text-foreground">
            <span className="inline-flex items-center gap-1.5">
              {t('settings.rag.provider')}
              <InfoHint text={t('settings.rag.hint.provider')} />
            </span>
            <Segmented
              label={t('settings.rag.provider')}
              value={draft.provider || 'internal'}
              onChange={(v) => set('provider', v)}
              options={[
                { value: 'internal', label: t('settings.rag.providerInternal') },
                { value: 'external', label: t('settings.rag.providerExternal') },
              ]}
            />
          </div>
        </div>
      )}

      {tabs.length > 1 && (
        <div role="tablist" className="flex gap-5 border-b border-border/60">
          {tabs.map((k) => {
            const count = perBase ? TAB_KEYS[k].filter(isOverride).length : 0;
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={shownTab === k}
                onClick={() => setTab(k)}
                className={cn(
                  '-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-sm transition-colors',
                  shownTab === k
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`settings.rag.tabs.${k}`)}
                {count > 0 && (
                  <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {shownTab === 'services' && servicesTab}
      {shownTab === 'ingest' && ingestTab}
      {shownTab === 'search' && searchTab}
    </Page>
  );
}
