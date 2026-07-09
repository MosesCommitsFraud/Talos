import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUi } from '@/state/ui';
import { RagPanel } from '../SettingsDialog';
import { RagActivity } from './RagActivity';

/** The /rag workspace. The left column has a pinned title bar above its
 *  scrollable settings; the activity rail remains fixed on the right. */
export function RagWorkspace() {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative z-20 shrink-0 bg-transparent">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-5 py-3">
            <button
              type="button"
              onClick={() => setView('chat')}
              aria-label={t('rag.backToChat')}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{t('rag.title')}</h1>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_24px)] [mask-image:linear-gradient(to_bottom,transparent_0,black_24px)]">
          <div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-5">
            <RagPanel />
          </div>
        </div>
      </div>

      {/* Right: pinned activity rail (drop zone, queue with progress, console). */}
      <RagActivity />
    </main>
  );
}
