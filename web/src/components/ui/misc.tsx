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
        'group/switch peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 ease-out data-[state=checked]:bg-primary data-[state=unchecked]:bg-foreground/20 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {/* The thumb slides with a slight overshoot and stretches while pressed,
          anchored to the side it will leave from. */}
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-[transform,width] duration-250 ease-[cubic-bezier(0.34,1.4,0.64,1)] group-active/switch:w-5 data-[state=checked]:translate-x-[18px] data-[state=checked]:group-active/switch:translate-x-[14px] motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}

/* Kbd lives in ./kbd — one keycap implementation for every hotkey in the app. */

/* ── Input ── */
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-foreground/[0.03] px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-foreground/20 focus-visible:border-ring focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
      {...props}
    />
  );
}

/* ── Form field ──
   One input of a form with its name over it and, where it helps, a line under
   it saying what belongs in there. A form is a grid of these (`FormGrid`), so
   related fields share a row on a wide panel and stack on a narrow one — a
   field is never told apart only by a placeholder that vanishes on typing. */
export function Field({ label, hint, className, children }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Two columns of fields that fold to one when the panel is narrow. A field
 *  spans both with `className="@lg/form:col-span-2"`. */
export function FormGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="@container/form">
      <div className={cn('grid max-w-2xl gap-x-4 gap-y-3 @lg/form:grid-cols-2', className)} {...props} />
    </div>
  );
}

/* ── Textarea ── */
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-[88px] w-full min-w-0 resize-y rounded-lg border border-input bg-foreground/[0.03] px-2.5 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-foreground/20 focus-visible:border-ring focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-ring/30',
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
