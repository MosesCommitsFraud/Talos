import { create } from 'zustand';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** How long a toast stays before it fades out. Short: these confirm a switch
 *  the reader just flipped, and the state they describe is already visible
 *  behind them. */
const TOAST_MS = 2400;

export interface Toast {
  id: number;
  /** i18n key, not a rendered string — toasts are pushed from stores and event
   *  handlers that have no `t`, and one left on screen across a language change
   *  should follow it. */
  messageKey: string;
  params?: Record<string, unknown>;
}

interface ToastState {
  toasts: Toast[];
  push: (messageKey: string, params?: Record<string, unknown>) => void;
  dismiss: (id: number) => void;
}

let nextId = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (messageKey, params) =>
    set((s) => ({
      // Replacing a toast that carries the same key is what makes a rapidly
      // flipped toggle behave: the reader gets one line that keeps correcting
      // itself, not a stack counting their clicks.
      toasts: [...s.toasts.filter((x) => x.messageKey !== messageKey), { id: nextId++, messageKey, params }],
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Convenience for non-React callers (zustand stores, plain handlers). */
export const toast = (messageKey: string, params?: Record<string, unknown>) =>
  useToasts.getState().push(messageKey, params);

function ToastRow({ item }: { item: Toast }) {
  const { t } = useTranslation();
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const id = setTimeout(() => dismiss(item.id), TOAST_MS);
    return () => clearTimeout(id);
  }, [item.id, dismiss]);
  return (
    <button
      type="button"
      // Clicking it takes it away early. No close glyph: the whole pill is the
      // target, and a toast this short does not need furniture.
      onClick={() => dismiss(item.id)}
      className={cn(
        'pointer-events-auto max-w-[min(22rem,80vw)] rounded-lg border bg-card/95 px-3 py-2 text-left text-[13px]',
        'text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-accent',
        'animate-toast-in',
      )}
    >
      {t(item.messageKey, item.params)}
    </button>
  );
}

/** Bottom-right toast stack. Newest at the bottom, closest to where the corner
 *  reads — the composer already owns the bottom-centre, so this sits out of its
 *  way. Mounted once, in App. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
    >
      {toasts.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  );
}
