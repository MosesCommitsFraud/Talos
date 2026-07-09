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
        <header className="z-20 shrink-0 border-b bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-5 py-3.5">
            <button
              type="button"
              onClick={() => setView('chat')}
              aria-label={t('rag.backToChat')}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">{t('rag.title')}</h1>
              <p className="truncate text-xs text-muted-foreground">{t('rag.subtitle')}</p>
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-5 py-5">
            <RagPanel />
          </div>
        </div>
      </div>

      {/* Right: pinned activity rail (drop zone, queue with progress, console). */}
      <RagActivity />
    </main>
  );
}
