import { create } from 'zustand';
import type { ArtifactSelection } from '@/api/types';

/** Ephemeral, non-persisted UI state shared across sibling components (e.g. the
 *  artifacts sidebar, which a message turn opens but `App` renders). Kept out of
 *  `prefs` so it never persists across reloads. */
/** Top-level surface shown in the main column. `chat` is the default; `rag`
 *  swaps in the full-screen knowledge-base workspace (deep-linkable at `#/rag`),
 *  `users` in the admin user/usage workspace (`#/users`), `tickets` in the
 *  admin support-ticket workspace (`#/tickets`), and `projects` / `artifacts` /
 *  `customize` in the three pages the sidebar's primary nav opens. */
export type AppView = 'chat' | 'rag' | 'users' | 'tickets' | 'projects' | 'artifacts' | 'customize';

export interface PreviewFile {
  sessionId: string;
  path: string;
  /** Fetch the bytes from here instead of the session-artifact endpoint. Set for
   *  files that aren't workspace artifacts — chat uploads, which live under
   *  /api/upload/<id> and belong to no session. */
  url?: string;
  name: string;
  mime?: string;
  content?: string;
  language?: string;
  version?: number;
  streaming?: boolean;
}

/** Map the URL hash to a view on first load so `#/rag` and `#/users` open
 *  their workspaces directly. */
function viewFromHash(): AppView {
  if (typeof location === 'undefined') return 'chat';
  // First segment only: the knowledge-base workspace uses deeper hashes
  // (`#/rag/<id>`, `#/rag/global`) to deep-link one base, and all of them still
  // resolve to the `rag` view.
  const slug = location.hash.replace(/^#\/?/, '').split('/')[0];
  return slug === 'rag' || slug === 'users' || slug === 'tickets' || slug === 'projects' || slug === 'artifacts' || slug === 'customize'
    ? slug
    : 'chat';
}

interface UiState {
  /** Which top-level surface is shown (chat vs. the /rag workspace). */
  view: AppView;
  setView: (view: AppView) => void;
  /** Right-side preview panel. The session's file list lives in the chat
   *  header's file menu; the panel only ever shows `preview`. */
  artifactsOpen: boolean;
  setArtifactsOpen: (open: boolean) => void;
  /** Preview spread over the chat column (the sidebar stays). Dropped whenever
   *  the panel closes, so the next file opens beside the chat again. */
  previewFullscreen: boolean;
  setPreviewFullscreen: (fullscreen: boolean) => void;
  /** Right-side drawer listing the session's background jobs and their live
   *  output. Opened from the task chip in the working row; never auto-opens —
   *  a job runs precisely so the reader can carry on with something else. */
  tasksPanelOpen: boolean;
  setTasksPanelOpen: (open: boolean) => void;
  /** The turn's `update_plan` checklist as its own pane of the right dock.
   *  Opens with the first plan of a turn (see the stream handler). */
  planPanelOpen: boolean;
  setPlanPanelOpen: (open: boolean) => void;
  /** Full-screen image viewer. Set to open a zoomable/downloadable lightbox over
   *  any image (tool output, generated image, artifact); null when closed. */
  lightbox: { src: string; label?: string } | null;
  openLightbox: (image: { src: string; label?: string }) => void;
  closeLightbox: () => void;
  /** Resizable document preview panel. Set to open it on a specific workspace
   *  file (markdown, text, Word, Excel, pdf, image…); null when closed. */
  preview: PreviewFile | null;
  openPreview: (file: PreviewFile) => void;
  updatePreview: (patch: Partial<PreviewFile>) => void;
  closePreview: () => void;
  artifactSelection: ArtifactSelection | null;
  setArtifactSelection: (selection: ArtifactSelection | null) => void;
  /** Project whose chats the sidebar list is narrowed to; null = loose chats.
   *  Shared state rather than the sidebar's own, because the Projects page
   *  opens a project too. */
  openProject: string | null;
  setOpenProject: (name: string | null) => void;
  /** The "Create a project" modal — opened from the sidebar's + and from the
   *  Projects page's "New project" button. */
  createProjectOpen: boolean;
  setCreateProjectOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  view: viewFromHash(),
  setView: (view) => {
    // Keep the URL hash in sync so the workspace is shareable/refresh-safe,
    // without pulling in a router.
    if (typeof history !== 'undefined') {
      history.replaceState(
        null,
        '',
        view === 'chat' ? location.pathname + location.search : `#/${view}`,
      );
    }
    set({ view });
  },
  artifactsOpen: false,
  setArtifactsOpen: (artifactsOpen) => set(artifactsOpen ? { artifactsOpen } : { artifactsOpen, previewFullscreen: false }),
  previewFullscreen: false,
  setPreviewFullscreen: (previewFullscreen) => set({ previewFullscreen }),
  tasksPanelOpen: false,
  setTasksPanelOpen: (tasksPanelOpen) => set({ tasksPanelOpen }),
  planPanelOpen: false,
  setPlanPanelOpen: (planPanelOpen) => set({ planPanelOpen }),
  lightbox: null,
  openLightbox: (lightbox) => set({ lightbox }),
  closeLightbox: () => set({ lightbox: null }),
  preview: null,
  // Selecting a file opens the panel on it.
  openPreview: (preview) => set({ preview, artifactsOpen: true }),
  updatePreview: (patch) => set((state) => ({
    preview: state.preview ? { ...state.preview, ...patch } : null,
  })),
  closePreview: () => set({ preview: null, artifactsOpen: false, previewFullscreen: false }),
  artifactSelection: null,
  setArtifactSelection: (artifactSelection) => set({ artifactSelection }),
  openProject: null,
  setOpenProject: (openProject) => set({ openProject }),
  createProjectOpen: false,
  setCreateProjectOpen: (createProjectOpen) => set({ createProjectOpen }),
}));

/** Whether the right dock shows anything (preview, plan or task pane). The
 *  chat header hands its files button to the dock while it does. */
export const selectDockOpen = (s: UiState) =>
  (s.artifactsOpen && !!s.preview) || s.planPanelOpen || s.tasksPanelOpen;
