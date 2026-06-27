import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUi } from '@/state/ui';
import { RagPanel } from '../SettingsDialog';
import { RagActivity } from './RagActivity';

/** The /rag workspace. Two columns, no top bar: the left column scrolls the
 *  settings (with the title at its top), the right column is a pinned activity
 *  rail (drop zone + live queue + error console) that stays put while you
 *  scroll the settings. */
export function RagWorkspace() {
  const { t } = useTranslation();
  const setView = useUi((s) => s.setView);

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden">
      {/* Left: scrollable settings, title included so it scrolls away. */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          <div className="mb-4 flex items-center gap-3">
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
          <RagPanel />
        </div>
      </div>

      {/* Right: pinned activity rail (drop zone, queue with progress, console). */}
      <RagActivity />
    </main>
  );
}
