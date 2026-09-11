import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './menu';

export type SelectOption = { value: string; label?: string };

/** Dropdown built on the shared menu chrome — a bordered trigger with a
 *  chevron and a glass popup, instead of the OS-native `<select>` (which
 *  ignores the app's fonts/colors and can't take the menu design). The popup
 *  scrolls for long option lists (e.g. model pickers). */
export function Select({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  const current = options.find((o) => o.value === value);
  const label = current?.label ?? (current?.value || value || '—');
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center justify-between gap-2 rounded-lg border border-input bg-transparent outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20',
            size === 'sm' ? 'h-7 min-w-24 px-2 text-xs' : 'h-8 min-w-[7rem] px-2.5 text-sm',
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon className={cn('shrink-0 opacity-50', size === 'sm' ? 'size-3' : 'size-3.5')} />
        </button>
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="max-h-[min(20rem,50vh)] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        {options.map((o) => (
          <MenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            className={cn('justify-between gap-3', size === 'sm' && 'text-xs sm:text-xs')}
          >
            <span className="truncate">{o.label ?? (o.value || '—')}</span>
            {o.value === value && <CheckIcon className="size-3.5 shrink-0 text-primary opacity-100" />}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
