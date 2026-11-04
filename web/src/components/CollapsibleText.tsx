import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Height a long message folds to: about eight lines of chat text. */
const COLLAPSED_PX = 200;
/** Folding has to hide at least this much, or the button costs as much room as
 *  it saves. */
const MIN_HIDDEN_PX = 80;

/** A long message, folded behind a fade with a "show more" under it. Measured
 *  rather than counted in characters, so line breaks and the bubble's width are
 *  already in the number. */
export function CollapsibleText({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  const [fullHeight, setFullHeight] = useState(0);
  const [open, setOpen] = useState(false);

  // Before paint, so a long message never flashes at full length. Observed, since
  // a narrower column or a late font changes how many lines it takes.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setFullHeight(element.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const foldable = fullHeight > COLLAPSED_PX + MIN_HIDDEN_PX;
  const folded = foldable && !open;

  return (
    <>
      <div
        className={cn(
          'overflow-hidden',
          foldable && 'transition-[max-height] duration-200 ease-out',
          folded && '[-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%-5rem),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%-5rem),transparent)]',
        )}
        style={foldable ? { maxHeight: open ? fullHeight : COLLAPSED_PX } : undefined}
      >
        <div ref={content}>{children}</div>
      </div>
      {foldable && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="my-1 block cursor-pointer text-sm font-medium text-strong transition-opacity hover:opacity-75"
        >
          {open ? t('messages.showLess') : t('messages.showMore')}
        </button>
      )}
    </>
  );
}
