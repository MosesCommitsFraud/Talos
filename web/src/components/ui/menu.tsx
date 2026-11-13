import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { ChevronRightIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/* Shared popup chrome (t3code menu look: translucent `dropdown-glass` surface,
   lg radius, compact rows that step up a size on touch-sized viewports).
   Rows are `cursor-default` — a menu row is not a link. */
export const popupClass =
  'dropdown-glass z-50 min-w-32 origin-[var(--radix-popper-transform-origin)] rounded-lg p-1 text-popover-foreground outline-none';

export const itemClass =
  "flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-60 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground sm:min-h-7 sm:text-sm [&>svg:not([class*='ms-auto'])]:-mx-0.5 [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:text-destructive-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current";

/** The composer's "+" menu and its submenus: rows a touch taller than a plain
 *  menu's, with a softer corner, so there is room for a switch or a value at
 *  the end of a row. Add to a MenuPopup / MenuSubPopup's className. */
export const roomyMenuClass =
  "rounded-xl p-1 [&_[role^=menuitem]]:min-h-8 [&_[role^=menuitem]]:gap-2 [&_[role^=menuitem]]:rounded-md [&_[role^=menuitem]]:px-2 [&_[role^=menuitem]]:text-[13.5px] [&_[role^=menuitem]>svg:not([class*='size-'])]:size-4";

/** The switch at the end of a menu row that turns something on or off. Only
 *  the picture of one: the row is the control, and takes the click. */
export function MenuSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'ms-auto flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
        on ? 'bg-primary' : 'bg-foreground/20',
      )}
    >
      <span className={cn('size-3 rounded-full bg-white shadow-sm transition-transform duration-150', on && 'translate-x-3')} />
    </span>
  );
}

export const labelClass = 'px-2 py-1.5 text-xs font-medium text-muted-foreground';
export const separatorClass = 'mx-2 my-1 h-px bg-border';

type ItemVariant = 'default' | 'destructive';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuPopup({ className, sideOffset = 4, ...props }: DropdownMenu.DropdownMenuContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content sideOffset={sideOffset} className={cn(popupClass, className)} {...props} />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  className,
  variant = 'default',
  ...props
}: DropdownMenu.DropdownMenuItemProps & { variant?: ItemVariant }) {
  return <DropdownMenu.Item data-variant={variant} className={cn(itemClass, className)} {...props} />;
}

export function MenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(labelClass, className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: DropdownMenu.DropdownMenuSeparatorProps) {
  return <DropdownMenu.Separator className={cn(separatorClass, className)} {...props} />;
}

/** Right-aligned keyboard hint inside a menu row. */
export function MenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn('ms-auto font-sans text-xs font-medium tracking-widest text-muted-foreground/70', className)}
      {...props}
    />
  );
}

export const MenuSub = DropdownMenu.Sub;

export function MenuSubTrigger({ className, children, ...props }: DropdownMenu.DropdownMenuSubTriggerProps) {
  return (
    <DropdownMenu.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-accent', className)} {...props}>
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </DropdownMenu.SubTrigger>
  );
}

/** A submenu opens beside its parent with a gap between the two, never over
 *  it: the offset clears the parent's own padding and border, and the small
 *  lift lines the first row up with the row it opened from. */
const SUB_SIDE_OFFSET = 10;
const SUB_ALIGN_OFFSET = -5;

export function MenuSubPopup({
  className,
  sideOffset = SUB_SIDE_OFFSET,
  alignOffset = SUB_ALIGN_OFFSET,
  ...props
}: DropdownMenu.DropdownMenuSubContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={8}
        className={cn(popupClass, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

/* Context-menu flavor with identical chrome */
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export function ContextMenuPopup({ className, ...props }: ContextMenuPrimitive.ContextMenuContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(popupClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.ContextMenuItemProps & { variant?: ItemVariant }) {
  return <ContextMenuPrimitive.Item data-variant={variant} className={cn(itemClass, className)} {...props} />;
}

export function ContextMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(labelClass, className)} {...props} />;
}

export function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.ContextMenuSeparatorProps) {
  return <ContextMenuPrimitive.Separator className={cn(separatorClass, className)} {...props} />;
}

export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ContextMenuPrimitive.ContextMenuSubTriggerProps) {
  return (
    <ContextMenuPrimitive.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-accent', className)} {...props}>
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubPopup({
  className,
  sideOffset = SUB_SIDE_OFFSET,
  alignOffset = SUB_ALIGN_OFFSET,
  ...props
}: ContextMenuPrimitive.ContextMenuSubContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={8}
        className={cn(popupClass, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}
