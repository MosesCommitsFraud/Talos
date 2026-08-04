import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { previewKind } from '@/lib/files';
import { useUi } from '@/state/ui';
import { FileTypeIcon } from './FileTypeIcon';

/** Open a chat upload in the viewer it belongs in: images in the full-screen
 *  lightbox, PDFs in the document panel. Uploads aren't workspace artifacts, so
 *  the preview carries its own URL (see PreviewFile.url). Returns false when the
 *  file has no viewer, leaving the caller's own fallback (download) in charge. */
export function openUploadViewer(file: { url: string; name: string; mime?: string; sessionId?: string | null }): boolean {
  const kind = previewKind(file.name, file.mime);
  const ui = useUi.getState();
  if (kind === 'image') {
    ui.openLightbox({ src: file.url, label: file.name });
    return true;
  }
  if (kind === 'pdf') {
    ui.openPreview({ sessionId: file.sessionId ?? '', path: file.url, url: file.url, name: file.name, mime: file.mime });
    return true;
  }
  return false;
}

/** Files whose own first face can stand in for them. Everything else falls back
 *  to the type glyph. */
export function hasVisualPreview(name: string, mime?: string): boolean {
  const kind = previewKind(name, mime);
  return kind === 'image' || kind === 'pdf';
}

/** First page of a PDF, rendered to cover its box. pdf.js and its worker load
 *  lazily, so a chat with no PDFs never pays for them; any failure (offline,
 *  encrypted, not really a PDF) falls back to the type glyph. */
function PdfThumb({ url, name, width, height }: { url: string; name: string; width: number; height: number }) {
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
        // Cover, not contain: a letterboxed page at thumbnail size is mostly
        // margin and reads as a blank box, so scale past the box and let the
        // parent's overflow crop it.
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: pixelRatio * Math.max(width / base.width, height / base.height),
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
  }, [url, width, height]);

  if (failed) return <GlyphFace name={name} />;
  return (
    <div className="flex size-full items-start justify-center overflow-hidden bg-white">
      <canvas ref={canvas} />
    </div>
  );
}

/** The fallback face: the Bootstrap filetype glyph, which carries the format's
 *  name inside the sheet (PDF, XLSX, PY…). */
function GlyphFace({ name, mime, className = 'size-6' }: { name: string; mime?: string; className?: string }) {
  return (
    <div className="flex size-full items-center justify-center bg-muted">
      <FileTypeIcon path={name} mime={mime} className={`${className} text-muted-foreground`} />
    </div>
  );
}

/** What a file looks like, filling whatever box it is given: an image shows
 *  itself, a PDF its first page, anything else its type glyph. `width`/`height`
 *  are the box's px size — used to pick the PDF render scale, not to lay out. */
export function FilePreviewFace({
  url,
  name,
  mime,
  width,
  height,
}: {
  url: string;
  name: string;
  mime?: string;
  width: number;
  height: number;
}) {
  const kind = previewKind(name, mime);
  if (kind === 'image') return <img src={url} alt="" className="size-full object-cover" />;
  if (kind === 'pdf') return <PdfThumb url={url} name={name} width={width} height={height} />;
  return <GlyphFace name={name} mime={mime} />;
}

/** One attachment as a square tile — the composer strip and the sent-message
 *  strip share it, so a file looks the same before and after it is sent. */
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
  return (
    <div
      className="overflow-hidden rounded-lg border bg-muted"
      style={{ width: size, height: size }}
    >
      <FilePreviewFace url={url} name={name} mime={mime} width={size} height={size} />
    </div>
  );
}
