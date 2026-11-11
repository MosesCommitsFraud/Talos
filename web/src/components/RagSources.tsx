import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  DatabaseIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  PlayCircleIcon,
  SparklesIcon,
  TextIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Citation, RagSource } from '@/api/types';
import { safeExternalUrl, type UiSource } from '@/lib/uiFrame';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { SiteAvatar, siteHost } from './Citations';
import { FileTypeIcon } from './FileTypeIcon';
import { Collapse } from './ui/collapse';

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

/** One knowledge-base source of a turn: a cited file (or figure) and the
 *  passages of it that were fed to the model. `offset` is where its passages
 *  start in the turn-wide list. */
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

const DATA_ICONS: Record<string, typeof DatabaseIcon> = {
  sql: DatabaseIcon,
  knowledge: FileTextIcon,
  web: GlobeIcon,
};

/** Everything a turn rests on, in the order the list shows it: cited web
 *  pages, the data behind its views and tables, then knowledge-base files. */
type Entry =
  | { key: string; type: 'web'; c: Citation }
  | { key: string; type: 'data'; s: UiSource }
  | { key: string; type: 'file'; g: SourceGroup };

/** The host behind a data source that names a web address, for its icon. */
function dataHost(s: UiSource): string | null {
  const link = s.ref ? safeExternalUrl(s.ref) : null;
  if (!link) return null;
  try {
    return new URL(link).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

/** One source's mark in the overlapping stack on the toggle: round, and ringed
 *  in the page colour so neighbours read as separate discs. */
function StackMark({ entry }: { entry: Entry }) {
  const disc = 'size-3.5 rounded-full ring-[1.5px] ring-background';
  if (entry.type === 'web') return <SiteAvatar site={siteHost(entry.c)} className={cn(disc, 'text-[8px]')} />;
  if (entry.type === 'file' && entry.g.kind === 'image' && entry.g.passages[0].image_url) {
    return <img src={entry.g.passages[0].image_url} alt="" loading="lazy" className={cn(disc, 'object-cover')} />;
  }
  const host = entry.type === 'data' ? dataHost(entry.s) : null;
  if (host) return <SiteAvatar site={host} className={cn(disc, 'text-[8px]')} />;
  const Icon = entry.type === 'data' ? (DATA_ICONS[entry.s.kind] ?? SparklesIcon) : null;
  return (
    <span aria-hidden className={cn(disc, 'flex items-center justify-center bg-secondary-foreground/15 text-foreground/80 dark:bg-neutral-700')}>
      {Icon ? <Icon className="size-2" /> : entry.type === 'file' ? <KindIcon kind={entry.g.kind} className="size-2" /> : null}
    </span>
  );
}

const ROW =
  'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const ROW_META = 'ml-auto shrink-0 pl-3 font-mono text-[10.5px] text-muted-foreground/80 tabular-nums';

/** One line of the source list: mark, name, and in monospace at the right edge
 *  where it lives — the host, the kind of data, or how much of a file was read. */
function SourceRow({ entry, active, onPick }: { entry: Entry; active: boolean; onPick: (g: SourceGroup) => void }) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);

  if (entry.type === 'web') {
    const host = siteHost(entry.c);
    return (
      <a href={entry.c.url} target="_blank" rel="noreferrer" title={entry.c.snippet || undefined} className={ROW}>
        <SiteAvatar site={host} className="size-4 rounded-[4px] text-[9px]" />
        <span className="min-w-0 truncate">{entry.c.title || host}</span>
        <span className={ROW_META}>{host}</span>
      </a>
    );
  }

  if (entry.type === 'data') {
    const Icon = DATA_ICONS[entry.s.kind] ?? SparklesIcon;
    const link = entry.s.ref ? safeExternalUrl(entry.s.ref) : null;
    const host = dataHost(entry.s);
    const body = (
      <>
        {host ? (
          <SiteAvatar site={host} className="size-4 rounded-[4px] text-[9px]" />
        ) : (
          <Icon className="size-4 shrink-0 opacity-80" />
        )}
        <span className="min-w-0 truncate">{entry.s.label}</span>
        <span className={ROW_META}>{t(`interactive.kind.${entry.s.kind}`, { defaultValue: entry.s.kind })}</span>
      </>
    );
    return link ? (
      <a href={link} target="_blank" rel="noreferrer noopener" className={ROW}>{body}</a>
    ) : (
      <div className={cn(ROW, 'hover:bg-transparent hover:text-muted-foreground')} title={entry.s.ref}>{body}</div>
    );
  }

  const g = entry.g;
  const first = g.passages[0];
  const page = ragPage(first);
  const meta =
    g.passages.length > 1
      ? t('messages.passageCount', { count: g.passages.length })
      : g.kind === 'video'
        ? fmtRange(first.start, first.end)
        : page != null
          ? t('messages.citationPage', { page })
          : null;
  const figure = g.kind === 'image' && first.image_url;
  return (
    <button
      type="button"
      aria-pressed={figure ? undefined : active}
      // A figure opens; a file narrows the passages below to its own.
      onClick={() => (figure ? openLightbox({ src: figure, label: g.label }) : onPick(g))}
      className={cn(ROW, active && 'bg-accent text-foreground')}
    >
      {figure ? (
        <img src={figure} alt="" loading="lazy" className="size-4 shrink-0 rounded-[4px] object-cover" />
      ) : g.kind === 'video' ? (
        <PlayCircleIcon className="size-4 shrink-0 opacity-80" />
      ) : (
        <FileTypeIcon path={g.label} className="size-4 shrink-0 opacity-80" />
      )}
      <span className="min-w-0 truncate">{g.label}</span>
      {meta && <span className={ROW_META}>{meta}</span>}
    </button>
  );
}

/** One retrieved passage as a card: what it is and how long, the text itself,
 *  and the file it was read from. */
function ChunkCard({ group, s, index }: { group: SourceGroup; s: RagSource; index: number }) {
  const { t, i18n } = useTranslation();
  const openLightbox = useUi((st) => st.openLightbox);
  const [expanded, setExpanded] = useState(false);
  const page = ragPage(s);
  const caption = (s.image_caption || '').trim();
  const text = (s.modality === 'image' ? caption || s.snippet : s.snippet).trim();
  const title =
    s.modality === 'image'
      ? caption.split('\n')[0] || t('messages.figure')
      : s.modality === 'video'
        ? (fmtRange(s.start, s.end) ?? t('messages.chunkN', { n: index + 1 }))
        : page != null
          ? t('messages.chunkPage', { page })
          : t('messages.chunkN', { n: index + 1 });
  const link = s.deeplink || s.video_url;
  const chip =
    'mt-2.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-background/70 pr-2 pl-1.5 text-[11.5px] text-foreground/90';
  const chipBody = (
    <>
      {group.kind === 'video' ? (
        <PlayCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileTypeIcon path={s.filename} className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{s.filename}</span>
    </>
  );
  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card/60">
      <header className="flex items-center gap-2 px-3 py-2">
        <TextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-strong">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {t('messages.chunkChars', { count: text.length, n: text.length.toLocaleString(i18n.language) })}
        </span>
      </header>
      <div className="border-t border-border/60 px-3 pt-2.5 pb-3">
        {s.modality === 'image' && s.image_url && (
          <button
            type="button"
            onClick={() => openLightbox({ src: s.image_url!, label: group.label })}
            className="mb-2 block w-full overflow-hidden rounded-md border bg-muted/40"
            aria-label={t('messages.viewImage')}
          >
            <img src={s.image_url} alt="" loading="lazy" className="max-h-40 w-full object-contain" />
          </button>
        )}
        {text && (
          // The whole passage is one click away, without a control of its own:
          // three lines are the preview, the text is the switch.
          <p
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              'cursor-pointer text-[12.5px] leading-relaxed whitespace-pre-line text-foreground/80',
              !expanded && 'line-clamp-3',
            )}
          >
            {text}
          </p>
        )}
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className={cn(chip, 'transition-colors hover:border-border hover:bg-accent')}>
            {chipBody}
            <ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className={chip}>{chipBody}</span>
        )}
      </div>
    </article>
  );
}

/** Passages shown before the rest is asked for: two rows of the grid. */
const CHUNKS_FOLDED = 4;

/** What a turn rests on, behind one quiet control in its action row: a stack of
 *  source marks and a count. Opened, it lists every source — web pages, data,
 *  knowledge-base files — and under the list the passages that were actually
 *  fed to the model, one card each. Picking a file narrows the cards to it.
 *
 *  `children` are the turn's own action icons, which share the row. */
export function TurnSources({
  sources,
  web = [],
  data = [],
  children,
}: {
  sources: RagSource[];
  web?: Citation[];
  data?: UiSource[];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [allChunks, setAllChunks] = useState(false);
  const groups = useMemo(() => buildGroups(sources ?? []), [sources]);
  const entries = useMemo<Entry[]>(
    () => [
      ...web.map((c): Entry => ({ key: `web:${c.n}`, type: 'web', c })),
      ...data.map((s, i): Entry => ({ key: `data:${i}`, type: 'data', s })),
      ...groups.map((g): Entry => ({ key: g.key, type: 'file', g })),
    ],
    [web, data, groups],
  );

  if (entries.length === 0) return <>{children}</>;

  const chunks = groups
    .filter((g) => (filter ? g.key === filter : true))
    .flatMap((g) => g.passages.map((s, index) => ({ g, s, index })));
  const picked = filter ? groups.find((g) => g.key === filter) : undefined;
  const folded = !allChunks && !filter && chunks.length > CHUNKS_FOLDED + 1;
  const shown = folded ? chunks.slice(0, CHUNKS_FOLDED) : chunks;

  return (
    <>
      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="flex -space-x-1">
            {entries.slice(0, 3).map((entry) => (
              <StackMark key={entry.key} entry={entry} />
            ))}
          </span>
          <span className="tabular-nums">{t('messages.sourcesCount', { count: entries.length })}</span>
          <ChevronDownIcon className={cn('size-3 opacity-60 transition-transform', open && 'rotate-180')} />
        </button>
        {children}
      </div>
      <Collapse open={open}>
        <div className="pt-1.5 pb-1">
          <div className="flex max-w-[30rem] flex-col rounded-[10px] border border-border/70 bg-muted/40 p-1">
            {entries.map((entry) => (
              <SourceRow
                key={entry.key}
                entry={entry}
                active={filter === entry.key}
                onPick={(g) => setFilter((k) => (k === g.key ? null : g.key))}
              />
            ))}
          </div>
          {chunks.length > 0 && (
            <>
              <div className="mt-3 mb-1.5 flex min-w-0 items-center gap-2 px-0.5">
                <span className="min-w-0 truncate text-[13px] font-medium text-strong">
                  {picked ? picked.label : t('messages.allChunks')}
                </span>
                <span className="shrink-0 rounded-md bg-muted px-1.5 text-xs leading-5 text-muted-foreground tabular-nums">
                  {chunks.length}
                </span>
                {picked && (
                  <button
                    type="button"
                    aria-label={t('messages.clearChunkFilter')}
                    title={t('messages.clearChunkFilter')}
                    onClick={() => setFilter(null)}
                    className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </div>
              <div className="grid gap-1.5 @xl/chat:grid-cols-2">
                {shown.map(({ g, s, index }) => (
                  <ChunkCard key={`${g.key}:${index}`} group={g} s={s} index={index} />
                ))}
              </div>
              {folded && (
                <button
                  type="button"
                  onClick={() => setAllChunks(true)}
                  className="mt-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {t('messages.moreChunks', { count: chunks.length - CHUNKS_FOLDED })}
                </button>
              )}
            </>
          )}
        </div>
      </Collapse>
    </>
  );
}
