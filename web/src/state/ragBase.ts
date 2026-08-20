import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Which knowledge base the /rag workspace is currently pointed at.
 *
 *  Every document view, upload and search in that workspace is scoped to this
 *  id; `'default'` is the base Talos chat itself searches, so an install that
 *  never creates a second base behaves exactly as it did before.
 *
 *  Persisted because the selection is a working context — reloading the page
 *  mid-ingest should not silently drop you back into a different base. If the
 *  stored base has since been deleted, `RagBaseBar` falls back to the default.
 */
export const DEFAULT_RAG_BASE = 'default';

interface RagBaseState {
  baseId: string;
  setBaseId: (id: string) => void;
}

export const useRagBase = create<RagBaseState>()(
  persist(
    (set) => ({
      baseId: DEFAULT_RAG_BASE,
      setBaseId: (baseId) => set({ baseId }),
    }),
    { name: 'talos-rag-base' },
  ),
);

/** The value to send as `rag_id`: `undefined` for the default base, so the
 *  requests a single-base install makes stay byte-identical to the old ones. */
export function ragIdParam(baseId: string): string | undefined {
  return baseId && baseId !== DEFAULT_RAG_BASE ? baseId : undefined;
}
