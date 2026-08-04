import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { previewKind } from '@/lib/files';
import { FileTypeIcon } from './FileTypeIcon';

/** First page of a PDF, rendered small and cropped to fill a square tile. Falls
 *  back to the type glyph if the file can't be fetched or parsed (pdf.js and its
 *  worker are loaded lazily, so a chat with no PDFs never pays for them). */
function PdfThumb({ url, name, size }: { url: string; name: string; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    void (async () => {
      try {
        const [pdfjs, worker, res] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
          fetch(url, { credentials: 'same-origin' }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        task = pdfjs.getDocument({ data });
        const page = await (await task.promise).getPage(1);
        const element = canvas.current;
        if (cancelled || !element) return;
        // Cover, not contain: scale so the SHORT side fills the tile, then let
        // the tile's overflow crop the rest — a letterboxed page at 56px is all
        // margin and reads as a blank square.
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: (size * pixelRatio) / Math.min(base.width, base.height),
        });
        element.width = Math.floor(viewport.width);
        element.height = Math.floor(viewport.height);
        element.style.width = `${viewport.width / pixelRatio}px`;
        element.style.height = `${viewport.height / pixelRatio}px`;
        const context = element.getContext('2d', { alpha: false });
        if (!context) return;
        await page.render({ canvas: element, canvasContext: context, viewport }).promise;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (task) void task.destroy();
    };
  }, [url, size]);

  if (failed) return <GlyphTile name={name} />;
  return (
    <div className="flex size-full items-start justify-center overflow-hidden bg-white">
      <canvas ref={canvas} />
    </div>
  );
}

/** The fallback face: the Bootstrap filetype glyph, which carries the format's
 *  name inside the sheet (PDF, XLSX, PY…). */
function GlyphTile({ name, mime }: { name: string; mime?: string }) {
  return (
    <div className="flex size-full items-center justify-center bg-muted">
      <FileTypeIcon path={name} mime={mime} className="size-6 text-muted-foreground" />
    </div>
  );
}

/** One attachment as a square tile: images and PDFs show themselves, everything
 *  else shows its type glyph. Sized by `size` (px) so the same component works
 *  for the composer strip and the sent-message strip. */
export function AttachmentTile({
  url,
  name,
  mime,
  size = 56,
}: {
  url: string;
  name: string;
  mime?: string;
  size?: number;
}) {
  const kind = previewKind(name, mime);
  return (
    <div
      className="overflow-hidden rounded-lg border bg-muted"
      style={{ width: size, height: size }}
    >
      {kind === 'image' ? (
        <img src={url} alt={name} className="size-full object-cover" />
      ) : kind === 'pdf' ? (
        <PdfThumb url={url} name={name} size={size} />
      ) : (
        <GlyphTile name={name} mime={mime} />
      )}
    </div>
  );
}
