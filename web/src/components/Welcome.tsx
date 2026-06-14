import { useTranslation } from 'react-i18next';
import { usePrefs } from '@/state/prefs';

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden>
      <path d="M16 4L16 22L6 22Z" fill="var(--primary)" />
      <path d="M16 8L16 22L24 22Z" fill="var(--primary)" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="var(--primary)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Greeting shown above the centered composer on an empty chat. */
export function Welcome() {
  const { t } = useTranslation();
  const show = usePrefs((s) => s.visibility.welcomeText);
  if (!show) return null;
  return (
    <div className="flex select-none flex-col items-center gap-3 pb-6">
      <Logo />
      <h1 className="text-2xl font-semibold tracking-tight">{t('messages.welcome')}</h1>
    </div>
  );
}
