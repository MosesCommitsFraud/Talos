import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n, { DEFAULT_LANG, pickLang, type Lang } from '@/i18n';
import { toast } from '@/components/ui/toast';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type SortMode = 'active' | 'newest' | 'name';
export type ChatMode = 'chat' | 'knowledge' | 'sql' | 'full';
export type LlmLang = 'auto' | Lang;
/** Qwen3.8 thinking budget, cheapest first. Mirrors the model's
 *  `reasoning_effort` chat-template kwarg. */
export type ReasoningEffort = 'low' | 'medium' | 'xhigh';

/** A sidebar/Projects-page project. `name` is the folder label the server
 *  stores on each member chat; everything else exists only here. */
export interface Project {
  name: string;
  description?: string;
  /** ISO timestamp — the date the project cards show. */
  createdAt?: string;
}
export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'xhigh'];
export type { Lang };

/** Per-surface visibility toggles — the new-UI equivalent of legacy's
 *  Appearance tab (show/hide modules across sidebar, chat area, chat bar). */
export interface Visibility {
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
  sidebarUserBar: true,
  sidebarSettingsBtn: true,
  chatHeader: true,
  welcomeText: true,
  // Off by default: the reasoning is long, and the status beside the working
  // timer already says the model is thinking. Readers who want the text turn it
  // on in Settings → Visibility.
  showThinking: false,
  incognitoBtn: true,
  messageMetrics: true,
  composerAttach: true,
  composerPlan: true,
  composerDocs: true,
  composerDb: true,
  composerModelPicker: true,
  contextMeter: true,
};

/* ── showThinking's flipped default ──
 * It used to default on, so every install that predates the change carries an
 * explicit `true` — in localStorage and in the server-side copy — and would
 * keep showing reasoning forever despite the new default. Until the reader
 * expresses an opinion by toggling it (the status label in the working row, or
 * Settings → Visibility), the default wins over both stored copies. After that
 * their choice is theirs and is left alone. */
const THINKING_CHOICE_KEY = 'talos-thinking-choice';

const thinkingChosen = (): boolean => {
  try { return localStorage.getItem(THINKING_CHOICE_KEY) === '1'; } catch { return false; }
};

const rememberThinkingChoice = (): void => {
  try { localStorage.setItem(THINKING_CHOICE_KEY, '1'); } catch { /* storage disabled — the default just keeps applying */ }
};

const withThinkingDefault = (visibility: Visibility): Visibility =>
  thinkingChosen() ? visibility : { ...visibility, showThinking: DEFAULT_VISIBILITY.showThinking };

interface PrefsState {
  theme: Theme;
  density: Density;
  sortMode: SortMode;
  lang: Lang;
  /** False until the reader picks a language themselves — see pickLang. */
  langChosen: boolean;
  llmLang: LlmLang;
  visibility: Visibility;
  /** Composer knowledge sources. The chat-input control (mode dropdown when
   *  both are configured, single toggle when one is) drives these; they map to
   *  the use_rag / use_db request flags. Default on so "Full Knowledge" is the
   *  out-of-the-box mode. */
  planMode: boolean;
  useRag: boolean;
  useDb: boolean;
  /** Model reasoning/thinking. Maps to the `reasoning` request flag; when off,
   *  the backend tells vLLM `enable_thinking: false`. Default on. */
  reasoning: boolean;
  /** How long the model may think while reasoning is on. Maps to the
   *  `reasoning_effort` request flag; ignored when reasoning is off. */
  reasoningEffort: ReasoningEffort;
  incognito: boolean;
  /** Preferred microphone for voice dictation; null = system default. */
  micDeviceId: string | null;
  /** Compact (icon-only) sidebar mode. */
  sidebarCollapsed: boolean;
  /** Projects listed in the sidebar. A project is only a label carried by its
   *  chats, so the server knows about the ones that already have a member —
   *  this list is what keeps a freshly created, still-empty project on screen
   *  until the first chat moves into it, and the only place a project's
   *  description lives. */
  projects: Project[];
  /** Width (px) of the resizable artifact preview panel. */
  previewWidth: number;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  setSortMode: (m: SortMode) => void;
  setLang: (l: Lang) => void;
  setLlmLang: (l: LlmLang) => void;
  setReasoningEffort: (e: ReasoningEffort) => void;
  setVisibility: (key: keyof Visibility, value: boolean) => void;
  resetVisibility: () => void;
  toggle: (key: 'planMode' | 'useRag' | 'useDb' | 'reasoning' | 'incognito') => void;
  /** Set both knowledge flags at once (used by the mode dropdown). */
  setKnowledge: (useRag: boolean, useDb: boolean) => void;
  setMicDeviceId: (id: string | null) => void;
  toggleSidebar: () => void;
  addProject: (name: string, description?: string) => void;
  /** Follow a project through a rename; `to === null` drops it from the list. */
  renameProjectPref: (from: string, to: string | null) => void;
  setPreviewWidth: (px: number) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      density: 'comfortable',
      sortMode: 'active',
      lang: DEFAULT_LANG,
      langChosen: false,
      llmLang: 'auto',
      visibility: DEFAULT_VISIBILITY,
      planMode: false,
      useRag: true,
      useDb: true,
      reasoning: true,
      reasoningEffort: 'medium',
      incognito: false,
      micDeviceId: null,
      sidebarCollapsed: false,
      projects: [],
      previewWidth: 480,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setSortMode: (sortMode) => set({ sortMode }),
      // Picking a language is the reader stating an opinion, which from here on
      // outranks the flipped default (see pickLang in @/i18n).
      setLang: (lang) => { void i18n.changeLanguage(lang); set({ lang, langChosen: true }); },
      setLlmLang: (llmLang) => set({ llmLang }),
      setReasoningEffort: (reasoningEffort) => set({ reasoningEffort }),
      setVisibility: (key, value) => {
        // Toggling it is the reader stating a preference, which from here on
        // outranks the flipped default (see THINKING_CHOICE_KEY).
        if (key === 'showThinking') {
          rememberThinkingChoice();
          // The status caption that flips this sits at the very bottom of a
          // long turn, and what it flips can be several screens up — so the
          // switch confirms itself in the corner instead of leaving the reader
          // to scroll and check. Fired here rather than in the caption so the
          // same confirmation appears when Settings flips it too.
          if (value !== get().visibility.showThinking) {
            toast(value ? 'thinking.shownToast' : 'thinking.hiddenToast');
          }
        }
        set((s) => ({ visibility: { ...s.visibility, [key]: value } }));
      },
      resetVisibility: () => set({ visibility: DEFAULT_VISIBILITY }),
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<PrefsState>),
      setKnowledge: (useRag, useDb) => set({ useRag, useDb }),
      setMicDeviceId: (micDeviceId) => set({ micDeviceId }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      addProject: (name, description) => set((s) => {
        const existing = s.projects.find((p) => p.name === name);
        // Re-adding a known name only fills in a description it was missing —
        // creating a project whose folder already has chats must not wipe it.
        if (existing) {
          if (!description || existing.description === description) return {};
          return {
            projects: s.projects.map((p) => (p.name === name ? { ...p, description } : p)),
          };
        }
        return {
          projects: [...s.projects, { name, description, createdAt: new Date().toISOString() }],
        };
      }),
      renameProjectPref: (from, to) => set((s) => {
        const moved = s.projects.find((p) => p.name === from);
        const rest = s.projects.filter((p) => p.name !== from && p.name !== to);
        // Carry the description across a rename; dropping it on delete is the
        // point — the project is gone, not renamed.
        return { projects: to ? [...rest, { ...moved, name: to }] : rest };
      }),
      setPreviewWidth: (previewWidth) => set({ previewWidth }),
    }),
    {
      name: 'talos-prefs',
      // Old persisted states predate `visibility`; merge so new keys exist.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsState>;
        return {
          ...current,
          ...p,
          visibility: withThinkingDefault({ ...DEFAULT_VISIBILITY, ...(p.visibility ?? {}) }),
          lang: pickLang(p.lang, p.langChosen),
          // Projects were bare names before they gained a description.
          projects: ((p.projects ?? []) as Array<string | Project>).map((entry) =>
            typeof entry === 'string' ? { name: entry } : entry,
          ),
        };
      },
    },
  ),
);

/* ── Per-user server sync ──
 * localStorage keeps prefs fast and offline-capable, but it's per-browser.
 * The durable, user-scoped copy lives server-side in /api/prefs under the
 * `ui` key: hydrate from it after login (server wins), then push changes
 * back debounced. Device-ish state (sidebar width, collapsed folders,
 * incognito, plan mode, mic) intentionally stays local-only. */

const SYNCED_KEYS = [
  'theme', 'density', 'sortMode', 'lang', 'langChosen', 'llmLang', 'visibility',
  'useRag', 'useDb', 'reasoning', 'reasoningEffort',
] as const;
type SyncedKey = (typeof SYNCED_KEYS)[number];
type SyncedPrefs = Pick<PrefsState, SyncedKey>;

const UI_PREF_KEY = 'ui';
let hydrating = false;
let syncStarted = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hydratedFor: string | null = null;

function collectSynced(): SyncedPrefs {
  const s = usePrefs.getState();
  return Object.fromEntries(SYNCED_KEYS.map((k) => [k, s[k]])) as unknown as SyncedPrefs;
}

function startPrefsPush() {
  if (syncStarted) return;
  syncStarted = true;
  usePrefs.subscribe((state, prev) => {
    if (hydrating) return;
    if (SYNCED_KEYS.every((k) => state[k] === prev[k])) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void import('@/api/client').then(({ saveUserPref }) =>
        saveUserPref(UI_PREF_KEY, collectSynced()).catch(() => { /* offline/401 — local copy stands */ }),
      );
    }, 600);
  });
}

/** Pull this user's prefs from the server and start pushing changes back.
 *  Call once auth is settled; `who` distinguishes users so switching accounts
 *  in the same browser re-hydrates. */
export async function syncPrefsForUser(who: string): Promise<void> {
  if (hydratedFor === who) return;
  hydratedFor = who;
  try {
    const { fetchUserPref } = await import('@/api/client');
    const value = await fetchUserPref<Partial<SyncedPrefs>>(UI_PREF_KEY);
    if (value && typeof value === 'object') {
      hydrating = true;
      const patch: Partial<PrefsState> = {};
      for (const k of SYNCED_KEYS) {
        if (value[k] !== undefined) (patch as Record<string, unknown>)[k] = value[k];
      }
      // The server copy carries the old default too, so it gets the same
      // treatment as the local one.
      patch.visibility = withThinkingDefault({ ...DEFAULT_VISIBILITY, ...(value.visibility ?? {}) });
      // Server wins, so a blob predating `langChosen` counts as "never picked"
      // and lands on the default even if this browser thinks otherwise.
      patch.langChosen = !!value.langChosen;
      patch.lang = pickLang(value.lang, value.langChosen);
      usePrefs.setState(patch);
      void i18n.changeLanguage(patch.lang);
      hydrating = false;
    } else {
      // First login on this account: seed the server with the local prefs.
      const { saveUserPref } = await import('@/api/client');
      await saveUserPref(UI_PREF_KEY, collectSynced()).catch(() => undefined);
    }
  } catch {
    // Server unreachable — keep local prefs, still push future changes.
  }
  startPrefsPush();
}

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
