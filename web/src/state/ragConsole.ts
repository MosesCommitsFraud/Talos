import { create } from 'zustand';

/** Ephemeral log lines for the /rag activity rail's console. Lets the settings
 *  column (RagPanel) report endpoint-test results into the console that the
 *  sibling RagActivity component renders. Not persisted. */
export interface RagConsoleLine {
  id: number;
  text: string;
  tone: 'ok' | 'error';
  at: number;
}

interface RagConsoleState {
  lines: RagConsoleLine[];
  push: (text: string, tone: RagConsoleLine['tone']) => void;
}

let nextId = 1;

export const useRagConsole = create<RagConsoleState>((set) => ({
  lines: [],
  // Newest first, capped so a long session can't grow the rail unbounded.
  push: (text, tone) =>
    set((s) => ({ lines: [{ id: nextId++, text, tone, at: Date.now() }, ...s.lines].slice(0, 50) })),
}));
