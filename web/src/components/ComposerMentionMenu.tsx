import { useQuery } from '@tanstack/react-query';
import { BookOpenIcon, DatabaseIcon, GlobeIcon, TelescopeIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchCapabilities } from '@/api/client';
import { useSessionFiles } from '@/lib/useSessionFiles';
import { cn } from '@/lib/utils';
import { usePrefs } from '@/state/prefs';
import { FileTypeIcon } from './FileTypeIcon';

/** One thing "@" can reach: a source to switch on or off for the messages
 *  that follow, or a file of this chat to point the message at. */
export interface MentionItem {
  key: string;
  group: 'sources' | 'files';
  icon: ReactNode;
  title: string;
  desc?: string;
  /** Sources only: switched on right now. */
  active?: boolean;
  /** Files: the text that replaces the "@…" being typed. */
  insert?: string;
  /** Sources: flips the switch; the "@…" is then removed from the text. */
  run?: () => void;
}

/** The "@…" at the end of the text, if the user is typing one: the word after
 *  an "@" that starts the text or follows whitespace (so an e-mail address is
 *  left alone). Returns the query without the "@". */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match ? match[1] : null;
}

/** The text cut into plain runs and references, for the composer to tint the
 *  references. A reference is "@" plus the name of one of the chat's files
 *  (which may contain spaces), or the "@…" still being typed at the end. */
export function mentionRuns(text: string, names: string[]): Array<{ text: string; mention: boolean }> {
  const escaped = [...names]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Known names first, so "@Mein Bericht.xlsx" is one reference and not "@Mein".
  const pattern = new RegExp(`(^|\\s)(@(?:${[...escaped, '[^\\s@]*$'].join('|')}))`, 'g');
  const runs: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) runs.push({ text: text.slice(last, start), mention: false });
    runs.push({ text: match[2], mention: true });
    last = start + match[2].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), mention: false });
  return runs;
}

/** Where a reference that ends at `caret` begins, or -1 when the caret is not
 *  at the end of one. A reference is one piece: Backspace behind it takes all
 *  of it, not its last letter — half a file name points at nothing. The space
 *  that picking a file adds after it belongs to it while it is the end of the
 *  text, so one Backspace undoes one pick. */
export function mentionStartBefore(text: string, caret: number, names: string[]): number {
  let end = caret;
  if (end === text.length && text[end - 1] === ' ') end -= 1;
  const before = text.slice(0, end);
  for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const token = `@${name}`;
    if (!before.endsWith(token)) continue;
    const start = before.length - token.length;
    if (start === 0 || /\s/.test(before[start - 1])) return start;
  }
  return -1;
}

/** Everything "@" offers for this chat, narrowed to `query` (null = not
 *  mentioning, so nothing). Sources first — they are few and always the same —
 *  then the chat's files, newest outputs before uploads. */
export function useMentionItems(query: string | null, sessionId: string | null): MentionItem[] {
  const { t } = useTranslation();
  const { data: caps } = useQuery({ queryKey: ['capabilities'], queryFn: fetchCapabilities, staleTime: 60_000 });
  const useWeb = usePrefs((s) => s.useWeb);
  const useRag = usePrefs((s) => s.useRag);
  const useDb = usePrefs((s) => s.useDb);
  const deepResearch = usePrefs((s) => s.deepResearch);
  const toggle = usePrefs((s) => s.toggle);
  const setKnowledge = usePrefs((s) => s.setKnowledge);
  const { outputs, inputs } = useSessionFiles(sessionId);

  if (query === null) return [];

  const items: MentionItem[] = [
    {
      key: 'web',
      group: 'sources',
      icon: <GlobeIcon />,
      title: t('composer.webSearch'),
      desc: t('composer.webSearchDesc'),
      active: useWeb,
      run: () => toggle('useWeb'),
    },
  ];
  if (caps?.rag) {
    items.push({
      key: 'rag',
      group: 'sources',
      icon: <BookOpenIcon />,
      title: t('composer.mention.knowledge'),
      desc: t('composer.ragDesc'),
      active: useRag,
      run: () => setKnowledge(!useRag, useDb),
    });
  }
  if (caps?.sql) {
    items.push({
      key: 'sql',
      group: 'sources',
      icon: <DatabaseIcon />,
      title: t('composer.mention.database'),
      desc: t('composer.sqlTooltip'),
      active: useDb,
      run: () => setKnowledge(useRag, !useDb),
    });
  }
  items.push({
    key: 'deep',
    group: 'sources',
    icon: <TelescopeIcon />,
    title: t('composer.deepResearch'),
    desc: t('composer.deepResearchDesc'),
    active: deepResearch,
    run: () => toggle('deepResearch'),
  });

  const seen = new Set<string>();
  const file = (name: string, desc: string) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push({
      key: `file:${name}`,
      group: 'files',
      icon: <FileTypeIcon path={name} />,
      title: name,
      desc,
      insert: `@${name} `,
    });
  };
  for (const f of outputs) file(f.name, t('composer.mention.fileOutput'));
  for (const f of inputs) file(f.name ?? '', t('composer.mention.fileUpload'));

  const needle = query.toLowerCase();
  if (!needle) return items;
  // A name that starts with what was typed beats one that merely contains it:
  // "@res" means result.csv, not Deep Research. Sorting is stable, so within a
  // rank the order above holds.
  const rank = (title: string): number => {
    const name = title.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.split(/[\s._-]+/).some((word) => word.startsWith(needle))) return 1;
    return name.includes(needle) ? 2 : 3;
  };
  return items
    .map((item) => ({ item, rank: rank(item.title) }))
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.item);
}

/** The list above the composer while an "@…" is being typed: sources and
 *  files, one row each — mark, name, a word about it, and "active" on a
 *  source that is switched on. The composer owns the keys; this only draws. */
export function ComposerMentionMenu({
  items,
  searching,
  index,
  onHover,
  onPick,
}: {
  items: MentionItem[];
  /** Something has been typed after the "@": the list is ranked, not grouped. */
  searching: boolean;
  index: number;
  onHover: (index: number) => void;
  onPick: (item: MentionItem) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-mention-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <div className="dropdown-glass absolute inset-x-0 bottom-full z-40 mb-1.5 overflow-hidden rounded-xl text-popover-foreground">
      <div ref={list} role="listbox" aria-label={t('composer.mention.label')} className="max-h-72 overflow-y-auto p-1.5">
        {items.length === 0 && (
          <div className="px-2 py-2 text-sm text-muted-foreground">{t('composer.mention.empty')}</div>
        )}
        {items.map((item, i) => (
          <div key={item.key}>
            {/* A search result is one ranked list; the headings would chop it up. */}
            {!searching && (i === 0 || items[i - 1].group !== item.group) && (
              <div className={cn('px-2 pb-1 text-xs font-medium text-muted-foreground', i === 0 ? 'pt-1' : 'pt-2.5')}>
                {t(`composer.mention.${item.group}`)}
              </div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === index}
              data-mention-index={i}
              // Keeps the caret in the textarea: the row is picked, not focused.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(item)}
              className={cn(
                'flex min-h-9 w-full cursor-default items-center gap-2.5 rounded-lg px-2 text-left text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
                i === index && 'bg-accent text-accent-foreground',
              )}
            >
              {item.icon}
              <span className="max-w-[55%] shrink-0 truncate font-medium text-strong">{item.title}</span>
              {item.desc && <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{item.desc}</span>}
              {item.active && (
                <span className="ml-auto shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  {t('composer.active')}
                </span>
              )}
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-border/70 px-3.5 py-2 text-xs text-muted-foreground">{t('composer.mention.keys')}</div>
    </div>
  );
}
