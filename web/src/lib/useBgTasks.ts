import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBgTasks } from '@/api/client';
import type { BgTask } from '@/api/types';
import { useChat } from '@/state/chat';
import { useUi } from '@/state/ui';

/** How often the tray asks. Fast while something is running — the pane shows a
 *  live step line per task (subagents write theirs every 0.8 s), and a stale
 *  one reads as frozen — and slower otherwise,
 *  where the only thing a poll can discover is a job that has just been
 *  launched (which the stream is about to make obvious anyway). */
const ACTIVE_MS = 1_000;
/** Pane open but nothing running: a newly launched job should show up soon. */
const OPEN_MS = 5_000;
const IDLE_MS = 15_000;

export const isRunning = (task: BgTask) => task.status === 'running';

/** Background jobs for the current session, polled. Every caller shares one
 *  query (react-query dedupes by key), so the indicator in the working row and
 *  the open panel never disagree about what is running. */
export function useBgTasks(): BgTask[] {
  const sessionId = useChat((s) => s.sessionId);
  // A `delegate` call in flight means subagent jobs exist (or are about to):
  // poll at the live rate right away instead of waiting out the idle interval,
  // so the "tasks running" chip appears with the call, not 20 s later.
  const delegating = useChat((s) =>
    s.streaming && s.messages.some((m) => (m.tools ?? []).some((c) => c.tool === 'delegate' && c.status === 'running')),
  );
  const paneOpen = useUi((s) => s.tasksPanelOpen);
  const { data, refetch } = useQuery({
    queryKey: ['bg-tasks', sessionId],
    queryFn: () => fetchBgTasks(sessionId as string),
    enabled: !!sessionId,
    refetchInterval: (query) =>
      delegating || (query.state.data ?? []).some(isRunning) ? ACTIVE_MS : paneOpen ? OPEN_MS : IDLE_MS,
    // Keep polling a running job while the tab is in the background: a build
    // that finishes behind a hidden tab should already be settled when the
    // reader comes back, not start loading then.
    refetchIntervalInBackground: true,
    // A failing endpoint must not spam: one retry, then wait for the next tick.
    retry: 1,
  });
  useEffect(() => {
    if (delegating && sessionId) void refetch();
  }, [delegating, sessionId, refetch]);
  return data ?? [];
}
