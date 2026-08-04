import { useTranslation } from 'react-i18next';

/** A number whose digits scroll up as they change, like a mechanical counter.
 *
 *  Built for the live token count, which ticks several times a second: swapping
 *  the whole string would read as flicker, whereas rolling only the characters
 *  that actually changed makes the movement legible. Each cell is keyed on its
 *  character so React remounts just that one and replays the animation; cells
 *  are keyed by position so the rest of the row sits still.
 *
 *  Grouping separators come from the active locale, so this renders 1,248 in
 *  English and 1.248 in German. */
export function RollingNumber({ value, className }: { value: number; className?: string }) {
  const { i18n } = useTranslation();
  const text = new Intl.NumberFormat(i18n.language).format(value);
  return (
    // The digits are announced as one number rather than as a column of
    // characters, and the live value is polite: it changes far too often to be
    // worth interrupting a screen reader for.
    <span className={className} aria-label={text} role="img">
      <span aria-hidden>
        {[...text].map((char, i) => (
          <span key={i} className="digit-cell" style={{ width: /\d/.test(char) ? '1ch' : undefined }}>
            <span key={char} className="digit-roll">
              {char}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
