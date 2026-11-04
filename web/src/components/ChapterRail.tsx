import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { UiMessage } from '@/state/chat';

/** How far below the top of the chat a chapter counts as the one being read. */
const READING_LINE_PX = 120;

function chapterBlock(scroller: HTMLElement, dbId: string) {
  return scroller.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(dbId)}"]`);
}

/** The chapters of a chat as small dashes at its left edge. Hovering opens the
 *  list with their titles, and a click jumps to the message. The list starts with
 *  the start of the chat, so the way back to the top is always there too. */
export function ChapterRail({
  messages,
  scroller,
}: {
  messages: UiMessage[];
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const chapters = useMemo(
    () => messages.filter((m) => m.chapter && m.dbId).map((m) => ({ dbId: m.dbId as string, title: m.chapter?.title ?? null })),
    [messages],
  );
  // Index into the list below: 0 is the start of the chat.
  const [current, setCurrent] = useState(0);
  const chapterKey = chapters.map((c) => c.dbId).join(' ');

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      const box = el.getBoundingClientRect();
      // At the very end nothing can scroll up to the line any more, so whatever
      // is on screen has been reached.
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      const line = atEnd ? box.bottom : box.top + READING_LINE_PX;
      let reached = 0;
      chapterKey.split(' ').forEach((dbId, index) => {
        const block = dbId ? chapterBlock(el, dbId) : null;
        if (block && block.getBoundingClientRect().top <= line) reached = index + 1;
      });
      setCurrent(reached);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [scroller, chapterKey]);

  if (chapters.length === 0) return null;

  const jump = (dbId: string | null) => {
    const el = scroller.current;
    if (!el) return;
    if (!dbId) el.scrollTo({ top: 0, behavior: 'smooth' });
    else chapterBlock(el, dbId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const entries = [{ dbId: null as string | null, title: t('messages.chapterStart') as string | null }, ...chapters];

  return (
    <nav
      aria-label={t('messages.chapters')}
      className="group/rail absolute top-1/2 left-3 z-20 -translate-y-1/2"
    >
      <div aria-hidden className="flex flex-col items-start gap-1.5 py-2 pe-2">
        {entries.map((entry, index) => (
          <button
            key={entry.dbId ?? 'start'}
            type="button"
            tabIndex={-1}
            onClick={() => jump(entry.dbId)}
            className="flex h-1.5 items-center"
          >
            <span
              className={cn(
                'h-0.5 w-3 rounded-full transition-colors',
                index === current ? 'bg-foreground' : 'bg-muted-foreground/50',
              )}
            />
          </button>
        ))}
      </div>
      {/* Opacity, not visibility: the list's buttons stay reachable by keyboard,
          and focus inside it opens it the same way hovering does. */}
      <div className="pointer-events-none absolute top-1/2 left-full -translate-y-1/2 ps-1 opacity-0 transition-opacity group-focus-within/rail:pointer-events-auto group-focus-within/rail:opacity-100 group-hover/rail:pointer-events-auto group-hover/rail:opacity-100">
        <div className="dropdown-glass max-h-[60vh] w-max max-w-72 overflow-y-auto rounded-xl p-1.5">
          {entries.map((entry, index) => (
            <button
              key={entry.dbId ?? 'start'}
              type="button"
              onClick={() => jump(entry.dbId)}
              aria-current={index === current ? 'location' : undefined}
              className={cn(
                'flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
                index === current ? 'text-strong' : 'text-muted-foreground',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-0.5 w-3 shrink-0 rounded-full',
                  index === current ? 'bg-foreground' : 'bg-muted-foreground/50',
                )}
              />
              {entry.title ? (
                <span className="min-w-0 truncate">{entry.title}</span>
              ) : (
                <span className="shimmer-text-muted min-w-0 truncate">{t('messages.chapterPending')}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
