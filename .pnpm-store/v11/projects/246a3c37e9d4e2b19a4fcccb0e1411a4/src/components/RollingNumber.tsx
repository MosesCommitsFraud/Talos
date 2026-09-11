import { useTranslation } from 'react-i18next';

/** A number whose digits scroll up as they change, like a mechanical counter.
 *
 *  Built for the live token count, which ticks several times a second: swapping
 *  the whole string would read as flicker, whereas rolling only the characters
 *  that actually changed makes the movement legible. Each cell is keyed on its
 *  character so React remounts just that one and replays the animation; cells
 *  are keyed by position so the rest of the row sits still.
 *
 *  Plain numbers are locale-formatted (1,248 in English, 1.248 in German); the
 *  abbreviated form is not — see `compact`. */
export function RollingNumber({
  value,
  compact,
  className,
}: {
  value: number;
  /** Abbreviate from a thousand up: 999 → "999", 1500 → "1.5k", 12340 → "12.3k".
   *
   *  Written the same way in every language, decimal point and lower-case k
   *  included. It is a unit of measure here rather than prose, and both of the
   *  localised alternatives make it worse: Intl's compact notation shouts
   *  "1.5K" and expands to "1,5 Tsd." in German, and a plain German decimal
   *  comma turns "1,5k" into something that reads like a thousands separator. */
  compact?: boolean;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const text =
    compact && value >= 1000
      ? `${Math.round(value / 100) / 10}k`
      : new Intl.NumberFormat(i18n.language).format(value);
  return (
    // The digits are announced as one number rather than as a column of
    // characters, and the live value is polite: it changes far too often to be
    // worth interrupting a screen reader for.
    <span className={className} aria-label={text} role="img">
      {/* No width on the cells: the count renders in a tabular-figures context,
          so digits already occupy the same advance and nothing jitters as they
          change. Forcing 1ch instead spaced them unlike the surrounding text. */}
      <span aria-hidden>
        {[...text].map((char, i) => (
          <span key={i} className="digit-cell">
            <span key={char} className="digit-roll">
              {char}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
