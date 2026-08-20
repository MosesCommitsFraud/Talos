import { ArrowLeftIcon, DatabaseIcon, SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useRagBase } from '@/state/ragBase';
import { useUi } from '@/state/ui';
import { Button } from '../ui/button';
import { RagActivity } from './RagActivity';
import { RagOverview, useActiveRagBase } from './RagBases';
import { RagContent } from './RagContent';
import { RagSettingsForm } from './RagSettingsForm';

/** Which space of the knowledge-base workspace is showing.
 *
 *  Three, deliberately separate: the catalogue of bases, one base's own area
 *  (its content and its settings), and the global defaults every base inherits.
 *  Mixing the catalogue with a settings form is what made the old single-page
 *  panel hard to read once more than one base existed.
 */
type Space = { kind: 'overview' } | { kind: 'base'; id: string } | { kind: 'global' };
type BaseTab = 'content' | 'settings';

function spaceFromHash(): Space {
  if (typeof location === 'undefined') return { kind: 'overview' };
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] !== 'rag' || !parts[1]) return { kind: 'overview' };
  if (parts[1] === 'global') return { kind: 'global' };
  return { kind: 'base', id: decodeURIComponent(parts[1]) };
}

function hashFor(space: Space): string {
  if (space.kind === 'overview') return '#/rag';
  if (space.kind === 'global') return '#/rag/global';
  return `#/rag/${encodeURIComponent(space.id)}`;
}

/** The /rag workspace: knowledge-base management. The left column swaps between
 *  the three spaces; the activity rail (drop zone, queue, console) stays
 *  pinned on the right, because ingest progress is worth watching from any of
 *  them. */
export function RagWorkspace() {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);
  const setBaseId = useRagBase((s) => s.setBaseId);
  const [space, setSpaceState] = useState<Space>(spaceFromHash);
  const [tab, setTab] = useState<BaseTab>('content');
  const { bases } = useActiveRagBase();
  // Named from the routed id, not from the "active" base: the two differ for a
  // moment right after a base is created, and the header must follow the URL.
  const routed = space.kind === 'base' ? bases.find((b) => b.id === space.id) : undefined;

  const setSpace = useCallback(
    (next: Space) => {
      setSpaceState(next);
      // Keep the base the activity rail ingests into in step with the space
      // being viewed, so a drop always lands where the user is looking.
      if (next.kind === 'base') setBaseId(next.id);
      if (typeof history !== 'undefined') history.replaceState(null, '', hashFor(next));
    },
    [setBaseId],
  );

  // Back/forward between deep-linked bases.
  useEffect(() => {
    const onHash = () => setSpaceState(spaceFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Entering the workspace at #/rag/<id> must select that base before the
  // panels below read it.
  useEffect(() => {
    if (space.kind === 'base') setBaseId(space.id);
  }, [space, setBaseId]);

  const title =
    space.kind === 'overview'
      ? t('rag.title')
      : space.kind === 'global'
        ? t('rag.globalTitle')
        : (routed?.name ?? space.id);

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative z-20 shrink-0 bg-transparent">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-5 py-3">
            <button
              type="button"
              onClick={() =>
                space.kind === 'overview' ? setView('chat') : setSpace({ kind: 'overview' })
              }
              aria-label={
                space.kind === 'overview' ? t('rag.backToChat') : t('rag.backToOverview')
              }
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h1>
            {space.kind === 'overview' && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => setSpace({ kind: 'global' })}
              >
                <SettingsIcon className="size-3.5" /> {t('rag.globalSettings')}
              </Button>
            )}
            {space.kind === 'base' && (
              <div className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border bg-card p-0.5">
                {(['content', 'settings'] as BaseTab[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTab(k)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      tab === k
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {k === 'content' ? (
                      <DatabaseIcon className="size-3.5" />
                    ) : (
                      <SettingsIcon className="size-3.5" />
                    )}
                    {t(k === 'content' ? 'rag.tab.content' : 'rag.tab.settings')}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_24px)] [mask-image:linear-gradient(to_bottom,transparent_0,black_24px)]">
          <div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-5">
            {space.kind === 'overview' && (
              <RagOverview onOpen={(id) => setSpace({ kind: 'base', id })} />
            )}
            {space.kind === 'global' && <RagSettingsForm />}
            {space.kind === 'base' &&
              (tab === 'content' ? (
                <RagContent baseId={space.id} />
              ) : (
                <RagSettingsForm ragId={space.id} />
              ))}
          </div>
        </div>
      </div>

      {/* Right: pinned activity rail (drop zone, queue with progress, console). */}
      <RagActivity />
    </main>
  );
}
