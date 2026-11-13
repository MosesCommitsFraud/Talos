import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from './FileTypeIcon';
import { createContext, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Citation } from '@/api/types';
import { useUi } from '@/state/ui';

/* Inline citations: the backend numbers every web result, fetched page and
   knowledge-base section of a turn (src/citations.py) and the model writes
   "[n]" right after the claim. A remark plugin turns those markers into <cite>
   nodes; <CitationRef> renders them as a source pill with a hover card that
   shows the passage the claim rests on. */

const CitationContext = createContext<Map<number, Citation>>(new Map());

/** Merge a turn's citation tables (one per round bubble) into a lookup by number. */
export function citationMap(lists: (Citation[] | undefined)[]): Map<number, Citation> {
  const map = new Map<number, Citation>();
  for (const list of lists) for (const c of list ?? []) map.set(c.n, c);
  return map;
}

export function CitationProvider({ citations, children }: { citations: Map<number, Citation>; children: React.ReactNode }) {
  return <CitationContext.Provider value={citations}>{children}</CitationContext.Provider>;
}

// One marker group: "[3]", "[3, 5]" or adjacent "[3][5]" — a group renders as
// a single pill, the way the answer uses it as a single reference.
const MARKER_RE = /(?:\[\d{1,3}(?:\s*,\s*\d{1,3})*\])+/g;

function markerNumbers(marker: string): number[] {
  return [...marker.matchAll(/\d{1,3}/g)].map((d) => Number(d[0]));
}

/** Numbers cited anywhere in `text`, in order of first appearance. */
export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(MARKER_RE)) for (const n of markerNumbers(m[0])) seen.add(n);
  return [...seen];
}

/* ── remark plugin ── */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const SKIP = new Set(['link', 'linkReference', 'code', 'inlineCode', 'math', 'inlineMath', 'html']);

function splitText(node: MdNode): MdNode[] {
  const value = node.value ?? '';
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(MARKER_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', value: value.slice(last, at) });
    out.push({
      type: 'citation',
      children: [{ type: 'text', value: m[0] }],
      data: { hName: 'cite', hProperties: { dataNums: markerNumbers(m[0]).join(',') } },
    });
    last = at + m[0].length;
  }
  if (last === 0) return [node];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: MdNode) {
  if (!node.children || SKIP.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitText(child);
    walk(child);
    return [child];
  });
}

export function remarkCitations() {
  return (tree: MdNode) => walk(tree);
}

/* ── rendering ── */

/** "magicplan" for help.magicplan.app — the name a reader recognises. */
function siteLabel(c: Citation): string {
  if (c.kind === 'rag') return c.title.replace(/\.[a-z0-9]{2,5}$/i, '');
  const host = (c.site || '').split('.');
  return (host.length >= 2 ? host[host.length - 2] : host[0]) || c.title;
}

/** Host without the "www." nobody reads: "help.magicplan.app". */
export function siteHost(c: Citation): string {
  return (c.site || '').replace(/^www\./i, '') || c.title;
}

/** Hosts whose icon could not be had, so each is asked for once per page
 *  load and not again by every chip that cites the same site. */
const noIcon = new Set<string>();

/** A site's mark: its favicon, and until that has loaded (or when the site
 *  has none) its initial on a tile whose hue comes from the host name.
 *
 *  The icon is not loaded from the site. It comes through the app's own image
 *  proxy (/api/news/favicon), so the sites an answer cites never see the
 *  reader's browser. */
export function SiteAvatar({ site, className }: { site: string; className?: string }) {
  const host = site.toLowerCase();
  const usable = /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host);
  const [state, setState] = useState<'loading' | 'shown' | 'none'>(usable && !noIcon.has(host) ? 'loading' : 'none');
  let hash = 0;
  for (const ch of site) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden font-sans font-semibold text-white uppercase', className)}
      style={state === 'shown' ? undefined : { background: `oklch(0.6 0.13 ${hash})` }}
    >
      {state !== 'shown' && (site.replace(/[^\p{L}\p{N}]/gu, '').charAt(0) || '·')}
      {state !== 'none' && (
        <img
          src={`/api/news/favicon?host=${encodeURIComponent(host)}`}
          alt=""
          loading="lazy"
          onLoad={() => setState('shown')}
          onError={() => {
            noIcon.add(host);
            setState('none');
          }}
          // Over the tile, invisible until it has arrived: no broken-image
          // glyph, and no jump when it does.
          className={cn('absolute inset-0 size-full object-contain', state !== 'shown' && 'opacity-0')}
        />
      )}
    </span>
  );
}

/** The mark of one cited source: a site's tile, or the file type's glyph. */
export function CitationAvatar({ c, className }: { c: Citation; className?: string }) {
  if (c.kind === 'web') return <SiteAvatar site={siteHost(c)} className={cn('rounded-[3px] text-[8px]', className)} />;
  return <FileTypeIcon path={c.title} className={cn('shrink-0', className)} />;
}

/** What a hover card says about one source, top to bottom: where it is from
 *  (mark, host or file, and at the right edge the page or date), the page's
 *  title, and the passage the claim rests on. Dense on purpose: the card sits
 *  over the sentence being read and should be taken in at a glance. */
export function CitationCard({ c }: { c: Citation }) {
  const { t } = useTranslation();
  const web = c.kind === 'web';
  const meta = [
    c.page != null && c.page !== '' ? t('messages.citationPage', { page: c.page }) : null,
    c.published,
  ].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <CitationAvatar c={c} className={web ? 'size-4 rounded-[4px] text-[9px]' : 'size-4 text-muted-foreground'} />
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{web ? siteHost(c) : c.title}</span>
        {meta && <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums">{meta}</span>}
      </div>
      {web && c.title && (
        <div className="mt-1.5 line-clamp-2 text-[13px] leading-snug font-semibold text-strong">{c.title}</div>
      )}
      {c.image_url && (
        <img src={c.image_url} alt="" loading="lazy" className="mt-1.5 max-h-28 rounded-md border object-contain" />
      )}
      {c.snippet && (
        <p
          className={cn(
            'selectable line-clamp-4 text-xs leading-[1.5] text-muted-foreground',
            // A passage from a file is a quotation; a web result's line is the
            // page describing itself.
            web ? 'mt-1' : 'mt-1.5 border-l-2 border-border pl-2',
          )}
        >
          {c.snippet}
        </p>
      )}
    </div>
  );
}

/** "Open" at the foot of a hover card, for a source that has somewhere to go. */
export function CitationLink({ c }: { c: Citation }) {
  const { t } = useTranslation();
  const href = c.url || c.deeplink;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-6 items-center gap-0.5 rounded-full px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
    >
      {t('messages.openSource')} <ArrowUpRightIcon className="size-3" />
    </a>
  );
}

/** ‹ › stepper at the foot of a source hover card: "Passage 2 of 5". Arrow
 *  keys step too while the card is open (`active`), unless the user is typing. */
export function PassageNav({
  index,
  count,
  onStep,
  active = true,
  children,
}: {
  index: number;
  count: number;
  onStep: (next: number) => void;
  active?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!active || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      onStep((index + (e.key === 'ArrowRight' ? 1 : count - 1)) % count);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, count, index, onStep]);
  // `children` may be components that render nothing (a source without a link),
  // so the row is always laid out and collapses on its own when it is empty.
  const btn =
    'flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
  return (
    <div className="-mx-1.5 mt-2 flex items-center gap-0.5 border-t border-border/60 px-0.5 pt-1.5 empty:hidden has-[>span:only-child:empty]:hidden">
      {count > 1 && (
        <>
          <button type="button" aria-label={t('messages.prevPassage')} className={btn} onClick={() => onStep((index + count - 1) % count)}>
            <ChevronLeftIcon className="size-3.5" />
          </button>
          <span className="px-0.5 text-[11px] text-muted-foreground tabular-nums">
            {index + 1}/{count}
          </span>
          <button type="button" aria-label={t('messages.nextPassage')} className={btn} onClick={() => onStep((index + 1) % count)}>
            <ChevronRightIcon className="size-3.5" />
          </button>
        </>
      )}
      <span className="ml-auto flex items-center">{children}</span>
    </div>
  );
}

function openCitation(c: Citation) {
  if (c.url) window.open(c.url, '_blank', 'noopener,noreferrer');
  else if (c.deeplink) window.open(c.deeplink, '_blank', 'noopener,noreferrer');
  else if (c.image_url) useUi.getState().openLightbox({ src: c.image_url, label: c.image_caption || c.title });
}

/** Renderer for the <cite> nodes produced by remarkCitations. */
export function CitationRef({ children, ...props }: { children?: React.ReactNode; 'data-nums'?: string }) {
  const map = useContext(CitationContext);
  const nums = String(props['data-nums'] ?? '').split(',').map(Number);
  const cites = nums.map((n) => map.get(n)).filter((c): c is Citation => !!c);
  // A number with no registered source (plain "[2]" in prose, or a marker the
  // model invented) stays literal text rather than a pill pointing nowhere.
  if (cites.length === 0) return <>{children}</>;
  return <CitationPill cites={cites} />;
}

function CitationPill({ cites }: { cites: Citation[] }) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const first = cites[0];
  const shown = cites[Math.min(idx, cites.length - 1)];
  return (
    <TooltipPrimitive.Root
      delayDuration={120}
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setIdx(0);
      }}
    >
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          onClick={() => openCitation(first)}
          // A pill beside the claim, with air on both sides so it reads as a
          // reference and not as another word of the sentence.
          className="cite-chip mx-1 inline-flex h-5 max-w-[13rem] -translate-y-px items-center gap-1 rounded-full border border-border/70 bg-muted/70 py-0 pr-2 pl-1 align-middle text-[11px] leading-none font-medium text-muted-foreground not-italic transition-colors hover:border-border hover:bg-accent hover:text-foreground"
        >
          <CitationAvatar c={first} className={first.kind === 'web' ? 'size-3.5 rounded-full' : 'ml-0.5 size-3'} />
          <span className="truncate">{first.kind === 'web' ? siteHost(first) : siteLabel(first)}</span>
          {cites.length > 1 && <span className="shrink-0 tabular-nums opacity-70">+{cites.length - 1}</span>}
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // Radix mirrors the children into a hidden copy for screen readers
          // unless given a label — a second stepper with its own key handler.
          aria-label={cites.map((c) => c.title).join(', ')}
          className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-xl border bg-popover px-3 pt-2.5 pb-2 shadow-lg"
        >
          <CitationCard key={shown.n} c={shown} />
          <PassageNav index={idx} count={cites.length} onStep={setIdx} active={open}>
            <CitationLink c={shown} />
          </PassageNav>
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

