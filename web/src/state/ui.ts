import { create } from 'zustand';

/** Ephemeral, non-persisted UI state shared across sibling components (e.g. the
 *  artifacts sidebar, which a message turn opens but `App` renders). Kept out of
 *  `prefs` so it never persists across reloads. */
interface UiState {
  /** Right-side artifacts/files drawer. */
  artifactsOpen: boolean;
  setArtifactsOpen: (open: boolean) => void;
  /** Right-side plan drawer (a proposed plan awaiting approval). Auto-opens when
   *  a plan is proposed; the user can collapse it and reopen from the approval bar. */
  planPanelOpen: boolean;
  setPlanPanelOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  artifactsOpen: false,
  setArtifactsOpen: (artifactsOpen) => set({ artifactsOpen }),
  planPanelOpen: false,
  setPlanPanelOpen: (planPanelOpen) => set({ planPanelOpen }),
}));
