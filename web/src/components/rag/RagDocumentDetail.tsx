import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, DownloadIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchRagDocumentDetail,
  ragDocumentOriginalUrl,
  reindexRagDocument,
  restoreRagDocumentVersion,
} from '@/api/client';
import { cn, copyTextToClipboard, timestampMs } from '@/lib/utils';
import { Button } from '../ui/button';

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(value: number | null | undefined): string {
  const ms = timestampMs(value ?? null);
  return ms > 0 ? new Date(ms).toLocaleString() : '—';
}

/** Monospace value with a copy button — ids and hashes are meant to be
 *  compared and pasted (tickets, logs, the external API), not just read. */
function CopyValue({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 font-mono text-[11px] break-all">{value}</code>
      <button
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={t('common.copy', 'Copy')}
        onClick={() => {
          void copyTextToClipboard(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Everything the document register knows about one document: its stable
 *  id, content hash, how it was processed, and its version history. */
export function RagDocumentDetail({ docId, ragId }: { docId: string; ragId?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const detail = useQuery({
    queryKey: ['rag-document-detail', ragId ?? '', docId],
    queryFn: () => fetchRagDocumentDetail(docId, ragId),
    refetchInterval: 5000,
  });

  const done = (text: string) => {
    setMsg({ text, ok: true });
    void queryClient.invalidateQueries({ queryKey: ['rag-jobs'] });
  };
  const fail = (e: unknown) => setMsg({ text: (e as Error).message, ok: false });

  const reindex = useMutation({
    mutationFn: (reparse: boolean) => reindexRagDocument(docId, reparse, ragId),
    onSuccess: () => done(t('rag.doc.queued')),
    onError: fail,
  });
  const restore = useMutation({
    mutationFn: (version: number) => restoreRagDocumentVersion(docId, version, ragId),
    onSuccess: () => done(t('rag.doc.queued')),
    onError: fail,
  });

  if (detail.isLoading) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading', 'Loading…')}</p>;
  }
  if (detail.isError || !detail.data) {
    return (
      <p className="px-3 py-2 text-xs text-destructive-foreground">
        {(detail.error as Error | null)?.message || t('rag.doc.notRegistered')}
      </p>
    );
  }
  const d = detail.data;
  const busy = reindex.isPending || restore.isPending;

  return (
    <div className="space-y-3 px-3 pt-1 pb-3 text-xs">
      {d.error && (
        <p className="rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1.5 text-destructive-foreground">
          {d.error}
        </p>
      )}
      {(d.warnings ?? []).map((w, i) => (
        <p
          key={i}
          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-amber-700 dark:text-amber-400"
        >
          {w}
        </p>
      ))}
      {d.status === 'duplicate' && (
        <p className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-muted-foreground">
          {t('rag.doc.duplicateOf', { name: d.duplicate_of_name || d.duplicate_of })}
        </p>
      )}
      {d.status !== 'duplicate' && d.duplicate_of_name && (
        <p className="text-muted-foreground">{t('rag.doc.sameContentAs', { name: d.duplicate_of_name })}</p>
      )}
      {d.duplicates.length > 0 && (
        <p className="text-muted-foreground">
          {t('rag.doc.hasDuplicates', { names: d.duplicates.map((x) => x.filename).join(', ') })}
        </p>
      )}

      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5">
        <Field label={t('rag.doc.docId')}>
          <CopyValue value={d.doc_id ?? ''} />
        </Field>
        <Field label={t('rag.doc.sha256')}>
          <CopyValue value={d.content_sha256 ?? ''} />
        </Field>
        <Field label={t('rag.doc.version')}>v{d.version}</Field>
        <Field label={t('rag.doc.statusLabel')}>{t(`rag.doc.status.${d.status}`, d.status ?? '')}</Field>
        <Field label={t('rag.doc.origin')}>{t(`rag.doc.originName.${d.origin}`, d.origin ?? '')}</Field>
        <Field label={t('rag.doc.logicalPath')}>
          <span className="break-all">{d.logical_path}</span>
        </Field>
        <Field label={t('rag.doc.storedFile')}>
          <span className="break-all text-muted-foreground">{d.source}</span>
        </Field>
        <Field label={t('rag.doc.size')}>{formatBytes(d.size_bytes)}</Field>
        <Field label={t('rag.doc.chunks')}>{d.chunks}</Field>
        <Field label={t('rag.doc.indexedAt')}>{formatTime(d.indexed_at)}</Field>
        <Field label={t('rag.doc.lane')}>
          {d.lane || '—'}
          {d.parse_cached && (
            <span className="ml-2 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
              {t('rag.doc.fromCache')}
            </span>
          )}
        </Field>
        <Field label={t('rag.doc.pipeline')}>
          <code className="font-mono text-[11px] text-muted-foreground">{d.pipeline_fingerprint || '—'}</code>
        </Field>
      </dl>

      {d.versions.length > 0 && (
        <div>
          <div className="pb-1 text-[11px] font-semibold text-foreground/70">{t('rag.doc.versions')}</div>
          <div className="overflow-x-auto rounded-md border border-border/60">
            <table className="w-full text-[11px]">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium">{t('rag.doc.version')}</th>
                  <th className="px-2 py-1 font-medium">{t('rag.doc.date')}</th>
                  <th className="px-2 py-1 font-medium">SHA-256</th>
                  <th className="px-2 py-1 font-medium">{t('rag.doc.size')}</th>
                  <th className="px-2 py-1 font-medium">{t('rag.doc.statusLabel')}</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {d.versions.map((v) => (
                  <tr key={v.version} className="border-t border-border/40">
                    <td className="px-2 py-1 tabular-nums">v{v.version}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{formatTime(v.created_at)}</td>
                    <td className="px-2 py-1 font-mono" title={v.content_sha256}>
                      {v.content_sha256 ? v.content_sha256.slice(0, 12) : '—'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">{formatBytes(v.size_bytes)}</td>
                    <td className={cn('px-2 py-1', v.status === 'current' && 'font-medium')}>
                      {t(`rag.doc.versionStatus.${v.status}`, v.status)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {v.status !== 'current' && v.file_available && (
                        <button
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                          disabled={busy}
                          onClick={() => restore.mutate(v.version)}
                        >
                          <RotateCcwIcon className="size-3" /> {t('rag.doc.restore')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reindex.mutate(false)}>
          <RefreshCwIcon className="size-3.5" /> {t('rag.doc.reindex')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          title={t('rag.doc.reparseHint')}
          onClick={() => reindex.mutate(true)}
        >
          <RefreshCwIcon className="size-3.5" /> {t('rag.doc.reparse')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.open(ragDocumentOriginalUrl(d.source, ragId), '_blank')}>
          <DownloadIcon className="size-3.5" /> {t('rag.doc.original')}
        </Button>
        {msg && <span className={cn(msg.ok ? 'text-success' : 'text-destructive-foreground')}>{msg.text}</span>}
      </div>
    </div>
  );
}
