import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light' | 'system';

interface PrefsState {
  theme: Theme;
  /** Composer toggles — mirror the legacy chat-bar switches. */
  planMode: boolean;
  useRag: boolean;
  useDb: boolean;
  useWeb: boolean;
  incognito: boolean;
  setTheme: (t: Theme) => void;
  toggle: (key: 'planMode' | 'useRag' | 'useDb' | 'useWeb' | 'incognito') => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      planMode: false,
      useRag: false,
      useDb: false,
      useWeb: false,
      incognito: false,
      setTheme: (theme) => set({ theme }),
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<PrefsState>),
    }),
    { name: 'talos-prefs' },
  ),
);

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
