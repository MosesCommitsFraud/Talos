import { useState } from 'react';
import { fileTypeLabel, previewKind } from '@/lib/files';
import { useThumbnail } from '@/lib/thumbnails';
import { cn } from '@/lib/utils';
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

/** Edge of an attachment tile. A sent image may grow to twice this wide. */
export const ATTACHMENT_TILE_SIZE = 120;

/** Natural shape of images already seen, so a tile reopened later (or the sent
 *  copy of a tile from the composer) has its final width from the first paint
 *  and the strip doesn't rewrap under the reader. */
const imageAspects = new Map<string, number>();

/** A document's face: its name, with the type as a badge underneath. */
function DocumentFace({ name, mime }: { name: string; mime?: string }) {
  return (
    <div className="flex size-full min-w-0 flex-col justify-between gap-1.5 p-2.5 text-left">
      <span className="line-clamp-4 text-xs leading-snug font-medium [overflow-wrap:anywhere] text-strong">{name}</span>
      <span className="self-start rounded-md border border-foreground/15 px-1.5 py-px text-[10px] leading-4 font-medium tracking-wide text-muted-foreground">
        {fileTypeLabel(name, mime)}
      </span>
    </div>
  );
}

/** One attachment as a tile — the composer strip and the sent-message strip
 *  share it, so a file looks the same before and after it is sent.
 *
 *  Always `size` tall and at least `size` wide. An image is shown whole; with
 *  `dynamic` a landscape one widens up to 2:1, so a sent row fills according to
 *  what is in it rather than as a row of identical boxes. */
export function AttachmentTile({
  url,
  name,
  mime,
  size = ATTACHMENT_TILE_SIZE,
  dynamic = false,
}: {
  url: string;
  name: string;
  mime?: string;
  size?: number;
  dynamic?: boolean;
}) {
  const kind = previewKind(name, mime);
  const isImage = kind === 'image';
  const isPdf = kind === 'pdf';
  const maxWidth = dynamic ? size * 2 : size;
  const thumb = useThumbnail(isImage || isPdf ? url : '', name, mime, isImage ? maxWidth : size, size, isImage ? 'contain' : 'cover');
  const [aspect, setAspect] = useState(() => imageAspects.get(url));
  const width = dynamic && isImage && aspect ? Math.round(Math.min(maxWidth, Math.max(size, size * aspect))) : size;
  const showsFile = (isImage || isPdf) && !thumb.failed;
  return (
    <div
      className="relative max-w-full overflow-hidden rounded-xl border border-foreground/12 bg-muted/60 transition-[width] duration-200 ease-out dark:bg-foreground/[0.04]"
      style={{ width, height: size }}
    >
      {showsFile ? (
        // The box stays mounted while the thumbnail is generated: it is what
        // the observer watches, and it holds the tile's shape meanwhile.
        <div ref={thumb.ref} className="size-full">
          {thumb.src && (
            <img
              src={thumb.src}
              alt=""
              decoding="async"
              onLoad={(e) => {
                if (!isImage || !e.currentTarget.naturalHeight) return;
                const measured = e.currentTarget.naturalWidth / e.currentTarget.naturalHeight;
                imageAspects.set(url, measured);
                setAspect(measured);
              }}
              // A tiny icon stays its own size rather than being blown up.
              className={cn('size-full', isImage ? 'object-scale-down' : 'object-cover')}
            />
          )}
          {isPdf && (
            <span className="absolute start-1.5 bottom-1.5 rounded-md bg-background/85 px-1.5 py-px text-[10px] leading-4 font-medium tracking-wide text-muted-foreground backdrop-blur-sm">
              {fileTypeLabel(name, mime)}
            </span>
          )}
        </div>
      ) : (
        <DocumentFace name={name} mime={mime} />
      )}
    </div>
  );
}
