import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type SortMode = 'active' | 'newest' | 'name';

interface PrefsState {
  theme: Theme;
  density: Density;
  sortMode: SortMode;
  /** Composer toggles — mirror the legacy chat-bar switches. */
  planMode: boolean;
  useRag: boolean;
  useDb: boolean;
  useWeb: boolean;
  incognito: boolean;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  setSortMode: (m: SortMode) => void;
  toggle: (key: 'planMode' | 'useRag' | 'useDb' | 'useWeb' | 'incognito') => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      density: 'comfortable',
      sortMode: 'active',
      planMode: false,
      useRag: false,
      useDb: false,
      useWeb: false,
      incognito: false,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setSortMode: (sortMode) => set({ sortMode }),
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<PrefsState>),
    }),
    { name: 'talos-prefs' },
  ),
);

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Everything is rem-based, so density is one root font-size. */
export function applyDensity(density: Density) {
  document.documentElement.style.fontSize = { compact: '14px', comfortable: '16px', spacious: '17px' }[density];
}
