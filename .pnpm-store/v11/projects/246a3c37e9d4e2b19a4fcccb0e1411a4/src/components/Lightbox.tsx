import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DownloadIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUi } from '@/state/ui';

const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

/** Derive a sensible download filename from an image src — the basename of a
 *  URL/path, or a generic name for data: URLs (which carry no filename). */
function downloadName(src: string): string {
  if (src.startsWith('data:')) {
    const mime = src.slice(5, src.indexOf(';'));
    const ext = mime.split('/')[1] || 'png';
    return `image.${ext}`;
  }
  try {
    const path = new URL(src, window.location.origin).pathname;
    const base = path.split('/').filter(Boolean).pop();
    return base || 'image';
  } catch {
    return src.split('/').pop()?.split('?')[0] || 'image';
  }
}

/** Full-screen image viewer: click-to-zoom (stepping through fixed levels),
 *  +/- controls, and a download button. Mounted once at the app root and driven
 *  by `useUi.lightbox`, so any image (tool output, generated image, artifact)
 *  opens the same viewer. */
export function Lightbox() {
  const { t } = useTranslation();
  const image = useUi((s) => s.lightbox);
  const close = useUi((s) => s.closeLightbox);
  const [zoomIdx, setZoomIdx] = useState(0);

  // Reset zoom whenever a new image opens.
  useEffect(() => {
    setZoomIdx(0);
  }, [image?.src]);

  const open = !!image;
  const zoom = ZOOM_STEPS[zoomIdx];
  const canZoomIn = zoomIdx < ZOOM_STEPS.length - 1;
  const canZoomOut = zoomIdx > 0;

  const download = () => {
    if (!image) return;
    const a = document.createElement('a');
    a.href = image.src;
    a.download = image.label?.trim() ? `${image.label.trim().slice(0, 80)}` : downloadName(image.src);
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[60] flex flex-col focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{image?.label || t('lightbox.title')}</DialogPrimitive.Title>

          {/* Toolbar */}
          <div className="flex items-center justify-end gap-1 p-3">
            <button
              type="button"
              aria-label={t('lightbox.zoomOut')}
              onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
              disabled={!canZoomOut}
              className="flex size-9 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ZoomOutIcon className="size-5" />
            </button>
            <button
              type="button"
              aria-label={t('lightbox.zoomIn')}
              onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
              disabled={!canZoomIn}
              className="flex size-9 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ZoomInIcon className="size-5" />
            </button>
            <button
              type="button"
              aria-label={t('lightbox.download')}
              onClick={download}
              className="flex size-9 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15"
            >
              <DownloadIcon className="size-5" />
            </button>
            <DialogPrimitive.Close
              aria-label={t('common.close')}
              className="flex size-9 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15"
            >
              <XIcon className="size-5" />
            </DialogPrimitive.Close>
          </div>

          {/* Image stage — clicking the backdrop closes; clicking the image cycles zoom. */}
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={close}
            className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
          >
            {image && (
              <img
                src={image.src}
                alt={image.label || t('lightbox.title')}
                onClick={(e) => {
                  e.stopPropagation();
                  setZoomIdx((i) => (i < ZOOM_STEPS.length - 1 ? i + 1 : 0));
                }}
                style={{ transform: `scale(${zoom})` }}
                className={`max-h-full max-w-full origin-center rounded-lg object-contain shadow-2xl transition-transform duration-200 ${canZoomIn ? 'cursor-zoom-in' : 'cursor-zoom-out'}`}
              />
            )}
          </button>

          {image?.label && (
            <div className="px-4 pb-4 text-center text-sm text-white/80">{image.label}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
