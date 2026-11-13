import { CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { create } from 'zustand';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** How long a toast stays before it fades out. Short: these confirm a switch
 *  the reader just flipped, and the state they describe is already visible
 *  behind them. A failure stays longer: it has to be read, not just noticed. */
const TOAST_MS = 2400;
const TOAST_ERROR_MS = 5000;

export type ToastTone = 'success' | 'error';

export interface Toast {
  id: number;
  /** i18n key, not a rendered string — toasts are pushed from stores and event
   *  handlers that have no `t`, and one left on screen across a language change
   *  should follow it. With `raw` it is the finished text instead (a server's
   *  own error message, a line a panel has already translated). */
  messageKey: string;
  params?: Record<string, unknown>;
  raw?: boolean;
  tone: ToastTone;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let nextId = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) =>
    set((s) => ({
      // Replacing a toast that carries the same key is what makes a rapidly
      // flipped toggle behave: the reader gets one line that keeps correcting
      // itself, not a stack counting their clicks.
      toasts: [...s.toasts.filter((x) => x.messageKey !== toast.messageKey), { ...toast, id: nextId++ }],
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Confirm something that just happened. Usable from non-React callers
 *  (zustand stores, plain handlers). */
export const toast = (messageKey: string, params?: Record<string, unknown>) =>
  useToasts.getState().push({ messageKey, params, tone: 'success' });

/** Say that something did not work, by i18n key. */
export const toastError = (messageKey: string, params?: Record<string, unknown>) =>
  useToasts.getState().push({ messageKey, params, tone: 'error' });

/** A toast whose text is already final: a panel's translated confirmation, or
 *  an error message as the server worded it. */
export const toastText = (text: string, tone: ToastTone = 'success') =>
  useToasts.getState().push({ messageKey: text, raw: true, tone });

/** The standard confirmation after a setting changed. One key for all of them,
 *  so a run of changes shows one line, not a pile. */
export const toastSaved = () => toast('toasts.saved');

function ToastRow({ item }: { item: Toast }) {
  const { t } = useTranslation();
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const id = setTimeout(() => dismiss(item.id), item.tone === 'error' ? TOAST_ERROR_MS : TOAST_MS);
    return () => clearTimeout(id);
  }, [item.id, item.tone, dismiss]);
  const Icon = item.tone === 'error' ? TriangleAlertIcon : CheckIcon;
  return (
    <button
      type="button"
      // Clicking it takes it away early. No close glyph: the whole pill is the
      // target, and a toast this short does not need furniture.
      onClick={() => dismiss(item.id)}
      className={cn(
        'pointer-events-auto flex max-w-[min(24rem,80vw)] items-center gap-2 rounded-full border bg-popover py-1.5 pr-3.5 pl-2.5 text-left text-[13px]',
        'text-foreground shadow-[0_8px_24px_-12px_rgb(0_0_0/45%)] transition-colors hover:bg-card',
        'animate-toast-in',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full',
          item.tone === 'error' ? 'bg-destructive/15 text-destructive-foreground' : 'bg-success/15 text-success',
        )}
      >
        <Icon className="size-2.5" strokeWidth={3} />
      </span>
      <span className="min-w-0 break-words">{item.raw ? item.messageKey : t(item.messageKey, item.params)}</span>
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
      // Above dialogs (z-50): most toasts confirm a change made in one.
      className="pointer-events-none fixed right-4 bottom-4 z-[70] flex flex-col items-end gap-2"
    >
      {toasts.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  );
}
