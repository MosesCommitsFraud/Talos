import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, FolderArchiveIcon, XIcon } from 'lucide-react';
import { downloadArtifact, downloadArtifactsZip } from '@/api/client';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { ArtifactsList } from './ArtifactsPanel';
import { PreviewContent } from './PreviewPanel';
import { Tooltip } from './ui/misc';

const MIN_WIDTH = 320;
/** Cap the panel at most of the viewport so the chat never fully disappears. */
const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));

/** Right-side resizable panel that hosts both the session file list and the
 *  document preview. A segmented switch in the header flips between the two;
 *  clicking a previewable file in the list jumps straight to the preview view.
 *  Chrome matches the left sidebar (rounded border, bg-background). */
export function RightPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.artifactsOpen);
  const setOpen = useUi((s) => s.setArtifactsOpen);
  const mode = useUi((s) => s.panelMode);
  const setMode = useUi((s) => s.setPanelMode);
  const preview = useUi((s) => s.preview);
  const openPreview = useUi((s) => s.openPreview);
  const sessionId = useChat((s) => s.sessionId);
  const width = usePrefs((s) => s.previewWidth);
  const setWidth = usePrefs((s) => s.setPreviewWidth);
  // Live width during a drag (avoids persisting on every mousemove).
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      setDragWidth(Math.min(maxWidth(), Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX))));
    };
    const onUp = (ev: PointerEvent) => {
      setWidth(Math.min(maxWidth(), Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX))));
      setDragWidth(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [width, setWidth]);

  if (!open) return null;
  const effWidth = dragWidth ?? width;

  const tab = (m: 'files' | 'preview', label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <aside
      className="relative m-2 flex shrink-0 flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      style={{ width: effWidth }}
      aria-label={t('rightPanel.label')}
    >
      {/* Drag handle on the left edge — widens/narrows the panel. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('preview.resize')}
        onPointerDown={onResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/40"
      />

      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b pl-2 pr-2">
        {/* Segmented switch: Files ⇄ Preview. */}
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {tab('files', t('rightPanel.files'))}
          {tab('preview', t('rightPanel.preview'))}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {mode === 'files' && sessionId && (
            <Tooltip label={t('artifacts.downloadZip')}>
              <button
                type="button"
                onClick={() => { void downloadArtifactsZip(sessionId); }}
                aria-label={t('artifacts.downloadZip')}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderArchiveIcon className="size-4" />
              </button>
            </Tooltip>
          )}
          {mode === 'preview' && preview && !preview.streaming && (
            <Tooltip label={t('preview.download')}>
              <button
                type="button"
                onClick={() => { void downloadArtifact(preview.sessionId, preview.path, preview.name); }}
                aria-label={t('preview.download')}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <DownloadIcon className="size-4" />
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            aria-label={t('rightPanel.close')}
            onClick={() => setOpen(false)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      {mode === 'files'
        ? <ArtifactsList sessionId={sessionId} onOpen={openPreview} />
        : <PreviewContent preview={preview} />}
    </aside>
  );
}
