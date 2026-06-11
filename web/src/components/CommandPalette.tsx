import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon, MessageSquareIcon, MoonIcon, SearchIcon, SettingsIcon, SquarePenIcon, SunIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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

export function CommandPalette({ open, onClose, onOpenSettings }: { open: boolean; onClose: () => void; onOpenSettings?: () => void }) {
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

  const entries = useMemo<PaletteEntry[]>(() => {
    const q = query.toLowerCase().trim();
    const actions: PaletteEntry[] = [
      { id: 'new', label: 'New chat', icon: <SquarePenIcon />, run: () => { newChat(); onClose(); } },
      {
        id: 'theme',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme === 'dark' ? <SunIcon /> : <MoonIcon />,
        run: () => {
          const next = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          applyTheme(next);
          onClose();
        },
      },
      { id: 'settings', label: 'Open settings', icon: <SettingsIcon />, run: () => { onOpenSettings?.(); onClose(); } },
      { id: 'legacy', label: 'Open legacy UI', icon: <ExternalLinkIcon />, run: () => { window.location.href = '/legacy'; } },
    ].filter((a) => !q || a.label.toLowerCase().includes(q));

    const chats: PaletteEntry[] = (sessions ?? [])
      .filter((s) => !s.archived && (!q || (s.name ?? '').toLowerCase().includes(q)))
      .slice(0, 12)
      .map((s) => ({
        id: s.id,
        label: s.name || 'Untitled',
        hint: s.model,
        icon: <MessageSquareIcon />,
        run: () => { void openSession(s.id); onClose(); },
      }));

    return [...actions, ...chats];
  }, [query, sessions, theme, newChat, onClose, onOpenSettings, openSession, setTheme]);

  const clampedSelected = Math.min(selected, Math.max(0, entries.length - 1));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className="fixed top-[18vh] left-1/2 z-50 w-[min(600px,92vw)] -translate-x-1/2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-[0_24px_64px_rgb(0_0_0/0.45)]"
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b px-4">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((v) => Math.min(v + 1, entries.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((v) => Math.max(v - 1, 0)); }
                if (e.key === 'Enter') { e.preventDefault(); entries[clampedSelected]?.run(); }
              }}
              placeholder="Search chats and actions…"
              className="h-12 w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-1.5">
            {entries.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                onClick={entry.run}
                onMouseEnter={() => setSelected(i)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                  i === clampedSelected && 'bg-accent',
                )}
              >
                {entry.icon}
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint && <span className="shrink-0 text-xs text-muted-foreground">{entry.hint}</span>}
              </button>
            ))}
            {entries.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">No matches</div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
