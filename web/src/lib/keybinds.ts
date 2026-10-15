import { useQuery } from '@tanstack/react-query';
import { fetchUserPref } from '@/api/client';
import { isMac } from '@/components/ui/kbd';

/** Shortcuts in effect when the user hasn't recorded their own in Settings →
 *  Shortcuts. `mod` is ⌘ on macOS and Ctrl elsewhere. Ctrl+N stays with the
 *  browser (it can't be intercepted there), hence Ctrl+Alt+N for a new chat. */
export const DEFAULT_KEYBINDS: Record<string, string> = {
  search: 'mod+k',
  toggle_sidebar: 'mod+b',
  new_session: 'ctrl+alt+n',
};

/** The user's keybinds over the defaults. Shares the Settings panel's query,
 *  so a binding recorded there applies (and shows) everywhere at once. */
export function useKeybinds(): Record<string, string> {
  const { data } = useQuery({
    queryKey: ['userPref', 'keybinds'],
    queryFn: () => fetchUserPref<Record<string, string>>('keybinds'),
    staleTime: 5 * 60_000,
  });
  return { ...DEFAULT_KEYBINDS, ...(data ?? {}) };
}

/** Whether a keydown event is exactly this "ctrl+alt+k"-style binding. */
export function matchesBinding(e: KeyboardEvent, binding: string | undefined): boolean {
  if (!binding) return false;
  const parts = binding.toLowerCase().split('+').filter(Boolean);
  const key = parts.pop();
  if (!key) return false;
  const want = { ctrl: false, meta: false, alt: false, shift: false };
  for (const p of parts) {
    if (p === 'mod') want[isMac ? 'meta' : 'ctrl'] = true;
    else if (p === 'ctrl' || p === 'control') want.ctrl = true;
    else if (p === 'meta' || p === 'cmd') want.meta = true;
    else if (p === 'alt' || p === 'option') want.alt = true;
    else if (p === 'shift') want.shift = true;
  }
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.altKey !== want.alt || e.shiftKey !== want.shift) {
    return false;
  }
  const pressed = e.key.toLowerCase();
  // With Alt held, macOS reports a composed character in `key` (⌥N → "˜"), so
  // fall back to the physical key for letters and digits.
  const physical = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code.startsWith('Digit') ? e.code.slice(5) : '';
  return pressed === key || physical === key || (key === 'space' && pressed === ' ') || (key === 'esc' && pressed === 'escape');
}
