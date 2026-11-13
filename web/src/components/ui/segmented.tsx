import { useLayoutEffect, useState } from 'react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Measures the box of the element matching `selector` inside `container`, for
 *  a highlight that slides between options. Re-measures when `key` changes and
 *  whenever the container resizes (density, language or font changes). */
export function useActiveBox(container: HTMLElement | null, selector: string, key: unknown) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!container) return;
    const el = container.querySelector<HTMLElement>(selector);
    const measure = () => {
      setBox(el ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } : null);
    };
    measure();
    // A scroll list keeps its own size when its rows reflow, and the active
    // row can move without resizing, so watch every row.
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    for (const child of Array.from(container.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [container, selector, key]);
  return box;
}

/** The app's one segmented control: a pill track with the active option raised.
 *  Used wherever a view is scoped to one of a few values (a time range, a tab,
 *  a mode), so every such switch looks and moves the same. `size="sm"` is the
 *  compact form for toolbars and page headers. */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md', className }: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: React.ReactNode; title?: string }>;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  // One raised pill slides under the active option instead of each button
  // painting its own background, so switching reads as motion.
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const pill = useActiveBox(track, '[aria-checked="true"]', `${value}|${options.length}`);
  return (
    <div
      ref={setTrack}
      role="radiogroup"
      aria-label={label}
      className={cn('relative inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted/60 p-0.5', className)}
    >
      {pill && (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-full bg-background shadow-[0_0_0_1px_var(--border)] transition-[left,width] duration-200 ease-[cubic-bezier(0.34,1.25,0.64,1)] motion-reduce:transition-none"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          aria-label={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative flex min-w-8 items-center justify-center rounded-full transition-colors [&_svg]:size-4 [&_svg]:transition-transform active:[&_svg]:scale-90',
            size === 'sm' ? 'h-6 px-2.5 text-xs' : 'h-7 px-3 text-[13px]',
            value === o.value ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
