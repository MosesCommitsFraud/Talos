import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n, { type Lang } from '@/i18n';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type SortMode = 'active' | 'newest' | 'name';
export type ChatMode = 'chat' | 'knowledge' | 'full';
export type { Lang };

/** Per-surface visibility toggles — the new-UI equivalent of legacy's
 *  Appearance tab (show/hide modules across sidebar, chat area, chat bar). */
export interface Visibility {
  sidebarBrain: boolean;
  sidebarLibrary: boolean;
  sidebarUserBar: boolean;
  sidebarSettingsBtn: boolean;
  chatHeader: boolean;
  welcomeText: boolean;
  showThinking: boolean;
  incognitoBtn: boolean;
  messageMetrics: boolean;
  composerAttach: boolean;
  composerPlan: boolean;
  composerDocs: boolean;
  composerDb: boolean;
  composerModelPicker: boolean;
  contextMeter: boolean;
}

export const DEFAULT_VISIBILITY: Visibility = {
  sidebarBrain: true,
  sidebarLibrary: true,
  sidebarUserBar: true,
  sidebarSettingsBtn: true,
  chatHeader: true,
  welcomeText: true,
  showThinking: true,
  incognitoBtn: true,
  messageMetrics: true,
  composerAttach: true,
  composerPlan: true,
  composerDocs: true,
  composerDb: true,
  composerModelPicker: true,
  contextMeter: true,
};

interface PrefsState {
  theme: Theme;
  density: Density;
  sortMode: SortMode;
  lang: Lang;
  visibility: Visibility;
  /** Composer knowledge sources. The chat-input control (mode dropdown when
   *  both are configured, single toggle when one is) drives these; they map to
   *  the use_rag / use_db request flags. Default on so "Full Knowledge" is the
   *  out-of-the-box mode. */
  planMode: boolean;
  useRag: boolean;
  useDb: boolean;
  incognito: boolean;
  /** Compact (icon-only) sidebar mode. */
  sidebarCollapsed: boolean;
  /** Names of sidebar folders the user has collapsed. */
  collapsedFolders: string[];
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  setSortMode: (m: SortMode) => void;
  setLang: (l: Lang) => void;
  setVisibility: (key: keyof Visibility, value: boolean) => void;
  resetVisibility: () => void;
  toggle: (key: 'planMode' | 'useRag' | 'useDb' | 'incognito') => void;
  /** Set both knowledge flags at once (used by the mode dropdown). */
  setKnowledge: (useRag: boolean, useDb: boolean) => void;
  toggleSidebar: () => void;
  toggleFolder: (name: string) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      density: 'comfortable',
      sortMode: 'active',
      lang: 'en',
      visibility: DEFAULT_VISIBILITY,
      planMode: false,
      useRag: true,
      useDb: true,
      incognito: false,
      sidebarCollapsed: false,
      collapsedFolders: [],
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setSortMode: (sortMode) => set({ sortMode }),
      setLang: (lang) => { void i18n.changeLanguage(lang); set({ lang }); },
      setVisibility: (key, value) => set((s) => ({ visibility: { ...s.visibility, [key]: value } })),
      resetVisibility: () => set({ visibility: DEFAULT_VISIBILITY }),
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<PrefsState>),
      setKnowledge: (useRag, useDb) => set({ useRag, useDb }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleFolder: (name) => set((s) => ({
        collapsedFolders: s.collapsedFolders.includes(name)
          ? s.collapsedFolders.filter((n) => n !== name)
          : [...s.collapsedFolders, name],
      })),
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

/** Sync i18next + <html lang> with the stored language. */
export function applyLang(lang: Lang) {
  if (i18n.language !== lang) void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
}
