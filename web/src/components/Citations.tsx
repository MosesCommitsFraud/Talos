import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon, FileTextIcon, GlobeIcon } from 'lucide-react';
import { Children, createContext, useContext, useEffect, useState } from 'react';
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

function SourceIcon({ c, className = 'size-3.5' }: { c: Citation; className?: string }) {
  return c.kind === 'web' ? <GlobeIcon className={className} /> : <FileTextIcon className={className} />;
}

function CitationCard({ c }: { c: Citation }) {
  const { t } = useTranslation();
  const meta = [
    c.kind === 'web' ? c.site : c.title,
    c.page != null && c.page !== '' ? t('messages.citationPage', { page: c.page }) : null,
    c.published,
  ].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted">
          <SourceIcon c={c} className="size-2.5" />
        </span>
        <span className="truncate">{meta}</span>
      </div>
      {c.kind === 'web' && c.title && (
        <div className="line-clamp-2 text-[13px] leading-snug font-semibold text-popover-foreground">{c.title}</div>
      )}
      {c.image_url && (
        <img src={c.image_url} alt="" loading="lazy" className="max-h-28 rounded-md border object-contain" />
      )}
      {c.snippet && (
        <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">{c.snippet}</p>
      )}
      {c.url && (
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
        >
          {t('messages.openSource')} <ArrowUpRightIcon className="size-3" />
        </a>
      )}
    </div>
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
  if (count < 2 && Children.toArray(children).length === 0) return null;
  const btn =
    'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
  return (
    <div className="-mx-1 -mb-1 flex items-center gap-1 border-t border-border/60 pt-1.5">
      {count > 1 && (
        <>
          <button type="button" aria-label={t('messages.prevPassage')} className={btn} onClick={() => onStep((index + count - 1) % count)}>
            <ChevronLeftIcon className="size-3.5" />
          </button>
          <button type="button" aria-label={t('messages.nextPassage')} className={btn} onClick={() => onStep((index + 1) % count)}>
            <ChevronRightIcon className="size-3.5" />
          </button>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t('messages.passageOf', { i: index + 1, n: count })}
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-2 pr-1">{children}</span>
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
          className="ml-0.5 inline-flex max-w-[11rem] translate-y-[-1px] items-center gap-1 rounded-full border border-border/60 bg-muted/70 px-1.5 py-px align-middle text-[11px] leading-4 font-medium text-muted-foreground not-italic transition-colors hover:border-border hover:bg-accent hover:text-foreground"
        >
          <span className="truncate">{siteLabel(first)}</span>
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
          className="z-50 w-[22rem] max-w-[calc(100vw-24px)] space-y-2.5 rounded-xl border bg-popover p-3 shadow-lg"
        >
          <CitationCard key={shown.n} c={shown} />
          <PassageNav index={idx} count={cites.length} onStep={setIdx} active={open} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** Cited web pages under the answer, in citation order. */
export function WebSourceChips({ citations }: { citations: Citation[] }) {
  return (
    <>
      {citations.map((c) => (
        <TooltipPrimitive.Root key={`web:${c.n}`} delayDuration={200}>
          <TooltipPrimitive.Trigger asChild>
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              <GlobeIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{c.site || c.title}</span>
            </a>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side="top"
              sideOffset={6}
              collisionPadding={12}
              className="z-50 w-[22rem] max-w-[calc(100vw-24px)] rounded-xl border bg-popover p-3 shadow-lg"
            >
              <CitationCard c={c} />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      ))}
    </>
  );
}
