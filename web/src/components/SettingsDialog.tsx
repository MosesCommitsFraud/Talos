import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon, KeyboardIcon, LogOutIcon, PaletteIcon, UserIcon } from 'lucide-react';
import { useState } from 'react';
import { fetchAuthInfo, logout } from '@/api/client';
import { applyTheme, usePrefs, type Theme } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogSection } from './ui/dialog';
import { Kbd } from './ui/misc';

type Panel = 'appearance' | 'shortcuts' | 'account';

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['⌘', 'K'], label: 'Search chats & actions' },
  { keys: ['Enter'], label: 'Send message' },
  { keys: ['Shift', 'Enter'], label: 'New line' },
  { keys: ['Esc'], label: 'Close dialog / stop renaming' },
];

function ThemeOption({ value, current, onPick, label }: { value: Theme; current: Theme; onPick: (t: Theme) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className={cn(
        'flex-1 rounded-lg border px-3 py-2 text-sm transition-colors',
        current === value ? 'border-ring bg-accent font-medium' : 'hover:bg-accent/60',
      )}
    >
      {label}
    </button>
  );
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [panel, setPanel] = useState<Panel>('appearance');
  const { data: auth } = useQuery({ queryKey: ['auth'], queryFn: fetchAuthInfo, staleTime: Infinity });
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  const nav: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: 'Appearance', icon: <PaletteIcon /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <KeyboardIcon /> },
    { id: 'account', label: 'Account', icon: <UserIcon /> },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title="Settings" className="w-[min(640px,94vw)]">
        <div className="flex min-h-72">
          <div className="w-40 shrink-0 space-y-0.5 border-r p-2">
            {nav.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setPanel(n.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:text-muted-foreground',
                  panel === n.id ? 'bg-accent font-medium' : 'hover:bg-accent/60',
                )}
              >
                {n.icon}
                {n.label}
              </button>
            ))}
            <a
              href="/legacy"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [&_svg]:size-4"
            >
              <ExternalLinkIcon />
              All settings
            </a>
          </div>

          <div className="min-w-0 flex-1">
            {panel === 'appearance' && (
              <DialogSection className="space-y-4">
                <div>
                  <div className="mb-2 text-sm font-medium">Theme</div>
                  <div className="flex gap-2">
                    <ThemeOption value="dark" current={theme} onPick={pickTheme} label="Dark" />
                    <ThemeOption value="light" current={theme} onPick={pickTheme} label="Light" />
                    <ThemeOption value="system" current={theme} onPick={pickTheme} label="System" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Density, background effects and per-module visibility still live in the legacy
                  settings until they're ported.
                </p>
              </DialogSection>
            )}

            {panel === 'shortcuts' && (
              <DialogSection className="space-y-1">
                {SHORTCUTS.map((s) => (
                  <div key={s.label} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm">
                    <span>{s.label}</span>
                    <span className="flex gap-1">
                      {s.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </DialogSection>
            )}

            {panel === 'account' && (
              <DialogSection className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {(auth?.user ?? 'U').slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-medium">{auth?.user ?? 'User'}</div>
                    <div className="text-xs text-muted-foreground">
                      {auth?.is_admin ? 'Administrator' : 'Member'}
                      {auth?.auth_enabled === false && ' · auth disabled'}
                    </div>
                  </div>
                </div>
                {auth?.auth_enabled !== false && (
                  <Button variant="outline" onClick={() => void logout()}>
                    <LogOutIcon /> Log out
                  </Button>
                )}
              </DialogSection>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
