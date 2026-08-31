import type { Session } from '@/api/types';
import { timestampMs } from './utils';

/** How long a placeholder name is treated as "still being generated". The
 *  backend names a session from a background task right after the first turn
 *  starts; if that call fails it silently leaves the placeholder in place, so
 *  the skeleton must not wait forever — after this window the placeholder is
 *  shown as the title instead. */
const TITLE_GRACE_MS = 120_000;

/** Mirror of the backend's `needs_auto_name()` (routes/chat_helpers.py): true
 *  while the session still carries a placeholder name that the title model is
 *  expected to replace. */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const value = (name ?? '').trim();
  if (!value) return true;
  if (value === 'Chat' || value.startsWith('Chat:')) return true;
  // Legacy frontend default: "modelname HH:MM:SS AM/PM".
  return /^.+ \d{1,2}:\d{2}:\d{2}(\s*(AM|PM))?$/i.test(value);
}

/** True while the real title is still being generated — the cue for showing a
 *  skeleton in the sidebar row and the chat header instead of the placeholder. */
export function isTitlePending(session: Pick<Session, 'name' | 'updated_at' | 'created_at'> | null | undefined): boolean {
  if (!session) return false;
  if (!isPlaceholderName(session.name)) return false;
  const started = timestampMs(session.updated_at) || timestampMs(session.created_at);
  if (!started) return true;
  return Date.now() - started < TITLE_GRACE_MS;
}

/** True when any session in the list is waiting for its generated title — used
 *  to poll the session list faster until the title lands. */
export function anyTitlePending(sessions: Session[] | undefined): boolean {
  return (sessions ?? []).some((s) => isTitlePending(s));
}
