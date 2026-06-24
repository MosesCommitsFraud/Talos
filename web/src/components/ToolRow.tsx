import { CheckIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@/api/types';
import { useUi } from '@/state/ui';

export interface ToolImage {
  src: string;
  label?: string;
}

/** Responsive grid of clickable image thumbnails. Clicking opens the shared
 *  full-screen lightbox (zoom + download). Labels render centered under each
 *  image to match the centered thumbnail; pass `showLabels={false}` for the
 *  end-of-turn recap where the subtitle would just be noise. */
export function ImageGallery({ images, showLabels = true }: { images: ToolImage[]; showLabels?: boolean }) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
      {images.map((image, i) => (
        <figure key={`${image.src.slice(0, 48)}-${i}`} className="m-0 min-w-0">
          <button
            type="button"
            onClick={() => openLightbox(image)}
            aria-label={image.label || t('messages.toolImage', { n: i + 1 })}
            className="block w-full cursor-zoom-in rounded-lg transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              src={image.src}
              alt={image.label || t('messages.toolImage', { n: i + 1 })}
              className="max-h-80 w-full rounded-lg object-contain"
            />
          </button>
          {showLabels && image.label && (
            <figcaption className="mt-1 break-words text-center text-xs text-muted-foreground">{image.label}</figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}

export function toolImages(call: ToolCall): ToolImage[] {
  const images: ToolImage[] = [];
  if (call.image_url) images.push({ src: call.image_url, label: call.image_prompt || 'Generated image' });
  if (call.screenshot) images.push({ src: call.screenshot, label: 'Screenshot' });
  for (const image of call.created_images ?? []) {
    const src = image.data_url || image.url;
    if (src) images.push({ src, label: image.caption || image.name });
  }
  return images.filter((image, i, all) => all.findIndex((other) => other.src === image.src) === i);
}

/** One quiet tool-call row: "python · done", expandable to command + output.
 *  `compact` (used inside the settled "Worked for" fold) keeps the row tidy by
 *  suppressing the inline image gallery — those images resurface in the turn's
 *  end grid instead. */
export function ToolRow({ call, compact = false }: { call: ToolCall; compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = call.status === 'running' ? LoaderCircleIcon : call.status === 'error' ? CircleAlertIcon : CheckIcon;
  const images = toolImages(call);
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon
          className={`size-3.5 ${call.status === 'running' ? 'animate-spin' : call.status === 'error' ? 'text-destructive-foreground' : 'text-success'}`}
        />
        <span>{call.tool}</span>
        <span className="font-normal opacity-70">{call.status === 'running' ? t('toolRow.running') : call.status}</span>
        <ChevronRightIcon className={`size-3.5 opacity-60 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 ml-1 space-y-1.5">
          {call.command && (
            <pre className="rounded-lg border bg-muted px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.command}</pre>
          )}
          {call.output && (
            <pre className="max-h-72 overflow-y-auto rounded-lg border bg-muted px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.output}</pre>
          )}
        </div>
      )}
      {(call.image_note || (!compact && images.length > 0)) && (
        <div className="mt-2 ml-1 space-y-1.5">
          {call.image_note && <div className="text-xs text-muted-foreground">{call.image_note}</div>}
          {!compact && <ImageGallery images={images} />}
        </div>
      )}
    </div>
  );
}
