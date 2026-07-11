import { FileIcon, PlayCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RagSource } from '@/api/types';
import { useUi } from '@/state/ui';

/** Format a seconds offset as m:ss (or h:mm:ss) for a video timestamp label. */
function fmtTime(sec?: number): string | null {
  if (sec == null || !isFinite(sec)) return null;
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "0:12–1:45" range label for an ASR segment; falls back to the start time
 *  alone when the segment carries no usable end. Null when there is no
 *  timing at all (e.g. the whole-file ASR fallback stores 0/0). */
function fmtRange(start?: number, end?: number): string | null {
  const from = fmtTime(start);
  if (from == null) return null;
  if (start === 0 && (end == null || end === 0)) return null;
  const to = end != null && end > (start ?? 0) ? fmtTime(end) : null;
  return to ? `${from}–${to}` : from;
}

/** Merge a video's cited ASR segments into non-overlapping time ranges so
 *  three adjacent transcript chunks show as one "0:40–2:10" tag instead of
 *  three near-duplicate tags. Segments more than `gap` seconds apart stay
 *  separate tags. */
function mergeVideoSegments(segs: RagSource[], gap = 20): RagSource[] {
  const sorted = [...segs].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const out: RagSource[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    const lastEnd = last ? Math.max(last.end ?? 0, last.start ?? 0) : 0;
    if (last && (s.start ?? 0) <= lastEnd + gap) {
      last.end = Math.max(lastEnd, s.end ?? s.start ?? 0);
      if (s.similarity > last.similarity) {
        last.similarity = s.similarity;
        last.snippet = s.snippet;
      }
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Citations for a RAG-backed answer: the knowledge-base files whose chunks
 *  were fed into the model. Text/doc chunks are deduped by filename; a figure
 *  is its own source tag (thumbnail + caption, click → lightbox) even when it
 *  came out of a document that is also cited for text; video ASR segments are
 *  merged per file into from–to time ranges, one tag per range, linking to the
 *  deep-link when one is available. */
export function RagSources({ sources }: { sources: RagSource[] }) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);
  if (!sources?.length) return null;

  const byFile = new Map<string, RagSource>();
  const images = new Map<string, RagSource>();
  const videosByFile = new Map<string, RagSource[]>();
  for (const s of sources) {
    if (s.modality === 'image' && s.image_url) {
      const prev = images.get(s.image_url);
      if (!prev || s.similarity > prev.similarity) images.set(s.image_url, s);
    } else if (s.modality === 'video') {
      const segs = videosByFile.get(s.filename) ?? [];
      segs.push(s);
      videosByFile.set(s.filename, segs);
    } else {
      const prev = byFile.get(s.filename);
      if (!prev || s.similarity > prev.similarity) byFile.set(s.filename, s);
    }
  }

  const fileTags = [...byFile.values()];
  const videoTags = [...videosByFile.values()].flatMap((segs) => mergeVideoSegments(segs));
  const imageTags = [...images.values()];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground/80">{t('messages.sources')}:</span>
      {fileTags.map((s) => (
        <span
          key={`file:${s.filename}`}
          title={s.snippet || s.filename}
          className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <FileIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{s.filename}</span>
        </span>
      ))}
      {videoTags.map((s) => {
        const ts = fmtRange(s.start, s.end);
        const key = `vid:${s.filename}:${s.start ?? 0}`;
        const inner = (
          <>
            <PlayCircleIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{s.filename}</span>
            {ts && <span className="shrink-0 tabular-nums opacity-80">{ts}</span>}
          </>
        );
        const cls =
          'inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground';
        return s.deeplink ? (
          <a
            key={key}
            href={s.deeplink}
            target="_blank"
            rel="noreferrer"
            title={s.snippet || s.filename}
            className={`${cls} transition-colors hover:border-border hover:text-foreground`}
          >
            {inner}
          </a>
        ) : (
          <span key={key} title={s.snippet || s.filename} className={cls}>
            {inner}
          </span>
        );
      })}
      {imageTags.map((s) => {
        // Label the figure by its caption when the ingest produced one — the
        // filename is the *containing* document (often cited right next to it
        // as a text tag), and the asset's on-disk crop name means nothing to
        // the user.
        const caption = (s.image_caption || '').split('\n')[0].trim();
        const label = caption || s.filename;
        return (
          <button
            key={`img:${s.image_url}`}
            type="button"
            onClick={() => openLightbox({ src: s.image_url!, label })}
            title={caption ? `${s.filename} — ${caption}` : s.snippet || s.filename}
            className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 py-0.5 pr-2 pl-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <img
              src={s.image_url}
              alt=""
              loading="lazy"
              className="size-5 shrink-0 rounded-[3px] object-cover"
            />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
