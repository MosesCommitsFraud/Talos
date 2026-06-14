import { GhostIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Tooltip } from './ui/misc';

/** Floating incognito toggle. The chat title bar was removed, but this control
 *  stays pinned to the top-right of the chat area in the same spot it used to
 *  occupy in the header. */
export function IncognitoToggle() {
  const { t } = useTranslation();
  const incognito = usePrefs((s) => s.incognito);
  const toggle = usePrefs((s) => s.toggle);
  const visible = usePrefs((s) => s.visibility.incognitoBtn);

  if (!visible) return null;

  return (
    <Tooltip label={incognito ? t('chatHeader.incognitoOn') : t('chatHeader.incognitoOff')}>
      <button
        type="button"
        aria-label={t('chatHeader.toggleIncognito')}
        aria-pressed={incognito}
        onClick={() => toggle('incognito')}
        className={cn(
          'absolute right-3 top-2 z-10 flex size-8 items-center justify-center rounded-lg transition-colors',
          incognito
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <GhostIcon className="size-4" />
      </button>
    </Tooltip>
  );
}
