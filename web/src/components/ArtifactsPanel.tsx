import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, FileIcon, FolderArchiveIcon, XIcon } from 'lucide-react';
import { artifactDownloadUrl, artifactsZipUrl, fetchArtifacts, uploadDownloadUrl } from '@/api/client';
import { useChat } from '@/state/chat';
import { Tooltip } from './ui/misc';

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Right-side drawer listing the session's sandbox workspace files
 *  (legacy "Files/Artifacts" button) with per-file download + zip-all. */
export function ArtifactsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessionId = useChat((s) => s.sessionId);
  const messages = useChat((s) => s.messages);
  const { data, isLoading } = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => fetchArtifacts(sessionId!),
    enabled: open && !!sessionId,
    refetchInterval: open ? 10_000 : false,
  });

  if (!open) return null;
  const inputs = messages.flatMap((m) => m.role === 'user' ? (m.attachments ?? []) : []);
  const inputPaths = new Set(
    inputs.flatMap((f) => [f.sandbox_path, f.name].filter((v): v is string => !!v)),
  );
  const files = (data ?? []).filter((f) => {
    const path = String(f.path ?? f.name ?? '');
    return path && !inputPaths.has(path);
  });

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-card" aria-label="Session files">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">Files</span>
        <div className="flex items-center gap-1">
          {sessionId && files.length > 0 && (
            <Tooltip label="Download all as zip">
              <a
                href={artifactsZipUrl(sessionId)}
                download
                aria-label="Download all as zip"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderArchiveIcon className="size-4" />
              </a>
            </Tooltip>
          )}
          <button
            type="button"
            aria-label="Close files panel"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {!sessionId && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Open a chat to see its files.</p>}
        {sessionId && isLoading && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Loading…</p>}
        {sessionId && inputs.length > 0 && (
          <div className="pb-2">
            <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">Input</div>
            {inputs.map((f) => (
              <div key={f.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/70">
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{f.name || f.id}</div>
                  {f.size != null && <div className="text-[11px] text-muted-foreground">{formatSize(f.size)}</div>}
                </div>
                <a
                  href={uploadDownloadUrl(f.id)}
                  download
                  aria-label={`Download ${f.name || f.id}`}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                >
                  <DownloadIcon className="size-3.5" />
                </a>
              </div>
            ))}
          </div>
        )}
        {sessionId && files.length > 0 && <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">Output</div>}
        {sessionId && !isLoading && files.length === 0 && inputs.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No files yet. Uploaded inputs and files the agent writes in its workspace show up here.
          </p>
        )}
        {files.map((f) => {
          const path = String(f.path ?? f.name ?? '');
          return (
            <div key={path} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/70">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{path}</div>
                {f.size != null && <div className="text-[11px] text-muted-foreground">{formatSize(f.size)}</div>}
              </div>
              {sessionId && (
                <a
                  href={artifactDownloadUrl(sessionId, path)}
                  download
                  aria-label={`Download ${path}`}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                >
                  <DownloadIcon className="size-3.5" />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
