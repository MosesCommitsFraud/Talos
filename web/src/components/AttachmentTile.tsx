import { previewKind } from '@/lib/files';
import { useThumbnail } from '@/lib/thumbnails';
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
 *  are the box's px size — the thumbnail is rendered to exactly that, so a tile
 *  never decodes a full-size photo or parses a whole PDF to fill 56 square
 *  pixels (see lib/thumbnails). */
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
  const visual = hasVisualPreview(name, mime);
  const thumb = useThumbnail(visual ? url : '', name, mime, width, height);
  if (!visual) return <GlyphFace name={name} mime={mime} />;
  if (thumb.failed) return <GlyphFace name={name} mime={mime} />;
  return (
    // The box stays mounted while the thumbnail is generated — it is what the
    // observer watches, and it holds the tile's shape so nothing reflows when
    // the image lands.
    <div ref={thumb.ref} className="size-full bg-muted">
      {thumb.src && <img src={thumb.src} alt="" decoding="async" className="size-full object-cover" />}
    </div>
  );
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
