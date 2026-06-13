import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import de from './de';

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['value'];

/** Read the persisted language out of the zustand prefs blob so i18n is
 *  initialized with the right language before React mounts (no flash of EN). */
function initialLang(): Lang {
  try {
    const raw = localStorage.getItem('talos-prefs');
    const lang = raw ? JSON.parse(raw)?.state?.lang : null;
    if (lang === 'de' || lang === 'en') return lang;
  } catch { /* ignore malformed storage */ }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
  },
  lng: initialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
