import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpenIcon, RefreshCwIcon, UploadCloudIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelRagJob,
  clearRagJobs,
  deleteRagJob,
  fetchRagJobs,
  fetchRagWorkerDiag,
  personalUpload,
  ragRebuildIndex,
  type RagJob,
} from '@/api/client';
import { cn } from '@/lib/utils';
import { useRagConsole } from '@/state/ragConsole';
import { Button } from '../ui/button';
import { RagExplorer } from './RagExplorer';

const TERMINAL = ['completed', 'failed', 'cancelled'];

/** Progress for one job: a real % bar when an upload total is known, an
 *  indeterminate shimmer while a directory ingest runs, full when terminal. */
function JobProgress({ j }: { j: RagJob }) {
  const total = j.total_count ?? 0;
  const done = j.processed_count ?? 0;
  const subTotal = j.sub_total ?? 0;
  const subFrac = subTotal > 0 ? Math.min(1, (j.sub_done ?? 0) / subTotal) : 0;
  const terminal = TERMINAL.includes(j.status);
  // Blend the current file's page/image fraction into the file-level bar so a
  // single multi-page VLM ingest visibly advances instead of sitting at 0%.
  const pct = terminal
    ? 100
    : total > 0
      ? Math.min(100, Math.round(((done + subFrac) / total) * 100))
      : subTotal > 0
        ? Math.round(subFrac * 100)
        : null;
  const tone =
    j.status === 'failed'
      ? 'bg-destructive'
      : j.status === 'cancelled'
        ? 'bg-muted-foreground'
        : j.failed_count > 0
          ? 'bg-amber-500'
          : 'bg-primary';
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', tone, pct == null && 'w-1/3 animate-pulse')}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/** Right-hand activity rail for the /rag workspace: the drop zone, an index
 *  rebuild, live worker/queue status with per-item progress, and an error
 *  console — pinned so it stays put while the settings column scrolls. */
export function RagActivity() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);

  const jobs = useQuery({ queryKey: ['rag-jobs'], queryFn: fetchRagJobs, refetchInterval: 1500 });
  const diag = useQuery({ queryKey: ['rag-worker-diag'], queryFn: fetchRagWorkerDiag, refetchInterval: 5000 });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['rag-jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
  };

  const upload = useMutation({
    mutationFn: (files: File[]) => personalUpload(files),
    onSuccess: (r, files) => {
      const failed = Number((r as { failed_count?: number })?.failed_count ?? 0);
      const errs = (r as { errors?: string[] })?.errors;
      if (failed > 0) {
        setMsg({ text: Array.isArray(errs) && errs.length ? errs.join('; ') : t('rag.uploadFailed', { count: failed }), ok: false });
      } else {
        setMsg({ text: t('rag.uploadQueued', { count: files.length }), ok: true });
      }
      refresh();
    },
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });
  const rebuild = useMutation({
    mutationFn: ragRebuildIndex,
    onSuccess: (r) => { setMsg({ text: r.message || t('rag.rebuildDone'), ok: true }); refresh(); },
    onError: (e) => setMsg({ text: (e as Error).message, ok: false }),
  });

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) upload.mutate(files);
  };

  const list = jobs.data?.jobs ?? [];
  const workerCount = diag.data?.active_worker_count ?? 0;
  const testLines = useRagConsole((s) => s.lines);
  // Console = a no-worker banner, endpoint-test results (newest first, green
  // when OK), then every job error, newest first.
  const consoleLines: { key: string; text: string; warn?: boolean; ok?: boolean }[] = [];
  if (diag.data && workerCount === 0) consoleLines.push({ key: 'no-worker', text: t('settings.rag.noWorker'), warn: true });
  for (const l of testLines) {
    consoleLines.push({ key: `test-${l.id}`, text: l.text, ok: l.tone === 'ok' });
  }
  for (const j of list) {
    for (const [i, e] of (j.errors ?? []).entries()) {
      consoleLines.push({ key: `${j.id}-${i}`, text: `${e.file}: ${e.error}` });
    }
  }

  return (
    <aside className="sticky top-0 flex h-[100dvh] w-[22rem] shrink-0 flex-col gap-3 border-l bg-background/60 p-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
        className={cn(
          'flex shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-ring/60 hover:bg-accent/30',
        )}
      >
        <UploadCloudIcon className="size-6 text-muted-foreground" />
        <div className="text-sm font-medium">{t('rag.dropTitle')}</div>
        <div className="text-[11px] text-muted-foreground">{t('rag.dropHint')}</div>
        <input ref={fileInput} type="file" multiple hidden
          onChange={(e) => { if (e.target.files?.length) upload.mutate(Array.from(e.target.files)); e.target.value = ''; }} />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setExplorerOpen(true)}>
          <FolderOpenIcon /> {t('rag.explorer.open')}
        </Button>
        <Button size="sm" variant="outline" disabled={rebuild.isPending} onClick={() => { if (window.confirm(t('rag.rebuildConfirm'))) rebuild.mutate(); }}>
          <RefreshCwIcon className={cn(rebuild.isPending && 'animate-spin')} /> {t('rag.rebuildIndex')}
        </Button>
        <span className={cn('ml-auto inline-flex items-center gap-1.5 text-[11px]', workerCount === 0 ? 'text-destructive-foreground' : 'text-muted-foreground')}>
          <span className={cn('size-1.5 rounded-full', workerCount === 0 ? 'bg-destructive' : 'bg-success')} />
          {t('rag.workersActive', { n: workerCount })}
        </span>
      </div>
      {msg && <p className={cn('shrink-0 text-[11px]', msg.ok ? 'text-success' : 'text-destructive-foreground')}>{msg.text}</p>}

      {/* Queue */}
      <div className="flex min-h-0 flex-[2] flex-col">
        <div className="flex items-center justify-between px-0.5 pb-1.5">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-foreground/50 uppercase">{t('rag.queue')}</span>
          {list.some((j) => TERMINAL.includes(j.status)) && (
            <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => void clearRagJobs().then(refresh)}>
              {t('settings.rag.clearJobs')}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
          {list.length === 0 ? (
            <p className="px-0.5 text-[11px] text-muted-foreground">{t('settings.rag.queueEmpty')}</p>
          ) : (
            list.map((j) => {
              const terminal = TERMINAL.includes(j.status);
              const name = j.current_file ? j.current_file.split('/').pop() : (j.directory || j.message);
              const total = j.total_count ?? 0;
              return (
                <div key={j.id} className="rounded-lg border border-border/60 px-2.5 py-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium shrink-0">{t(`settings.rag.status.${j.status}`, j.status)}</span>
                    <span className={cn('min-w-0 flex-1 truncate', j.status === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground')} title={j.message}>
                      {name}
                    </span>
                    <button
                      className="shrink-0 text-muted-foreground hover:text-destructive-foreground"
                      onClick={() => void (terminal ? deleteRagJob(j.id) : cancelRagJob(j.id)).then(refresh)}
                    >
                      {t(terminal ? 'common.delete' : 'common.cancel')}
                    </button>
                  </div>
                  <JobProgress j={j} />
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
                    {total > 0 && <span>{t('rag.filesProgress', { done: j.processed_count ?? 0, total })}</span>}
                    {(j.sub_total ?? 0) > 0 && !TERMINAL.includes(j.status) && (
                      <span>{t('rag.subProgress', { done: j.sub_done ?? 0, total: j.sub_total })}</span>
                    )}
                    {j.indexed_count > 0 && <span>{t('settings.rag.chunksIndexed', { n: j.indexed_count })}</span>}
                    {j.failed_count > 0 && <span className="text-destructive-foreground">{t('settings.rag.failedN', { n: j.failed_count })}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Error console */}
      <div className="flex min-h-0 flex-1 flex-col">
        <span className="px-0.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-foreground/50 uppercase">{t('rag.console')}</span>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
          {consoleLines.length === 0 ? (
            <span className="text-muted-foreground">{t('rag.consoleEmpty')}</span>
          ) : (
            consoleLines.map((l) => (
              <div key={l.key} className={cn('whitespace-pre-wrap break-words', l.ok ? 'text-success' : l.warn ? 'text-amber-600 dark:text-amber-400' : 'text-destructive-foreground')}>
                {l.text}
              </div>
            ))
          )}
        </div>
      </div>

      <RagExplorer open={explorerOpen} onOpenChange={setExplorerOpen} />
    </aside>
  );
}
