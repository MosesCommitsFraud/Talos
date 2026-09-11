import { SearchIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Search field in the t3code style: a leading icon addon sized to the field,
 *  and a bordered shell that owns the focus ring so the input itself stays
 *  chrome-free. `bare` drops the shell for use inside a surface that already
 *  provides one (the command palette's header). */
export function SearchInput({
  className,
  wrapperClassName,
  size = 'default',
  bare = false,
  ref,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  wrapperClassName?: string;
  size?: 'default' | 'lg';
  bare?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div
      className={cn(
        'relative inline-flex w-full text-foreground',
        !bare &&
          'rounded-lg border border-input bg-transparent shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/20',
        wrapperClassName,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 start-0 flex items-center opacity-80 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
          size === 'lg' ? 'ps-3 [&_svg]:size-4.5 sm:[&_svg]:size-4' : 'ps-2.5 [&_svg]:size-4',
        )}
      >
        <SearchIcon />
      </span>
      <input
        ref={ref}
        type="search"
        className={cn(
          'w-full min-w-0 rounded-[inherit] bg-transparent pe-3 text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm [&::-webkit-search-cancel-button]:hidden',
          size === 'lg' ? 'h-9.5 ps-9.5 sm:h-8.5 sm:ps-9' : 'h-9 ps-8',
          className,
        )}
        {...props}
      />
    </div>
  );
}
