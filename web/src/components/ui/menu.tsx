import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/* Shared popup chrome (MIDA menu look: popover surface, alpha border,
   deep soft shadow, 6px-radius items). */
export const popupClass =
  'z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-[0_12px_32px_rgb(0_0_0/0.18)] dark:shadow-[0_12px_32px_rgb(0_0_0/0.5)]';
export const itemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground';
export const labelClass = 'px-2.5 py-1.5 text-xs font-medium text-muted-foreground';
export const separatorClass = '-mx-1 my-1 h-px bg-border';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuPopup({ className, sideOffset = 6, ...props }: DropdownMenu.DropdownMenuContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content sideOffset={sideOffset} className={cn(popupClass, className)} {...props} />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({ className, ...props }: DropdownMenu.DropdownMenuItemProps) {
  return <DropdownMenu.Item className={cn(itemClass, className)} {...props} />;
}

export function MenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(labelClass, className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: DropdownMenu.DropdownMenuSeparatorProps) {
  return <DropdownMenu.Separator className={cn(separatorClass, className)} {...props} />;
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

export function ContextMenuItem({ className, ...props }: ContextMenuPrimitive.ContextMenuItemProps) {
  return <ContextMenuPrimitive.Item className={cn(itemClass, className)} {...props} />;
}

export function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.ContextMenuSeparatorProps) {
  return <ContextMenuPrimitive.Separator className={cn(separatorClass, className)} {...props} />;
}

export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuSubTrigger({ className, ...props }: ContextMenuPrimitive.ContextMenuSubTriggerProps) {
  return <ContextMenuPrimitive.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-accent', className)} {...props} />;
}

export function ContextMenuSubPopup({ className, ...props }: ContextMenuPrimitive.ContextMenuSubContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent className={cn(popupClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}
