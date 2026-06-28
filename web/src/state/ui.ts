import { create } from 'zustand';

/** Ephemeral, non-persisted UI state shared across sibling components (e.g. the
 *  artifacts sidebar, which a message turn opens but `App` renders). Kept out of
 *  `prefs` so it never persists across reloads. */
/** Top-level surface shown in the main column. `chat` is the default; `rag`
 *  swaps in the full-screen knowledge-base workspace (deep-linkable at `#/rag`). */
export type AppView = 'chat' | 'rag';

/** Map the URL hash to a view on first load so `#/rag` opens the workspace. */
function viewFromHash(): AppView {
  return typeof location !== 'undefined' && location.hash.replace(/^#\/?/, '') === 'rag'
    ? 'rag'
    : 'chat';
}

interface UiState {
  /** Which top-level surface is shown (chat vs. the /rag workspace). */
  view: AppView;
  setView: (view: AppView) => void;
  /** Right-side artifacts/files drawer. */
  artifactsOpen: boolean;
  setArtifactsOpen: (open: boolean) => void;
  /** Right-side plan drawer (a proposed plan awaiting approval). Auto-opens when
   *  a plan is proposed; the user can collapse it and reopen from the approval bar. */
  planPanelOpen: boolean;
  setPlanPanelOpen: (open: boolean) => void;
  /** Full-screen image viewer. Set to open a zoomable/downloadable lightbox over
   *  any image (tool output, generated image, artifact); null when closed. */
  lightbox: { src: string; label?: string } | null;
  openLightbox: (image: { src: string; label?: string }) => void;
  closeLightbox: () => void;
  /** Resizable document preview panel. Set to open it on a specific workspace
   *  file (markdown, text, Word, Excel, pdf, image…); null when closed. */
  preview: { sessionId: string; path: string; name: string; mime?: string } | null;
  openPreview: (file: { sessionId: string; path: string; name: string; mime?: string }) => void;
  closePreview: () => void;
}

export const useUi = create<UiState>((set) => ({
  view: viewFromHash(),
  setView: (view) => {
    // Keep the URL hash in sync so the workspace is shareable/refresh-safe,
    // without pulling in a router.
    if (typeof history !== 'undefined') {
      history.replaceState(null, '', view === 'rag' ? '#/rag' : location.pathname + location.search);
    }
    set({ view });
  },
  artifactsOpen: false,
  setArtifactsOpen: (artifactsOpen) => set({ artifactsOpen }),
  planPanelOpen: false,
  setPlanPanelOpen: (planPanelOpen) => set({ planPanelOpen }),
  lightbox: null,
  openLightbox: (lightbox) => set({ lightbox }),
  closeLightbox: () => set({ lightbox: null }),
  preview: null,
  openPreview: (preview) => set({ preview }),
  closePreview: () => set({ preview: null }),
}));
