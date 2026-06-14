import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  MessageSquareIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchSessions } from '@/api/client';
import { useChat } from '@/state/chat';
import { applyTheme, usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Kbd } from './ui/misc';

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

export function CommandPalette({ open, onClose, onOpenSettings }: { open: boolean; onClose: () => void; onOpenSettings?: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, enabled: open });
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);

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
  }, [query, sessions, theme, newChat, onClose, onOpenSettings, openSession, setTheme, t]);

  // Flatten for keyboard navigation; track a running index across groups.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const clampedSelected = Math.min(selected, Math.max(0, flat.length - 1));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/60 backdrop-blur-[2px] data-[state=closed]:opacity-0 data-[state=open]:opacity-100" />
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(1rem,10vh)]">
          <DialogPrimitive.Content
            className="pointer-events-auto flex max-h-[26.25rem] w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-[0_24px_64px_rgb(0_0_0/0.45)] outline-none data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0"
            onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
          >
            <DialogPrimitive.Title className="sr-only">{t('palette.searchTitle')}</DialogPrimitive.Title>
            <div className="flex items-center gap-2.5 px-3.5 py-3">
              <SearchIcon className="size-[18px] shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((v) => Math.min(v + 1, flat.length - 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((v) => Math.max(v - 1, 0)); }
                  if (e.key === 'Enter') { e.preventDefault(); flat[clampedSelected]?.run(); }
                }}
                placeholder={t('palette.searchPlaceholder')}
                className="h-6 w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto border-t p-2">
              {groups.map((group) => {
                const base = flat.findIndex((e) => e.id === group.items[0]?.id);
                return (
                  <div key={group.label} className="not-first:mt-2">
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground/70">{group.label}</div>
                    {group.items.map((entry, i) => {
                      const index = base + i;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={entry.run}
                          onMouseEnter={() => setSelected(index)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                            index === clampedSelected && 'bg-accent',
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
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">{t('palette.noMatches')}</div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <Kbd className="[&_svg]:size-3"><ArrowUpIcon /></Kbd>
                  <Kbd className="[&_svg]:size-3"><ArrowDownIcon /></Kbd>
                  <span className="text-muted-foreground/80">{t('palette.navigate')}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd className="[&_svg]:size-3"><CornerDownLeftIcon /></Kbd>
                  <span className="text-muted-foreground/80">{t('palette.select')}</span>
                </span>
              </div>
              <span className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd>
                <span className="text-muted-foreground/80">{t('palette.close')}</span>
              </span>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
