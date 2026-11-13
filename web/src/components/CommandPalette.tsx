import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BrainIcon,
  CornerDownLeftIcon,
  DatabaseIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  SunIcon,
  TicketIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSessions, searchMessages } from '@/api/client';
import { useChat } from '@/state/chat';
import { applyTheme, usePrefs } from '@/state/prefs';
import { cn, formatRelativeTime, timestampMs } from '@/lib/utils';
import { useKeybinds } from '@/lib/keybinds';
import { useAuth } from './auth/AuthGate';
import { requestSettingsPanel } from './ComposerAddMenu';
import { Kbd, KbdHint, KeybindingPill } from './ui/kbd';
import { Segmented } from './ui/segmented';

/** What the search looks through. `all` is everything at once, each kind in
 *  its own group; the others narrow the list to one kind and lift its cap. */
type Scope = 'all' | 'chats' | 'messages' | 'actions';

interface PaletteEntry {
  id: string;
  label: string;
  /** Second line: for a message hit, the words around the match. */
  detail?: string;
  /** Muted text at the row's right edge: a time, a shortcut's stand-in. */
  hint?: React.ReactNode;
  icon: React.ReactNode;
  run: () => void;
}

interface PaletteGroup {
  key: Exclude<Scope, 'all'> | 'settings';
  label: string;
  items: PaletteEntry[];
}

const USER_PANELS = ['appearance', 'personalization', 'memory', 'shortcuts', 'account', 'usage'];
const ADMIN_PANELS = ['models', 'ai', 'assistants', 'integrations', 'web', 'mcpServers', 'mcp', 'tools', 'skills', 'system'];

/** `text` with every occurrence of `needle` marked, so the eye lands on why a
 *  row matched. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (;;) {
    const hit = lower.indexOf(needle, at);
    if (hit < 0) break;
    if (hit > at) parts.push(text.slice(at, hit));
    parts.push(
      <mark key={hit} className="rounded-[3px] bg-primary/20 text-foreground">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    at = hit + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The search: one field over chats (by title), messages (by their text),
 *  actions and settings pages. Typing filters all four at once; the pills under
 *  the field narrow it to one. Arrow keys move, Enter opens, Tab steps through
 *  the pills. */
export function CommandPalette({ open, onClose, onOpenSettings, onOpenRag, onOpenUsers, onOpenTickets, onOpenMemories }: { open: boolean; onClose: () => void; onOpenSettings?: () => void; onOpenRag?: () => void; onOpenUsers?: () => void; onOpenTickets?: () => void; onOpenMemories?: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, enabled: open });
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const keybinds = useKeybinds();
  const auth = useAuth();
  const isAdmin = !!auth?.is_admin || auth?.auth_enabled === false;

  useEffect(() => {
    if (open) {
      setQuery('');
      setScope('all');
      setSelected(0);
    }
  }, [open]);

  const needle = query.toLowerCase().trim();
  // The message search asks the server, so it waits for a pause in typing.
  const [asked, setAsked] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setAsked(needle), 180);
    return () => window.clearTimeout(id);
  }, [needle]);
  const wantsMessages = open && asked.length >= 2 && (scope === 'all' || scope === 'messages');
  const { data: hits, isFetching: searching } = useQuery({
    queryKey: ['message-search', asked, scope === 'messages'],
    queryFn: () => searchMessages(asked, scope === 'messages' ? 40 : 6),
    enabled: wantsMessages,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const groups = useMemo<PaletteGroup[]>(() => {
    const done = (fn: () => void) => () => { fn(); onClose(); };
    const matches = (label: string) => !needle || label.toLowerCase().includes(needle);

    const actions: PaletteEntry[] = [
      { id: 'new', label: t('palette.newChat'), icon: <SquarePenIcon />, hint: keybinds.new_session ? <KeybindingPill value={keybinds.new_session} /> : undefined, run: done(newChat) },
      {
        id: 'theme',
        label: theme === 'dark' ? t('palette.switchLight') : t('palette.switchDark'),
        icon: theme === 'dark' ? <SunIcon /> : <MoonIcon />,
        run: done(() => {
          const next = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          applyTheme(next);
        }),
      },
      { id: 'settings', label: t('palette.openSettings'), icon: <SettingsIcon />, run: done(() => onOpenSettings?.()) },
      ...(isAdmin && onOpenRag ? [{ id: 'rag', label: t('palette.openRag'), icon: <DatabaseIcon />, run: done(onOpenRag) }] : []),
      ...(isAdmin && onOpenUsers ? [{ id: 'users', label: t('palette.openUsers'), icon: <UsersIcon />, run: done(onOpenUsers) }] : []),
      ...(isAdmin && onOpenTickets ? [{ id: 'tickets', label: t('palette.openTickets'), icon: <TicketIcon />, run: done(onOpenTickets) }] : []),
      ...(isAdmin && onOpenMemories ? [{ id: 'memories', label: t('palette.openMemories'), icon: <BrainIcon />, run: done(onOpenMemories) }] : []),
    ].filter((a) => matches(a.label));

    // A settings page is only worth a row once it is being looked for.
    const settings: PaletteEntry[] = needle
      ? [...USER_PANELS, ...(isAdmin ? ADMIN_PANELS : [])]
          .map((id) => ({ id, label: t(`settings.nav.${id}`) }))
          .filter((p) => matches(p.label))
          .map((p) => ({
            id: `settings:${p.id}`,
            label: p.label,
            hint: t('sidebar.menu.settings'),
            icon: <SlidersHorizontalIcon />,
            run: done(() => requestSettingsPanel(p.id, 'all')),
          }))
      : [];

    const chats: PaletteEntry[] = (sessions ?? [])
      .filter((s) => !s.archived && matches(s.name ?? ''))
      .sort((a, b) => timestampMs(b.last_message_at ?? b.updated_at) - timestampMs(a.last_message_at ?? a.updated_at))
      .slice(0, scope === 'chats' ? 50 : needle ? 6 : 8)
      .map((s) => ({
        id: `chat:${s.id}`,
        label: s.name || t('common.untitled'),
        hint: formatRelativeTime(s.last_message_at ?? s.updated_at),
        icon: <MessageSquareIcon />,
        run: done(() => void openSession(s.id)),
      }));

    const messages: PaletteEntry[] = (wantsMessages && asked === needle ? (hits ?? []) : []).map((h, i) => ({
      id: `msg:${h.session_id}:${i}`,
      label: h.session_name || t('common.untitled'),
      detail: h.content_snippet.replace(/\s+/g, ' ').trim(),
      hint: formatRelativeTime(h.timestamp),
      icon: <MessageSquareTextIcon />,
      run: done(() => void openSession(h.session_id)),
    }));

    const all: PaletteGroup[] = [
      { key: 'chats', label: needle ? t('palette.chats') : t('palette.recentChats'), items: chats },
      { key: 'messages', label: t('palette.messages'), items: messages },
      { key: 'actions', label: t('palette.actions'), items: actions },
      { key: 'settings', label: t('sidebar.menu.settings'), items: settings },
    ];
    // With nothing typed, what can be done comes before what was last open.
    if (!needle) all.unshift(...all.splice(2, 1));
    return all.filter(
      (g) => g.items.length > 0 && (scope === 'all' || g.key === scope || (scope === 'actions' && g.key === 'settings')),
    );
  }, [needle, asked, scope, sessions, hits, wantsMessages, theme, keybinds.new_session, isAdmin, newChat, onClose, onOpenSettings, onOpenRag, onOpenUsers, onOpenTickets, onOpenMemories, openSession, setTheme, t]);

  // Flatten for keyboard navigation; track a running index across groups.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const clampedSelected = Math.min(selected, Math.max(0, flat.length - 1));

  // Keep the selected row in view when the arrow keys walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [clampedSelected]);

  const scopes: Scope[] = ['all', 'chats', 'messages', 'actions'];
  const waiting = wantsMessages && (searching || asked !== needle);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 data-[state=closed]:opacity-0" />
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(1rem,4vh)] sm:py-[12vh]">
          <DialogPrimitive.Content
            className="pointer-events-auto flex max-h-[min(34rem,100%)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-popover text-foreground shadow-[0_24px_64px_-16px_rgb(0_0_0/0.55)] outline-none transition-[scale,opacity] duration-150 ease-out data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0"
            onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
          >
            <DialogPrimitive.Title className="sr-only">{t('palette.searchTitle')}</DialogPrimitive.Title>
            <div className="flex h-12 shrink-0 items-center gap-2.5 px-4">
              <SearchIcon className="size-[18px] shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((v) => Math.min(v + 1, flat.length - 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((v) => Math.max(v - 1, 0)); }
                  if (e.key === 'Enter') { e.preventDefault(); flat[clampedSelected]?.run(); }
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const step = e.shiftKey ? scopes.length - 1 : 1;
                    setScope(scopes[(scopes.indexOf(scope) + step) % scopes.length]);
                    setSelected(0);
                  }
                }}
                placeholder={t('palette.searchPlaceholder')}
                aria-label={t('palette.searchTitle')}
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-strong outline-none placeholder:text-muted-foreground/70"
              />
              {query ? (
                <button
                  type="button"
                  aria-label={t('palette.clear')}
                  onClick={() => { setQuery(''); setSelected(0); inputRef.current?.focus(); }}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : (
                <Kbd className="shrink-0">Esc</Kbd>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3 border-t px-3 py-2">
              <Segmented<Scope>
                size="sm"
                label={t('palette.scope')}
                value={scope}
                onChange={(v) => { setScope(v); setSelected(0); inputRef.current?.focus(); }}
                options={scopes.map((s) => ({ value: s, label: t(`palette.scopes.${s}`) }))}
              />
              {waiting && <span className="text-xs text-muted-foreground">{t('palette.searching')}</span>}
            </div>

            <div ref={listRef} className="min-h-0 flex-1 scroll-py-2 overflow-y-auto border-t px-2 pb-2">
              {groups.map((group) => {
                const base = flat.findIndex((e) => e.id === group.items[0]?.id);
                return (
                  <div key={group.key}>
                    <div className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.label}</div>
                    {group.items.map((entry, i) => {
                      const index = base + i;
                      const active = index === clampedSelected;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          data-selected={active}
                          onClick={entry.run}
                          onMouseMove={() => { if (!active) setSelected(index); }}
                          className={cn(
                            'flex w-full cursor-default items-center gap-2.5 rounded-lg px-2 text-left text-sm',
                            entry.detail ? 'py-1.5' : 'h-9',
                            active && 'bg-accent',
                          )}
                        >
                          <span className={cn('flex shrink-0 text-muted-foreground [&>svg]:size-4', entry.detail && 'self-start pt-0.5')}>
                            {entry.icon}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cn('block truncate', active ? 'text-strong' : 'text-foreground')}>
                              {entry.detail ? entry.label : <Highlight text={entry.label} needle={needle} />}
                            </span>
                            {entry.detail && (
                              <span className="block truncate text-xs text-muted-foreground">
                                <Highlight text={entry.detail} needle={needle} />
                              </span>
                            )}
                          </span>
                          {entry.hint && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{entry.hint}</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {flat.length === 0 && (
                <div className="px-2 py-10 text-center text-sm text-muted-foreground">
                  {waiting
                    ? t('palette.searching')
                    : scope === 'messages' && needle.length < 2
                      ? t('palette.typeToSearch')
                      : t('palette.noMatches')}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <KbdHint keys={[<ArrowUpIcon key="up" />, <ArrowDownIcon key="down" />]}>
                  {t('palette.navigate')}
                </KbdHint>
                <KbdHint keys={[<CornerDownLeftIcon key="enter" />]}>{t('palette.select')}</KbdHint>
                <KbdHint keys={['Tab']}>{t('palette.scope')}</KbdHint>
              </div>
              <span className="tabular-nums">{t('palette.resultCount', { count: flat.length })}</span>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
