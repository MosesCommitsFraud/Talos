import { ChevronRightIcon, CircleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@/api/types';
import { describeCall, diffStat } from '@/lib/toolLabels';
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

/** Line-coloured unified diff, the format `_unified_diff` emits on the backend
 *  for edit_file / write_file. Shown instead of the raw tool output so a code
 *  edit reads as a change rather than as a log line. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/60 py-2 font-mono text-[12.5px] leading-snug">
      {lines.map((line, i) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx';
        return (
          <div
            key={i}
            className={`px-3 ${
              kind === 'add'
                ? 'bg-success/10 text-success'
                : kind === 'del'
                  ? 'bg-destructive/10 text-destructive-foreground'
                  : kind === 'hunk' || kind === 'meta'
                    ? 'text-muted-foreground/70'
                    : ''
            }`}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/** Small green/red changed-line counter — "+21 -2". */
export function DiffStatBadge({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-destructive-foreground">-{removed}</span>}
    </span>
  );
}

/** One tool-call row inside a ToolGroup: a readable label ("Read TODO.md"),
 *  expandable to the raw command, its output, and a diff when the call changed
 *  a file. `compact` suppresses the inline image gallery — those images
 *  resurface in the turn's end-of-turn grid instead. */
export function ToolRow({ call, compact = false }: { call: ToolCall; compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const images = toolImages(call);
  const running = call.status === 'running';
  const label = describeCall(call, t, running ? 'running' : 'past');
  const stat = diffStat(call.diff);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {call.status === 'error' && <CircleAlertIcon className="size-3.5 shrink-0 text-destructive-foreground" />}
        <span className={`min-w-0 truncate ${running ? 'shimmer-text' : ''}`}>{label}</span>
        {stat && <DiffStatBadge added={stat.added} removed={stat.removed} />}
        <ChevronRightIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-1.5 px-3 pb-2.5">
          {call.command && (
            <pre className="max-h-56 overflow-auto rounded-lg border bg-muted px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.command}</pre>
          )}
          {call.diff && <DiffView diff={call.diff} />}
          {call.output && (
            <pre className="max-h-72 overflow-y-auto rounded-lg border bg-muted px-3 py-2 font-mono text-[12.5px] leading-snug whitespace-pre-wrap">{call.output}</pre>
          )}
        </div>
      )}
      {(call.image_note || (!compact && images.length > 0)) && (
        <div className="space-y-1.5 px-3 pb-2.5">
          {call.image_note && <div className="text-xs text-muted-foreground">{call.image_note}</div>}
          {!compact && <ImageGallery images={images} />}
        </div>
      )}
    </div>
  );
}
