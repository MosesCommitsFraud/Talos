import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ArrowUpRightIcon, FileTextIcon, ImageIcon, Maximize2Icon, PlayCircleIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Citation, RagSource } from '@/api/types';
import { PassageNav, WebSourceChips } from './Citations';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';

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
 *  three adjacent transcript chunks read as one "0:40–2:10" passage instead
 *  of three near-duplicates. Segments more than `gap` seconds apart stay
 *  separate passages. */
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

/** The chunk's page — the live stream carries the backend's `_page`. */
function ragPage(s: RagSource): number | string | undefined {
  const p = s.page ?? s._page;
  return p == null || p === '' ? undefined : p;
}

function pageNum(s: RagSource): number {
  const n = Number(ragPage(s));
  return isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

type Kind = 'file' | 'video' | 'image';

/** One chip under the answer: a cited file (or figure) and the passages of it
 *  that were fed to the model. `offset` is where its passages start in the
 *  turn-wide list the hover card steps through. */
interface SourceGroup {
  key: string;
  kind: Kind;
  label: string;
  passages: RagSource[];
  offset: number;
}

function buildGroups(sources: RagSource[]): SourceGroup[] {
  const files = new Map<string, RagSource[]>();
  const videos = new Map<string, RagSource[]>();
  const images = new Map<string, RagSource>();
  for (const s of sources) {
    if (s.modality === 'image' && s.image_url) {
      const prev = images.get(s.image_url);
      if (!prev || s.similarity > prev.similarity) images.set(s.image_url, s);
    } else {
      const bucket = s.modality === 'video' ? videos : files;
      const list = bucket.get(s.filename) ?? [];
      list.push(s);
      bucket.set(s.filename, list);
    }
  }

  const groups: Omit<SourceGroup, 'offset'>[] = [];
  for (const [name, chunks] of files) {
    // The same chunk can arrive twice (several rounds of retrieval in one
    // turn) — one passage per distinct text, best score wins.
    const seen = new Map<string, RagSource>();
    for (const c of chunks) {
      const k = c.snippet.trim().slice(0, 160);
      const prev = seen.get(k);
      if (!prev || c.similarity > prev.similarity) seen.set(k, c);
    }
    // Reading order when pages are known, relevance otherwise.
    const passages = [...seen.values()].sort((a, b) => pageNum(a) - pageNum(b) || b.similarity - a.similarity);
    groups.push({ key: `file:${name}`, kind: 'file', label: name, passages });
  }
  for (const [name, segs] of videos) {
    groups.push({ key: `vid:${name}`, kind: 'video', label: name, passages: mergeVideoSegments(segs) });
  }
  for (const s of images.values()) {
    // Label the figure by its caption when the ingest produced one — the
    // filename is the *containing* document (often cited right next to it),
    // and the asset's on-disk crop name means nothing to the user.
    const caption = (s.image_caption || '').split('\n')[0].trim();
    groups.push({ key: `img:${s.image_url}`, kind: 'image', label: caption || s.filename, passages: [s] });
  }

  let offset = 0;
  return groups.map((g) => {
    const out = { ...g, offset };
    offset += g.passages.length;
    return out;
  });
}

function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  if (kind === 'video') return <PlayCircleIcon className={className} />;
  if (kind === 'image') return <ImageIcon className={className} />;
  return <FileTextIcon className={className} />;
}

/** Body of the hover card: which file, where in it, and the passage itself. */
function PassageView({ group, s }: { group: SourceGroup; s: RagSource }) {
  const { t } = useTranslation();
  const openLightbox = useUi((st) => st.openLightbox);
  const page = ragPage(s);
  const where = [
    page != null ? t('messages.citationPage', { page }) : null,
    s.modality === 'video' ? fmtRange(s.start, s.end) : null,
  ].filter(Boolean).join(' · ');
  const caption = (s.image_caption || '').trim();
  const text = s.modality === 'image' ? caption || s.snippet : s.snippet;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted">
          <KindIcon kind={group.kind} className="size-2.5" />
        </span>
        <span className="min-w-0 truncate font-medium text-popover-foreground">{s.filename}</span>
        {where && <span className="ml-auto shrink-0 tabular-nums">{where}</span>}
      </div>
      {s.modality === 'image' && s.image_url && (
        <button
          type="button"
          onClick={() => openLightbox({ src: s.image_url!, label: group.label })}
          className="block w-full overflow-hidden rounded-md border bg-muted/40"
          aria-label={t('messages.viewImage')}
        >
          <img src={s.image_url} alt="" loading="lazy" className="max-h-40 w-full object-contain" />
        </button>
      )}
      {text && (
        <blockquote className="max-h-44 overflow-y-auto border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
          {text.trim()}
        </blockquote>
      )}
    </div>
  );
}

/** Citations for a RAG-backed answer: one chip per knowledge-base file whose
 *  chunks were fed into the model (a figure is its own chip; a video's ASR
 *  segments are merged into time ranges). Hovering a chip opens a card with
 *  the passage itself; ‹ › (or ← →) step through every passage of the turn,
 *  starting at the hovered file's first one. */
export function RagSources({ sources, web = [] }: { sources: RagSource[]; web?: Citation[] }) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);
  const groups = useMemo(() => buildGroups(sources ?? []), [sources]);
  const flat = useMemo(() => groups.flatMap((g) => g.passages.map((s) => ({ g, s }))), [groups]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const step = useCallback((i: number) => setCursor(i), []);

  if (!groups.length && !web.length) return null;

  const current = openKey != null ? flat[Math.min(cursor, flat.length - 1)] : undefined;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-xs text-muted-foreground/80">{t('messages.sources')}</span>
      <WebSourceChips citations={web} />
      {groups.map((g) => {
        const isOpen = openKey === g.key;
        // While a card is open the chip of the passage on screen lights up,
        // so stepping past a file's last passage visibly hands over.
        const isShown = current?.g.key === g.key;
        const first = g.passages[0];
        const onClick = (e: React.MouseEvent) => {
          // Click pins the card open (also the way in on touch); figures open
          // straight in the lightbox, the card is their preview.
          e.preventDefault();
          if (g.kind === 'image' && first.image_url) openLightbox({ src: first.image_url, label: g.label });
          else {
            setOpenKey(g.key);
            setCursor(g.offset);
          }
        };
        return (
          <TooltipPrimitive.Root
            key={g.key}
            delayDuration={150}
            open={isOpen}
            onOpenChange={(v) => {
              if (v) {
                setOpenKey(g.key);
                setCursor(g.offset);
              } else setOpenKey((k) => (k === g.key ? null : k));
            }}
          >
            <TooltipPrimitive.Trigger asChild>
              <button
                type="button"
                onClick={onClick}
                className={cn(
                  'inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground',
                  g.kind === 'image' && first.image_url ? 'pr-2.5 pl-0.5' : 'px-2.5',
                  isShown && 'border-primary/50 bg-accent text-foreground',
                )}
              >
                {g.kind === 'image' && first.image_url ? (
                  <img src={first.image_url} alt="" loading="lazy" className="size-5 shrink-0 rounded-full object-cover" />
                ) : (
                  <KindIcon kind={g.kind} className="size-3 shrink-0" />
                )}
                <span className="truncate">{g.label}</span>
                {g.passages.length > 1 && (
                  <span
                    className="-mr-1 shrink-0 rounded-full bg-background/70 px-1.5 text-[10px] leading-4 tabular-nums"
                    title={t('messages.passageCount', { count: g.passages.length })}
                  >
                    {g.passages.length}
                  </span>
                )}
              </button>
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={12}
                // Labelled so Radix doesn't mirror the stepper into its hidden
                // screen-reader copy (a second set of key handlers).
                aria-label={current ? `${current.s.filename}: ${current.s.snippet.slice(0, 200)}` : g.label}
                className="z-50 w-[24rem] max-w-[calc(100vw-24px)] space-y-2.5 rounded-xl border bg-popover p-3 shadow-lg"
              >
                {isOpen && current && (
                  <>
                    <PassageView group={current.g} s={current.s} />
                    <PassageNav index={cursor} count={flat.length} onStep={step} active={isOpen}>
                      {current.s.deeplink && (
                        <a
                          href={current.s.deeplink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                        >
                          {t('messages.openVideoAt')} <ArrowUpRightIcon className="size-3" />
                        </a>
                      )}
                      {current.s.modality === 'image' && current.s.image_url && (
                        <button
                          type="button"
                          onClick={() => openLightbox({ src: current.s.image_url!, label: current.g.label })}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                        >
                          <Maximize2Icon className="size-3" /> {t('messages.viewImage')}
                        </button>
                      )}
                    </PassageNav>
                  </>
                )}
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>
        );
      })}
    </div>
  );
}
