import { useQuery } from '@tanstack/react-query';
import { fetchBgTasks } from '@/api/client';
import type { BgTask } from '@/api/types';
import { useChat } from '@/state/chat';

/** How often the tray asks. Fast while something is running — the panel shows a
 *  live log tail and a two-second-old tail reads as frozen — and slow otherwise,
 *  where the only thing a poll can discover is a job that has just been
 *  launched (which the stream is about to make obvious anyway). */
const ACTIVE_MS = 2_000;
const IDLE_MS = 20_000;

export const isRunning = (task: BgTask) => task.status === 'running';

/** Background jobs for the current session, polled. Every caller shares one
 *  query (react-query dedupes by key), so the indicator in the working row and
 *  the open panel never disagree about what is running. */
export function useBgTasks(): BgTask[] {
  const sessionId = useChat((s) => s.sessionId);
  const { data } = useQuery({
    queryKey: ['bg-tasks', sessionId],
    queryFn: () => fetchBgTasks(sessionId as string),
    enabled: !!sessionId,
    refetchInterval: (query) =>
      (query.state.data ?? []).some(isRunning) ? ACTIVE_MS : IDLE_MS,
    // Keep polling a running job while the tab is in the background: a build
    // that finishes behind a hidden tab should already be settled when the
    // reader comes back, not start loading then.
    refetchIntervalInBackground: true,
    // A failing endpoint must not spam: one retry, then wait for the next tick.
    retry: 1,
  });
  return data ?? [];
}
