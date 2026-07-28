import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  DatabaseIcon,
  MessageSquareIcon,
  MoonIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
  UsersIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSessions } from '@/api/client';
import { useChat } from '@/state/chat';
import { applyTheme, usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { useAuth } from './auth/AuthGate';
import { KbdHint } from './ui/kbd';
import { SearchInput } from './ui/search';

interface PaletteEntry {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

interface PaletteGroup {
  label: string;
  items: PaletteEntry[];
}

export function CommandPalette({ open, onClose, onOpenSettings, onOpenRag, onOpenUsers }: { open: boolean; onClose: () => void; onOpenSettings?: () => void; onOpenRag?: () => void; onOpenUsers?: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, enabled: open });
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const auth = useAuth();

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const q = query.toLowerCase().trim();
    const actions: PaletteEntry[] = [
      { id: 'new', label: t('palette.newChat'), icon: <SquarePenIcon />, run: () => { newChat(); onClose(); } },
      {
        id: 'theme',
        label: theme === 'dark' ? t('palette.switchLight') : t('palette.switchDark'),
        icon: theme === 'dark' ? <SunIcon /> : <MoonIcon />,
        run: () => {
          const next = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          applyTheme(next);
          onClose();
        },
      },
      { id: 'settings', label: t('palette.openSettings'), icon: <SettingsIcon />, run: () => { onOpenSettings?.(); onClose(); } },
      ...(auth?.is_admin && onOpenRag
        ? [{ id: 'rag', label: t('palette.openRag'), icon: <DatabaseIcon />, run: () => { onOpenRag(); onClose(); } }]
        : []),
      ...(auth?.is_admin && onOpenUsers
        ? [{ id: 'users', label: t('palette.openUsers'), icon: <UsersIcon />, run: () => { onOpenUsers(); onClose(); } }]
        : []),
    ].filter((a) => !q || a.label.toLowerCase().includes(q));

    const chats: PaletteEntry[] = (sessions ?? [])
      .filter((s) => !s.archived && (!q || (s.name ?? '').toLowerCase().includes(q)))
      .slice(0, 12)
      .map((s) => ({
        id: s.id,
        label: s.name || t('common.untitled'),
        hint: s.model,
        icon: <MessageSquareIcon />,
        run: () => { void openSession(s.id); onClose(); },
      }));

    const next: PaletteGroup[] = [];
    if (actions.length) next.push({ label: t('palette.actions'), items: actions });
    if (chats.length) next.push({ label: t('palette.recentChats'), items: chats });
    return next;
  }, [query, sessions, theme, newChat, onClose, onOpenSettings, onOpenRag, onOpenUsers, auth?.is_admin, openSession, setTheme, t]);

  // Flatten for keyboard navigation; track a running index across groups.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const clampedSelected = Math.min(selected, Math.max(0, flat.length - 1));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop fixed inset-0 z-50 transition-opacity duration-200 data-[state=closed]:opacity-0" />
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(1rem,4vh)] sm:py-[10vh]">
          <DialogPrimitive.Content
            className="dialog-glass pointer-events-auto flex max-h-[26.25rem] w-full max-w-xl flex-col overflow-hidden rounded-2xl text-foreground outline-none transition-[scale,opacity] duration-200 ease-in-out data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0"
            onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
          >
            <DialogPrimitive.Title className="sr-only">{t('palette.searchTitle')}</DialogPrimitive.Title>
            <div className="px-2.5 py-1.5">
              <SearchInput
                bare
                size="lg"
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((v) => Math.min(v + 1, flat.length - 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((v) => Math.max(v - 1, 0)); }
                  if (e.key === 'Enter') { e.preventDefault(); flat[clampedSelected]?.run(); }
                }}
                placeholder={t('palette.searchPlaceholder')}
              />
            </div>

            <div className="min-h-0 flex-1 scroll-py-2 overflow-y-auto border-t p-2">
              {groups.map((group) => {
                const base = flat.findIndex((e) => e.id === group.items[0]?.id);
                return (
                  <div key={group.label} className="not-first:mt-1.5">
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{group.label}</div>
                    {group.items.map((entry, i) => {
                      const index = base + i;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={entry.run}
                          onMouseEnter={() => setSelected(index)}
                          className={cn(
                            "flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-base sm:min-h-7 sm:text-sm [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='text-'])]:text-muted-foreground",
                            index === clampedSelected && 'bg-foreground/[0.09] text-foreground',
                          )}
                        >
                          {entry.icon}
                          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                          {entry.hint && <span className="shrink-0 text-xs text-muted-foreground">{entry.hint}</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {flat.length === 0 && (
                <div className="p-6 text-center text-base text-muted-foreground sm:text-sm">{t('palette.noMatches')}</div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 bg-foreground/[0.025] px-5 py-3 text-xs font-medium text-muted-foreground [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground">
              <div className="flex items-center gap-3">
                <KbdHint keys={[<ArrowUpIcon key="up" />, <ArrowDownIcon key="down" />]}>
                  {t('palette.navigate')}
                </KbdHint>
                <KbdHint keys={[<CornerDownLeftIcon key="enter" />]}>{t('palette.select')}</KbdHint>
              </div>
              <KbdHint keys={['Esc']}>{t('palette.close')}</KbdHint>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
