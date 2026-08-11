import { useTranslation } from 'react-i18next';
import { ExternalLinkIcon, NewspaperIcon } from 'lucide-react';
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

export function NewsWidget({ data }: WidgetProps) {
  const { t, i18n } = useTranslation();
  const payload = asDict(data);
  const articles = asList(payload.articles);
  const query = asStr(payload.query);
  const hidden = asNum(payload.hiddenByPolicy);

  if (articles.length === 0) return null;

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
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {source && <span className="min-w-0 truncate font-medium">{source}</span>}
                {source && age && <span aria-hidden>·</span>}
                {age && <span className="shrink-0">{age}</span>}
                <ExternalLinkIcon className="ml-auto size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
              </div>
              <div className="mt-0.5 text-sm font-medium text-strong group-hover:underline">
                {asStr(article.title)}
              </div>
              {asStr(article.snippet) && (
                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {asStr(article.snippet)}
                </div>
              )}
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
