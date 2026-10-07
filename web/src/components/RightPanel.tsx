import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, XIcon } from 'lucide-react';
import { downloadPreviewFile } from '@/api/client';
import { displayName, fileTypeLabel } from '@/lib/files';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { FileTypeIcon } from './FileTypeIcon';
import { PreviewContent } from './PreviewPanel';
import { Tooltip } from './ui/misc';

const MIN_WIDTH = 320;
/** Cap the panel at most of the viewport so the chat never fully disappears. */
const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));

/** Right-side resizable panel showing one file — opened from an output banner
 *  or the header's file menu. The file list itself lives in that menu, so the
 *  panel is just the preview. Chrome matches the left sidebar (rounded border,
 *  bg-background). */
export function RightPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.artifactsOpen);
  const setOpen = useUi((s) => s.setArtifactsOpen);
  const preview = useUi((s) => s.preview);
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

  if (!open || !preview) return null;
  const effWidth = dragWidth ?? width;
  const iconBtn = 'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

  return (
    <aside
      className="relative m-2 flex shrink-0 flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      style={{ width: effWidth }}
      aria-label={t('preview.panelLabel')}
    >
      {/* Drag handle on the left edge — widens/narrows the panel. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('preview.resize')}
        onPointerDown={onResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/40"
      />

      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b pl-3 pr-2">
        <div className="flex min-w-0 items-center gap-2" title={preview.name}>
          <FileTypeIcon path={preview.name} mime={preview.mime} className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{displayName(preview.name)}</span>
          <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">{fileTypeLabel(preview.name, preview.mime)}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!preview.streaming && (
            <Tooltip label={t('preview.download')}>
              <button
                type="button"
                onClick={() => { void downloadPreviewFile(preview); }}
                aria-label={t('preview.download')}
                className={iconBtn}
              >
                <DownloadIcon className="size-4" />
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            aria-label={t('preview.close')}
            onClick={() => setOpen(false)}
            className={iconBtn}
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      <PreviewContent preview={preview} />
    </aside>
  );
}
