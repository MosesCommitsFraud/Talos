import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type SortMode = 'active' | 'newest' | 'name';

/** Per-surface visibility toggles — the new-UI equivalent of legacy's
 *  Appearance tab (show/hide modules across sidebar, chat area, chat bar). */
export interface Visibility {
  sidebarBrain: boolean;
  sidebarLibrary: boolean;
  composerPlan: boolean;
  composerDocs: boolean;
  composerDb: boolean;
  contextMeter: boolean;
  messageMetrics: boolean;
}

export const DEFAULT_VISIBILITY: Visibility = {
  sidebarBrain: true,
  sidebarLibrary: true,
  composerPlan: true,
  composerDocs: true,
  composerDb: true,
  contextMeter: true,
  messageMetrics: true,
};

interface PrefsState {
  theme: Theme;
  density: Density;
  sortMode: SortMode;
  visibility: Visibility;
  /** Composer toggles — mirror the legacy chat-bar switches. */
  planMode: boolean;
  useRag: boolean;
  useDb: boolean;
  incognito: boolean;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  setSortMode: (m: SortMode) => void;
  setVisibility: (key: keyof Visibility, value: boolean) => void;
  resetVisibility: () => void;
  toggle: (key: 'planMode' | 'useRag' | 'useDb' | 'incognito') => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      density: 'comfortable',
      sortMode: 'active',
      visibility: DEFAULT_VISIBILITY,
      planMode: false,
      useRag: false,
      useDb: false,
      incognito: false,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setSortMode: (sortMode) => set({ sortMode }),
      setVisibility: (key, value) => set((s) => ({ visibility: { ...s.visibility, [key]: value } })),
      resetVisibility: () => set({ visibility: DEFAULT_VISIBILITY }),
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<PrefsState>),
    }),
    {
      name: 'talos-prefs',
      // Old persisted states predate `visibility`; merge so new keys exist.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsState>;
        return { ...current, ...p, visibility: { ...DEFAULT_VISIBILITY, ...(p.visibility ?? {}) } };
      },
    },
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
