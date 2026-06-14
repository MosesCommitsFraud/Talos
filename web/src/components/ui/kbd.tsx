import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Single keycap pill — mirrors t3code's Kbd. */
export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-sans text-xs font-medium text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

/** Groups keycaps with a small gap. */
export function KbdGroup({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  );
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

/** Pretty label for a single keybind token (e.g. "meta" → "⌘", "a" → "A"). */
function tokenLabel(part: string): string {
  switch (part) {
    case 'mod':
      return isMac ? '⌘' : 'Ctrl';
    case 'meta':
      return isMac ? '⌘' : 'Win';
    case 'ctrl':
    case 'control':
      return isMac ? '⌃' : 'Ctrl';
    case 'alt':
      return isMac ? '⌥' : 'Alt';
    case 'shift':
      return '⇧';
    case 'enter':
    case 'return':
      return '⏎';
    case 'escape':
    case 'esc':
      return 'Esc';
    case ' ':
    case 'space':
      return 'Space';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    case 'arrowleft':
      return '←';
    case 'arrowright':
      return '→';
    default:
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
  }
}

/** Renders a "ctrl+shift+k" style binding string as keycap pills. */
export function KeybindingPill({ value }: { value: string }) {
  const parts = value.split('+').filter(Boolean);
  return (
    <KbdGroup className="bg-transparent p-0 shadow-none">
      {parts.map((part, i) => (
        <Kbd key={`${part}-${i}`} className="min-w-6 justify-center px-1.5">
          {tokenLabel(part)}
        </Kbd>
      ))}
    </KbdGroup>
  );
}
