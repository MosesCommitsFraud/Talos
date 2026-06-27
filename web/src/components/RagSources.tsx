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

/** Citations for a RAG-backed answer: the knowledge-base files whose chunks
 *  were fed into the model. Deduped by filename (a file can contribute several
 *  chunks). Image sources render a thumbnail (click → lightbox); video sources
 *  show a timestamp and link to the deep-link when one is available. */
export function RagSources({ sources }: { sources: RagSource[] }) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);
  if (!sources?.length) return null;

  const byFile = new Map<string, RagSource>();
  for (const s of sources) {
    const prev = byFile.get(s.filename);
    if (!prev || s.similarity > prev.similarity) byFile.set(s.filename, s);
  }
  const unique = [...byFile.values()];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground/80">{t('messages.sources')}:</span>
      {unique.map((s) => {
        const ts = s.modality === 'video' ? fmtTime(s.start) : null;

        if (s.modality === 'image' && s.image_url) {
          return (
            <button
              key={s.filename}
              type="button"
              onClick={() => openLightbox({ src: s.image_url!, label: s.filename })}
              title={s.snippet || s.filename}
              className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 py-0.5 pr-2 pl-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              <img
                src={s.image_url}
                alt=""
                loading="lazy"
                className="size-5 shrink-0 rounded-[3px] object-cover"
              />
              <span className="truncate">{s.filename}</span>
            </button>
          );
        }

        if (s.modality === 'video') {
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
              key={s.filename}
              href={s.deeplink}
              target="_blank"
              rel="noreferrer"
              title={s.snippet || s.filename}
              className={`${cls} transition-colors hover:border-border hover:text-foreground`}
            >
              {inner}
            </a>
          ) : (
            <span key={s.filename} title={s.snippet || s.filename} className={cls}>
              {inner}
            </span>
          );
        }

        return (
          <span
            key={s.filename}
            title={s.snippet || s.filename}
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <FileIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{s.filename}</span>
          </span>
        );
      })}
    </div>
  );
}
