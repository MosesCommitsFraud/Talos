import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/* ── Tooltip ── */
export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ label, children, side = 'bottom', open, onOpenChange }: { label: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <TooltipPrimitive.Root delayDuration={400} open={open} onOpenChange={onOpenChange}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ── Switch (MIDA proportions) ── */
export function Switch({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-foreground/20',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

/* Kbd lives in ./kbd — one keycap implementation for every hotkey in the app. */

/* ── Input ── */
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20',
        className,
      )}
      {...props}
    />
  );
}

/* ── Textarea ── */
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-[88px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20',
        className,
      )}
      {...props}
    />
  );
}

/* ── Skeleton ──
   Loading placeholder for a piece of text that has not arrived yet (today: the
   auto-generated session title, in the sidebar and the chat header).

   Pass `text` to size the bar off the words it stands in for: the text is laid
   out invisibly inside the bar (in the inherited font), so the placeholder
   inherits its real width and every row gets a bar of its own length instead of
   a uniform stub. Without it the bar falls back to a fixed width; `w-*` / `h-*`
   from the caller override either. A floor on the width keeps a one-word
   placeholder from rendering as a stub that reads like a glitch. */
export function Skeleton({ className, label, text, ...props }: React.HTMLAttributes<HTMLDivElement> & { label?: string; text?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn('skeleton-bar h-3.5', text ? 'inline-block min-w-16 max-w-full align-middle' : 'w-32', className)}
      {...props}
    >
      {/* Clipped by the bar's own overflow, so the taller line box of the text
          doesn't stretch it past the bar height. */}
      {text ? <span className="invisible whitespace-pre">{text}</span> : null}
    </div>
  );
}
