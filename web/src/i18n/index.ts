import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import de from './de';

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['value'];

/** The UI ships in German. */
export const DEFAULT_LANG: Lang = 'de';

/* ── lang's flipped default ──
 * The UI used to default to English, so every install that predates the change
 * carries an explicit `en` — in localStorage and in the server-side prefs copy
 * — and would keep rendering English forever despite the new default. A stored
 * language therefore only counts once `langChosen` says the reader actually
 * picked one in Settings → Appearance; until then the default wins over both
 * stored copies. The flag rides along in the synced prefs rather than in a
 * browser-local key, so a chosen language survives switching devices. */
export const pickLang = (lang: unknown, chosen: unknown): Lang =>
  chosen && (lang === 'de' || lang === 'en') ? lang : DEFAULT_LANG;

/** Read the persisted language out of the zustand prefs blob so i18n is
 *  initialized with the right language before React mounts (no flash of EN). */
function initialLang(): Lang {
  try {
    const raw = localStorage.getItem('talos-prefs');
    const s = raw ? JSON.parse(raw)?.state : null;
    return pickLang(s?.lang, s?.langChosen);
  } catch { /* ignore malformed storage */ }
  return DEFAULT_LANG;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
  },
  lng: initialLang(),
  // Stays English on purpose: it only kicks in for a key missing from de.ts,
  // where the English string beats the raw key name.
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
