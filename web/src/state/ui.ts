import { create } from 'zustand';
import type { ArtifactSelection } from '@/api/types';

/** Ephemeral, non-persisted UI state shared across sibling components (e.g. the
 *  artifacts sidebar, which a message turn opens but `App` renders). Kept out of
 *  `prefs` so it never persists across reloads. */
/** Top-level surface shown in the main column. `chat` is the default; `rag`
 *  swaps in the full-screen knowledge-base workspace (deep-linkable at `#/rag`),
 *  `users` in the admin user/usage workspace (`#/users`), `tickets` in the
 *  admin support-ticket workspace (`#/tickets`), `memories` in the admin page for
 *  the model's notes on the databases (`#/memories`), and `projects` / `artifacts`
 *  / `customize` in the three pages the sidebar's primary nav opens. */
export type AppView = 'chat' | 'rag' | 'users' | 'tickets' | 'memories' | 'projects' | 'artifacts' | 'customize';

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
  return slug === 'rag' || slug === 'users' || slug === 'tickets' || slug === 'memories' || slug === 'projects' || slug === 'artifacts' || slug === 'customize'
    ? slug
    : 'chat';
}

/** `#/projects/<id>` opens that project's page on load. */
function projectFromHash(): string | null {
  if (typeof location === 'undefined') return null;
  const [slug, id] = location.hash.replace(/^#\/?/, '').split('/');
  return slug === 'projects' && id ? decodeURIComponent(id) : null;
}

function hashFor(view: AppView, openProject: string | null): string {
  if (view === 'chat') return location.pathname + location.search;
  if (view === 'projects' && openProject) return `#/projects/${encodeURIComponent(openProject)}`;
  return `#/${view}`;
}

interface UiState {
  /** Which top-level surface is shown (chat vs. the /rag workspace). */
  view: AppView;
  setView: (view: AppView) => void;
  /** Set by a form while it holds unsaved work. Leaving goes through it, and it
   *  calls `proceed` once the user has decided; if they stay, it never does. */
  leaveGuard: ((proceed: () => void) => void) | null;
  setLeaveGuard: (guard: ((proceed: () => void) => void) | null) => void;
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
  /** Admin-only pane charting the open chat's turn metrics (tokens split
   *  into thinking/answer/tool calls, timing, speed, context, tools). */
  metricsPanelOpen: boolean;
  setMetricsPanelOpen: (open: boolean) => void;
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
  /** Id of the project on screen. The Projects page shows it, and the sidebar list
   *  narrows to the user's chats in it; null = the list of projects, loose chats. */
  openProject: string | null;
  setOpenProject: (name: string | null) => void;
  /** The "Create a project" modal — opened from the sidebar's + and from the
   *  Projects page's "New project" button. */
  createProjectOpen: boolean;
  setCreateProjectOpen: (open: boolean) => void;
  /** In a narrow window the sidebar starts collapsed regardless of the saved
   *  preference; this is the user having opened it there, for this visit. */
  sidebarNarrowOpen: boolean;
  setSidebarNarrowOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set, get) => ({
  view: viewFromHash(),
  setView: (view) => {
    const go = () => {
      // Keep the URL hash in sync so the workspace is shareable/refresh-safe,
      // without pulling in a router.
      if (typeof history !== 'undefined') {
        history.replaceState(
          null,
          '',
          hashFor(view, get().openProject),
        );
      }
      set({ view });
    };
    const { leaveGuard, view: current } = get();
    if (leaveGuard && view !== current) leaveGuard(go);
    else go();
  },
  leaveGuard: null,
  setLeaveGuard: (leaveGuard) => set({ leaveGuard }),
  artifactsOpen: false,
  setArtifactsOpen: (artifactsOpen) => set(artifactsOpen ? { artifactsOpen } : { artifactsOpen, previewFullscreen: false }),
  previewFullscreen: false,
  setPreviewFullscreen: (previewFullscreen) => set({ previewFullscreen }),
  tasksPanelOpen: false,
  setTasksPanelOpen: (tasksPanelOpen) => set({ tasksPanelOpen }),
  metricsPanelOpen: false,
  setMetricsPanelOpen: (metricsPanelOpen) => set({ metricsPanelOpen }),
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
  openProject: projectFromHash(),
  setOpenProject: (openProject) => {
    set({ openProject });
    if (typeof history !== 'undefined' && get().view === 'projects') {
      history.replaceState(null, '', hashFor('projects', openProject));
    }
  },
  createProjectOpen: false,
  setCreateProjectOpen: (createProjectOpen) => set({ createProjectOpen }),
  sidebarNarrowOpen: false,
  setSidebarNarrowOpen: (sidebarNarrowOpen) => set({ sidebarNarrowOpen }),
}));

/* ── Per-chat dock layout ──
   The right dock (file preview, background tasks, metrics) belongs to the chat
   it was opened in. Leaving a chat files its layout away under the chat's id;
   coming back puts it up again exactly as it was left, and a chat that never
   had anything open shows nothing. Kept in localStorage so it also survives a
   reload. */

interface DockSnapshot {
  tasks?: boolean;
  metrics?: boolean;
  fullscreen?: boolean;
  preview?: PreviewFile;
}

/** This page's layouts, complete. The stored copy below is the same minus what
 *  cannot be fetched again after a reload. */
const dockLayouts = new Map<string, DockSnapshot>();

const DOCK_KEY = 'talos-dock-layouts';
/** Layouts kept. Oldest go first: a chat last visited that long ago can open bare. */
const DOCK_KEEP = 200;

function readDockLayouts(): Record<string, DockSnapshot> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DockSnapshot>) : {};
  } catch {
    return {};
  }
}

function writeDockLayout(id: string, snapshot: DockSnapshot | null) {
  if (snapshot) dockLayouts.set(id, snapshot);
  else dockLayouts.delete(id);
  try {
    const all = readDockLayouts();
    // Re-inserting moves the chat to the end, so trimming drops the stalest.
    delete all[id];
    if (snapshot) {
      const stored: DockSnapshot = { ...snapshot };
      // A document draft is held in the page, not in a file: after a reload
      // there is nothing to load it from, so only its panes are kept.
      if (stored.preview && /^(streaming-)?document:/.test(stored.preview.path)) {
        delete stored.preview;
        delete stored.fullscreen;
      } else if (stored.preview) {
        const { sessionId, path, url, name, mime, version } = stored.preview;
        stored.preview = { sessionId, path, url, name, mime, version };
      }
      if (Object.keys(stored).length > 0) all[id] = stored;
    }
    const ids = Object.keys(all);
    for (const stale of ids.slice(0, Math.max(0, ids.length - DOCK_KEEP))) delete all[stale];
    localStorage.setItem(DOCK_KEY, JSON.stringify(all));
  } catch {
    /* private mode or a full store: the layout just is not remembered */
  }
}

/** Called by the chat store when the chat on screen changes. `adopt` is the one
 *  case where nothing moves: a draft that has just become a chat by its first
 *  message keeps what was open around it. */
export function switchDockLayout(from: string | null, to: string | null, adopt = false) {
  const s = useUi.getState();
  if (from) {
    const previewOpen = s.artifactsOpen && !!s.preview && !s.preview.streaming;
    const snapshot: DockSnapshot = {};
    if (s.tasksPanelOpen) snapshot.tasks = true;
    if (s.metricsPanelOpen) snapshot.metrics = true;
    if (previewOpen && s.preview) {
      snapshot.preview = s.preview;
      if (s.previewFullscreen) snapshot.fullscreen = true;
    }
    writeDockLayout(from, Object.keys(snapshot).length > 0 ? snapshot : null);
  }
  if (adopt) return;
  const next = (to && (dockLayouts.get(to) ?? readDockLayouts()[to])) || {};
  useUi.setState({
    tasksPanelOpen: !!next.tasks,
    metricsPanelOpen: !!next.metrics,
    preview: next.preview ?? null,
    artifactsOpen: !!next.preview,
    previewFullscreen: !!next.preview && !!next.fullscreen,
  });
}

/** Open one knowledge base in the /rag workspace from anywhere else in the app.
 *  The hash comes first: the workspace reads it when it mounts, and listens for
 *  it when it is already showing. */
export function openRagBase(id: string) {
  location.hash = `#/rag/${encodeURIComponent(id)}`;
  useUi.setState({ view: 'rag' });
}

/** Whether the right dock shows anything (preview, task or metrics pane). The chat header hands its files button to the dock while it does. */
export const selectDockOpen = (s: UiState) =>
  (s.artifactsOpen && !!s.preview) || s.tasksPanelOpen || s.metricsPanelOpen;
