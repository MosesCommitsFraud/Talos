import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, DatabaseIcon, RefreshCwIcon, UploadCloudIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { personalUpload, ragRebuildIndex } from '@/api/client';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { RagPanel } from '../SettingsDialog';

/** Full-screen knowledge-base workspace (deep-linked at `#/rag`). Replaces the
 *  cramped admin-Settings RAG panel: a prominent "drop anything" zone and an
 *  index-rebuild control sit above the existing pipeline/queue/library panel,
 *  which is reused verbatim so current behavior is unchanged. */
export function RagWorkspace() {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const refreshIngest = () => {
    void queryClient.invalidateQueries({ queryKey: ['rag-jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
  };

  const upload = useMutation({
    mutationFn: (files: File[]) => personalUpload(files),
    onSuccess: (_r, files) => {
      setMsg({ text: t('rag.uploadQueued', { count: files.length }), ok: true });
      refreshIngest();
    },
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });

  const rebuild = useMutation({
    mutationFn: ragRebuildIndex,
    onSuccess: (r) => {
      setMsg({ text: r.message || t('rag.rebuildDone'), ok: true });
      refreshIngest();
    },
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) upload.mutate(files);
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-5 py-3 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setView('chat')}
          aria-label={t('rag.backToChat')}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <DatabaseIcon className="size-5 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">{t('rag.title')}</h1>
          <p className="truncate text-xs text-muted-foreground">{t('rag.subtitle')}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={rebuild.isPending}
          onClick={() => rebuild.mutate()}
        >
          <RefreshCwIcon className={cn(rebuild.isPending && 'animate-spin')} /> {t('rag.rebuildIndex')}
        </Button>
      </header>

      <div className="mx-auto w-full max-w-3xl p-5">
        {/* Big "einfach reindroppen" target. */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
            dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-ring/60 hover:bg-accent/30',
          )}
        >
          <UploadCloudIcon className="size-7 text-muted-foreground" />
          <div className="text-sm font-medium">{t('rag.dropTitle')}</div>
          <div className="text-xs text-muted-foreground">{t('rag.dropHint')}</div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) upload.mutate(Array.from(e.target.files));
              e.target.value = '';
            }}
          />
        </div>
        {msg && (
          <p className={cn('mt-2 text-xs', msg.ok ? 'text-success' : 'text-destructive-foreground')}>
            {msg.text}
          </p>
        )}

        {/* The existing pipeline config + ingest queue + indexed-docs + search
            playground, reused unchanged so current behavior is preserved. */}
        <RagPanel />
      </div>
    </main>
  );
}
