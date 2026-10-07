import { ChevronRightIcon, FileIcon, FolderArchiveIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadArtifactsZip, uploadDownloadUrl } from '@/api/client';
import type { Attachment } from '@/api/types';
import { displayName, fileTypeLabel } from '@/lib/files';
import { presentedOutputs, useSessionFiles, type SessionFile } from '@/lib/useSessionFiles';
import { cn } from '@/lib/utils';
import { useChat } from '@/state/chat';
import { AttachmentTile, openUploadViewer } from './AttachmentTile';
import { FilePoster } from './FilePoster';
import { OutputTile, openSessionFile, useKindLabel } from './OutputCard';

function openUpload(f: Attachment, sessionId: string) {
  const name = f.name || f.id;
  const url = uploadDownloadUrl(f.id);
  if (openUploadViewer({ url, name, mime: f.mime, sessionId })) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

/** The header's file button ("📄 3") and the panel it opens: the chat's
 *  deliverables first, each with a large preview; then every other file the
 *  agent wrote as a compact row; then the uploads used in the chat, folded into
 *  one line until asked for. Picking a file opens it in the preview panel. */
export function SessionFilesPopover({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const kindLabel = useKindLabel();
  const messages = useChat((s) => s.messages);
  const { outputs, inputs } = useSessionFiles(sessionId);
  // Two ways in: hovering the button peeks at the list (it folds away again
  // when the pointer leaves), clicking pins it open until an outside click,
  // Escape or the X.
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const open = pinned || peek;
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  const setOpen = (value: boolean) => {
    window.clearTimeout(hoverTimer.current);
    setPinned(value);
    setPeek(false);
  };
  // Short delays both ways: passing over the button doesn't flash the panel,
  // and the pointer can cross the gap down into it without it closing.
  const onHover = (inside: boolean) => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setPeek(inside), inside ? 150 : 250);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (outputs.length === 0 && inputs.length === 0) return null;

  // What the agent handed over (present_files), newest first. A chat without
  // any still features its newest file, so the panel never opens on a bare list.
  const presented = presentedOutputs(messages, outputs).reverse();
  const featured = presented.length ? presented : outputs.slice(0, 1);
  const rest = outputs.filter((f) => !featured.includes(f));

  const pick = (f: SessionFile) => {
    openSessionFile(sessionId, f);
    setOpen(false);
  };

  const uploadNames = inputs.map((f) => f.name || f.id);

  return (
    <div ref={root} className="relative" onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      <button
        type="button"
        // A click while only peeking pins the panel instead of closing it.
        onClick={() => setOpen(!pinned)}
        aria-expanded={open}
        aria-label={t('outputs.filesAria', { count: outputs.length + inputs.length })}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm font-medium transition-colors',
          open ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <FileIcon className="size-3.5" />
        <span className="tabular-nums">{outputs.length + inputs.length}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('outputs.title')}
          className="dropdown-glass absolute right-0 top-full z-50 mt-2 max-h-[min(75vh,640px)] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl p-4 shadow-lg"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">{t('outputs.title')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('common.close')}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </div>

          {outputs.length > 0 && (
            <div className="space-y-4">
              {featured.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => pick(f)}
                  title={f.name}
                  className="group/poster block w-full cursor-pointer text-left"
                >
                  <div className="h-40 overflow-hidden rounded-lg border bg-muted transition-[border-color,box-shadow] group-hover/poster:border-foreground/25 group-hover/poster:shadow-md">
                    <div className="size-full transition-transform duration-300 ease-out group-hover/poster:scale-[1.02]">
                      <FilePoster sessionId={sessionId} file={f} />
                    </div>
                  </div>
                  <div className="mt-2 truncate text-[15px] font-medium text-foreground">{displayName(f.name)}</div>
                  <div className="truncate text-xs text-muted-foreground">{kindLabel(f)} · {fileTypeLabel(f.name, f.mime)}</div>
                </button>
              ))}
            </div>
          )}

          {rest.length > 0 && (
            <div className="mt-3 space-y-0.5">
              {rest.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => pick(f)}
                  title={f.name}
                  className="group/out flex w-full cursor-pointer items-center gap-3 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <OutputTile sessionId={sessionId} file={f} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{displayName(f.name)}</span>
                  <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">{fileTypeLabel(f.name, f.mime)}</span>
                </button>
              ))}
            </div>
          )}

          {inputs.length > 0 && (
            <div className={cn(outputs.length > 0 && 'mt-3 border-t pt-3')}>
              <div className="mb-1 text-sm font-semibold">{t('outputs.usedInSession')}</div>
              <button
                type="button"
                onClick={() => setUploadsOpen((v) => !v)}
                aria-expanded={uploadsOpen}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <PaperclipIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">{t('outputs.uploads')}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{uploadNames.slice(0, 2).join(', ')}</span>
                {uploadNames.length > 2 && <span className="shrink-0 text-xs text-muted-foreground">+{uploadNames.length - 2}</span>}
                <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', uploadsOpen && 'rotate-90')} />
              </button>
              {uploadsOpen && (
                <div className="mt-0.5 space-y-0.5 pl-1">
                  {inputs.map((f) => {
                    const name = f.name || f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => { openUpload(f, sessionId); setOpen(false); }}
                        title={name}
                        className="flex w-full cursor-pointer items-center gap-3 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent"
                      >
                        <AttachmentTile url={uploadDownloadUrl(f.id)} name={name} mime={f.mime} size={32} />
                        <span className="min-w-0 flex-1 truncate">{displayName(name)}</span>
                        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">{fileTypeLabel(name, f.mime)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {outputs.length > 1 && (
            <button
              type="button"
              onClick={() => { void downloadArtifactsZip(sessionId); }}
              className="mt-3 flex w-full cursor-pointer items-center gap-2.5 rounded-md border-t px-1.5 pb-1 pt-3 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <FolderArchiveIcon className="size-4" />
              {t('artifacts.downloadZip')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
