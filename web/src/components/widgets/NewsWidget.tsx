import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLinkIcon, NewspaperIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WidgetProps } from './registry';

type Dict = Record<string, unknown>;

const asDict = (value: unknown): Dict =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
const asList = (value: unknown): Dict[] =>
  Array.isArray(value) ? value.filter((v): v is Dict => !!v && typeof v === 'object') : [];
const asStr = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNum = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** How long ago, in words. Publication timestamps ARE absolute instants (unlike
 *  the weather card's location-local stamps), so `new Date` is correct here —
 *  but an engine can hand back a stamp without a zone, which the browser then
 *  reads as its own. Close enough for "3 h" and it degrades to the date. */
function relativeAge(iso: string, locale: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  // A negative age means a clock or timezone disagreement, not the future.
  // Showing "in 2 hours" on a news card looks broken; "just now" doesn't.
  if (minutes < 60) return t('news.justNow');
  if (minutes < 60 * 24) return t('news.hoursAgo', { count: Math.round(minutes / 60) });
  const days = Math.round(minutes / (60 * 24));
  if (days <= 7) return t('news.daysAgo', { count: days });
  return new Date(then).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Article image, served through the app's own proxy.
 *
 *  The `src` is never the publisher's URL: that would put the request back in
 *  the user's browser, which is the thing the proxy exists to prevent. The
 *  publisher URL is a parameter, and the backend fetches, validates and
 *  re-serves the bytes from this origin (see routes/news_routes.py).
 *
 *  A thumbnail is decoration, so every way it can fail ends the same way — the
 *  card renders without it. The proxy legitimately refuses images (admin domain
 *  policy, a non-image response, a dead link), and a card that shows a broken-
 *  image glyph for that is worse than one that simply has no picture.
 *
 *  `reserve` keeps the slot when there is nothing to put in it. With the image
 *  on the LEFT, a missing one would pull that row's text 76px out of line with
 *  its neighbours, and a list whose left edge moves per row is hard to read. So
 *  as soon as any article in the card has a picture, every row keeps the space —
 *  including a row whose image fails to load after the fact, which would
 *  otherwise make the text jump sideways while the user is looking at it.
 *
 *  The empty slot is drawn, not left blank: a bordered tile with a newspaper
 *  glyph reads as "this article has no picture", where 64px of nothing reads as
 *  a rendering bug. */
function ThumbnailFallback() {
  return (
    <div
      aria-hidden
      className="flex size-16 shrink-0 items-center justify-center rounded-md border border-dashed bg-muted/40"
    >
      <NewspaperIcon className="size-5 text-muted-foreground/30" />
    </div>
  );
}

function Thumbnail({ url, alt, reserve }: { url: string; alt: string; reserve: boolean }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!url || failed) return reserve ? <ThumbnailFallback /> : null;
  return (
    // The image sits ON the placeholder rather than replacing it, so the tile is
    // there from the first paint and the row never reflows when the bytes land.
    <div className="relative size-16 shrink-0">
      <ThumbnailFallback />
      <img
        src={`/api/news/thumbnail?url=${encodeURIComponent(url)}`}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          'absolute inset-0 size-16 rounded-md border bg-muted object-cover transition-opacity',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

export function NewsWidget({ data }: WidgetProps) {
  const { t, i18n } = useTranslation();
  const payload = asDict(data);
  const articles = asList(payload.articles);
  const query = asStr(payload.query);
  const hidden = asNum(payload.hiddenByPolicy);

  if (articles.length === 0) return null;

  // One column or none: the rows share a left edge only if they all reserve the
  // image slot, and reserving it in a card where nothing has a picture would be
  // an empty margin down the side for no reason.
  const anyThumbnail = articles.some((article) => asStr(article.thumbnail));

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <NewspaperIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{query || t('news.title')}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {t('news.count', { count: articles.length })}
        </span>
      </div>

      <div>
        {articles.map((article, i) => {
          const url = asStr(article.url);
          const age = relativeAge(asStr(article.published), i18n.language, t);
          const source = asStr(article.source);
          return (
            <a
              key={url || i}
              href={url}
              target="_blank"
              // `noreferrer` as well as `noopener`: the destination is a site the
              // user has not chosen to visit, and it does not get told which
              // Talos chat sent them.
              rel="noopener noreferrer"
              className={`group block px-4 py-3 transition-colors hover:bg-accent ${i > 0 ? 'border-t border-border/40' : ''}`}
            >
              <div className="flex gap-3">
                {/* Empty alt: the headline beside it already says what this is,
                    so a screen reader announcing the image too is noise. */}
                <Thumbnail url={asStr(article.thumbnail)} alt="" reserve={anyThumbnail} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {source && <span className="min-w-0 truncate font-medium">{source}</span>}
                    {source && age && <span aria-hidden>·</span>}
                    {age && <span className="shrink-0">{age}</span>}
                    <ExternalLinkIcon className="ml-auto size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                  </div>
                  {/* `hover:` on the headline itself, not `group-hover:` on the
                      row. The whole row is one link, so a row-scoped underline
                      fires while the pointer is over the teaser, the source or
                      the picture — the text reacts to a hover that is nowhere
                      near it, which reads as the entire item underlining. The
                      row still answers the pointer with its background, so it
                      is still visibly one click target.

                      Scoped to a span rather than the block: `text-decoration`
                      on a block box is painted through every in-flow descendant,
                      so a wrapper carrying it would take the teaser with it. */}
                  <div className="mt-0.5 text-sm font-medium text-strong">
                    <span className="hover:underline">{asStr(article.title)}</span>
                  </div>
                  {asStr(article.snippet) && (
                    <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {asStr(article.snippet)}
                    </div>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>

      {hidden > 0 && (
        <div className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">
          {t('news.hiddenByPolicy', { count: hidden })}
        </div>
      )}
    </div>
  );
}
