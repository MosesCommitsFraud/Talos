import { useQuery } from '@tanstack/react-query';
import {
  DownloadIcon, FileIcon, FileCodeIcon, FileSpreadsheetIcon, FileTextIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { artifactDownloadUrl, fetchArtifacts, uploadDownloadUrl } from '@/api/client';
import { useChat } from '@/state/chat';
import { fileTypeLabel, formatSize, isPreviewable, previewKind, type PreviewKind } from '@/lib/files';

type PreviewFile = { sessionId: string; path: string; name: string; mime?: string };

/** Icon used in the file-list tile for a non-image file, chosen by preview kind. */
function KindIcon({ kind, className }: { kind: PreviewKind; className?: string }) {
  if (kind === 'excel' || kind === 'csv') return <FileSpreadsheetIcon className={className} />;
  if (kind === 'code') return <FileCodeIcon className={className} />;
  if (kind === 'word' || kind === 'pdf' || kind === 'markdown' || kind === 'text') return <FileTextIcon className={className} />;
  return <FileIcon className={className} />;
}

/** Square leading tile: a real thumbnail for images, otherwise a tinted icon. */
function FileThumb({ src, kind, alt }: { src?: string; kind: PreviewKind; alt: string }) {
  if (kind === 'image' && src) {
    return <img src={src} alt={alt} loading="lazy" className="size-9 shrink-0 rounded-md border bg-muted object-cover" />;
  }
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
      <KindIcon kind={kind} className="size-4" />
    </div>
  );
}

/** One row in the file list. Clicking a previewable file opens the preview view;
 *  non-previewable files fall back to a download. */
function FileRow({
  name, sub, kind, thumbSrc, downloadUrl, onOpen,
}: {
  name: string;
  sub: string;
  kind: PreviewKind;
  thumbSrc?: string;
  downloadUrl: string;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const clickable = !!onOpen;
  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/70">
      <button
        type="button"
        onClick={onOpen}
        disabled={!clickable}
        title={clickable ? t('messages.openPreview', { name }) : name}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left enabled:cursor-pointer disabled:cursor-default"
      >
        <FileThumb src={thumbSrc} kind={kind} alt={name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{name}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1 py-px font-medium uppercase tracking-wide">{fileTypeLabel(name)}</span>
            {sub && <span>{sub}</span>}
          </div>
        </div>
      </button>
      <a
        href={downloadUrl}
        download
        aria-label={t('artifacts.download', { name })}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-foreground"
      >
        <DownloadIcon className="size-3.5" />
      </a>
    </div>
  );
}

/** Body of the session file list (no panel chrome — the shared right panel owns
 *  the border, header and resize). Lists uploaded inputs and the files the agent
 *  wrote in its workspace, with a thumbnail and data-type label per file. */
export function ArtifactsList({ sessionId, onOpen }: { sessionId: string | null; onOpen: (f: PreviewFile) => void }) {
  const { t } = useTranslation();
  const messages = useChat((s) => s.messages);
  const { data, isLoading } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => fetchArtifacts(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 10_000,
  });

  const inputs = messages.flatMap((m) => m.role === 'user' ? (m.attachments ?? []) : []);
  const inputPaths = new Set(
    inputs.flatMap((f) => [f.sandbox_path, f.name].filter((v): v is string => !!v)),
  );
  const files = (data ?? []).filter((f) => {
    const path = String(f.path ?? f.name ?? '');
    return path && !inputPaths.has(path);
  });

  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      {!sessionId && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('artifacts.openChat')}</p>}
      {sessionId && isLoading && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}

      {sessionId && inputs.length > 0 && (
        <div className="pb-2">
          <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">{t('artifacts.input')}</div>
          {inputs.map((f) => {
            const name = f.name || f.id;
            return (
              <FileRow
                key={f.id}
                name={name}
                sub={f.size != null ? formatSize(f.size) : ''}
                kind={previewKind(name, undefined)}
                downloadUrl={uploadDownloadUrl(f.id)}
              />
            );
          })}
        </div>
      )}

      {sessionId && files.length > 0 && <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">{t('artifacts.output')}</div>}
      {sessionId && !isLoading && files.length === 0 && inputs.length === 0 && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('artifacts.noFiles')}</p>
      )}
      {files.map((f) => {
        const path = String(f.path ?? f.name ?? '');
        const mime = typeof f.mime === 'string' ? f.mime : undefined;
        const kind = previewKind(path, mime);
        const previewable = isPreviewable(path, mime) && !!sessionId;
        return (
          <FileRow
            key={path}
            name={path}
            sub={f.size != null ? formatSize(f.size) : ''}
            kind={kind}
            thumbSrc={kind === 'image' && sessionId ? artifactDownloadUrl(sessionId, path) : undefined}
            downloadUrl={sessionId ? artifactDownloadUrl(sessionId, path) : '#'}
            onOpen={previewable ? () => onOpen({ sessionId: sessionId!, path, name: path, mime }) : undefined}
          />
        );
      })}
    </div>
  );
}
