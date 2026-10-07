import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, CopyIcon, LoaderIcon, SquareIcon, XIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { stopBgTask } from '@/api/client';
import type { BgTask, ToolCall } from '@/api/types';
import { describeCall } from '@/lib/toolLabels';
import { cn, copyTextToClipboard, formatDurationMs } from '@/lib/utils';
import { useBgTasks } from '@/lib/useBgTasks';
import { useChat } from '@/state/chat';
import { useUi } from '@/state/ui';
import { Markdown } from './Markdown';
import { ToolLabel } from './ToolLabel';
import { Tooltip } from './ui/misc';

/* The tray reads like Claude's task list: a quiet list of one-line rows, and a
 * click opens that task on its own page (assignment, what it did, result)
 * instead of unfolding everything in place. Status is a small static dot —
 * the working row in the chat already carries the animation. */

type Outcome = 'running' | 'done' | 'failed' | 'stopped';

function outcomeOf(task: BgTask): Outcome {
  if (task.stopped) return 'stopped';
  if (task.status === 'running') return 'running';
  return task.status === 'failed' ? 'failed' : 'done';
}

const DOT: Record<Outcome, string> = {
  running: 'bg-primary',
  done: 'bg-emerald-500',
  failed: 'bg-destructive-foreground',
  stopped: 'bg-muted-foreground/50',
};

function StatusDot({ task, className }: { task: BgTask; className?: string }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[outcomeOf(task)], className)} />;
}

/** Elapsed time — live while it runs, frozen once it has finished. The
 *  backend sends Unix seconds. */
function Elapsed({ task }: { task: BgTask }) {
  const [, force] = useState(0);
  const running = task.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!task.started_at) return null;
  const end = running ? Date.now() : (task.ended_at ?? 0) * 1000 || Date.now();
  return <span className="tabular-nums">{formatDurationMs(end - task.started_at * 1000)}</span>;
}

/** "Läuft · 0:42 · 3 Schritte" — one muted line under the title. */
function MetaLine({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const outcome = outcomeOf(task);
  const state =
    task.timed_out ? t('tasks.timedOut')
    : outcome === 'failed' && task.kind !== 'subagent' ? t('tasks.exitCode', { code: task.exit_code ?? -1 })
    : t(`tasks.state.${outcome}`);
  const steps = task.steps?.length ?? 0;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={cn(outcome === 'failed' && 'text-destructive-foreground')}>{state}</span>
      {task.kind === 'subagent' && (
        <>
          <span aria-hidden>·</span>
          <span>{t(task.agent_type === 'worker' ? 'tasks.typeWorker' : 'tasks.typeResearch')}</span>
          {task.model_size && (
            <>
              <span aria-hidden>·</span>
              <span title={task.model || undefined}>
                {t(task.model_size === 'large' ? 'tasks.modelLarge' : 'tasks.modelSmall')}
              </span>
            </>
          )}
        </>
      )}
      <span aria-hidden>·</span>
      <Elapsed task={task} />
      {steps > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>{t('tasks.steps', { count: steps })}</span>
        </>
      )}
    </span>
  );
}

/** Stops one subagent; the delegating turn carries on with the others. */
function useStop(task: BgTask) {
  const sessionId = useChat((s) => s.sessionId);
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStop = task.kind === 'subagent' && task.status === 'running' && !!sessionId;
  const stop = async () => {
    if (!sessionId) return;
    setStopping(true);
    setError(null);
    try {
      await stopBgTask(sessionId, task.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
      void queryClient.invalidateQueries({ queryKey: ['bg-tasks', sessionId] });
    }
  };
  return { canStop, stop, stopping, error };
}

function StopButton({ task, withLabel }: { task: BgTask; withLabel?: boolean }) {
  const { t } = useTranslation();
  const { canStop, stop, stopping } = useStop(task);
  if (!canStop) return null;
  const button = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void stop();
      }}
      disabled={stopping}
      aria-label={t('tasks.stopNamed', { name: task.label || t('tasks.untitled') })}
      className={cn(
        'flex shrink-0 items-center justify-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50',
        withLabel ? 'h-7 border px-2.5 text-xs' : 'size-7',
      )}
    >
      {stopping ? <LoaderIcon className="size-3.5 animate-spin" /> : <SquareIcon className="size-3 fill-current" />}
      {withLabel && t('tasks.stopShort')}
    </button>
  );
  return withLabel ? button : <Tooltip label={t('tasks.stop')}>{button}</Tooltip>;
}

function TaskListRow({ task, onOpen }: { task: BgTask; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent/60">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2 text-left">
        <StatusDot task={task} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">{task.label || t('tasks.untitled')}</span>
          <MetaLine task={task} />
        </span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-muted-foreground" />
      </button>
      <StopButton task={task} />
    </div>
  );
}

interface Group {
  key: string;
  subagents: boolean;
  startedAt: number;
  tasks: BgTask[];
}

/** Subagents of one `delegate` call form a group in the order they were
 *  given; every other job is its own group. Newest group first. */
function groupTasks(tasks: BgTask[]): Group[] {
  const groups = new Map<string, Group>();
  for (const task of tasks) {
    const key = task.kind === 'subagent' && task.group ? task.group : task.id;
    const at = task.started_at ?? 0;
    const g = groups.get(key);
    if (g) {
      g.tasks.push(task);
      g.startedAt = Math.min(g.startedAt, at);
    } else {
      groups.set(key, { key, subagents: task.kind === 'subagent', startedAt: at, tasks: [task] });
    }
  }
  return [...groups.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Start time of a group as a wall-clock time ("14:32"). */
function clock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TaskList({ tasks, onOpen }: { tasks: BgTask[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  if (tasks.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('tasks.empty')}</p>;
  }
  return (
    <div className="space-y-4 p-2">
      {groupTasks(tasks).map((group) => (
        <section key={group.key}>
          <h3 className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
            {group.subagents ? t('tasks.groupSubagents') : t(group.tasks[0].kind === 'agent' ? 'tasks.kindAgent' : 'tasks.kindShell')}
            {group.startedAt > 0 && <span className="font-normal"> · {clock(group.startedAt)}</span>}
          </h3>
          {group.tasks.map((task) => (
            <TaskListRow key={task.id} task={task} onOpen={() => onOpen(task.id)} />
          ))}
        </section>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h4>;
}

/** What the subagent did, as a vertical timeline in the chat's own wording. */
function StepTimeline({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const steps = task.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <ol className="relative space-y-2.5 border-l border-border/70 pl-4">
      {steps.map((step, i) => {
        const call: ToolCall = { tool: step.tool, command: step.command, status: step.status };
        const running = step.status === 'running';
        return (
          <li key={i} className="relative text-[12.5px] leading-snug text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                'absolute top-[5px] -left-[21px] size-2.5 rounded-full border-2 border-card',
                running ? 'bg-primary' : step.status === 'error' ? 'bg-destructive-foreground' : 'bg-muted-foreground/40',
              )}
            />
            <span className={cn('break-words', running && 'shimmer-text')}>
              <ToolLabel parts={describeCall(call, t, running ? 'running' : 'past')} failed={step.status === 'error'} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function TaskDetail({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { error } = useStop(task);
  const box = useRef<HTMLDivElement>(null);
  const running = task.status === 'running';
  const isSubagent = task.kind === 'subagent';
  // Follow the live end while it runs, like a log tail; leave the reader's
  // scroll position alone once it has settled.
  useEffect(() => {
    if (running && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [task.steps?.length, task.output, running]);

  const copy = async () => {
    await copyTextToClipboard(task.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-6">
      <div className="mb-5 flex items-start gap-3">
        <StatusDot task={task} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm leading-snug font-medium break-words text-foreground">{task.label || t('tasks.untitled')}</h3>
          <MetaLine task={task} />
        </div>
        <StopButton task={task} withLabel />
      </div>
      {error && <p className="-mt-3 mb-4 text-[11px] text-destructive-foreground">{error}</p>}

      {isSubagent && task.prompt && (
        <section className="mb-5">
          <SectionTitle>{t('tasks.assignment')}</SectionTitle>
          <p className={cn('text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground', !promptOpen && 'line-clamp-3')}>
            {task.prompt}
          </p>
          {task.prompt.length > 180 && (
            <button
              type="button"
              onClick={() => setPromptOpen((v) => !v)}
              className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {promptOpen ? t('tasks.showLess') : t('tasks.showMore')}
            </button>
          )}
        </section>
      )}

      {isSubagent && (task.steps?.length ?? 0) > 0 && (
        <section className="mb-5">
          <SectionTitle>{t('tasks.activity')}</SectionTitle>
          <StepTimeline task={task} />
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <SectionTitle>{isSubagent ? t('tasks.result') : t('tasks.output')}</SectionTitle>
          {task.output.trim() && (
            <button
              type="button"
              onClick={() => void copy()}
              className="-mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              {copied ? t('messages.copied') : t('tasks.copyOutput')}
            </button>
          )}
        </div>
        {!task.output.trim() ? (
          <p className="text-[12.5px] text-muted-foreground italic">
            {running ? (isSubagent ? t('tasks.subagentWorking') : t('tasks.noOutputYet')) : t('tasks.noOutput')}
          </p>
        ) : isSubagent ? (
          <div className="text-[13px]">
            <Markdown text={task.output} streaming={running} />
          </div>
        ) : (
          <pre className="rounded-md bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
            {task.output}
          </pre>
        )}
      </section>
    </div>
  );
}

/** Right-side drawer with the session's background work — delegated
 *  subagents, nested agent tasks and detached shell jobs. */
export function TasksPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.tasksPanelOpen);
  const setOpen = useUi((s) => s.setTasksPanelOpen);
  const tasks = useBgTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sessionId = useChat((s) => s.sessionId);
  // A different chat has different tasks; never show a stale detail page.
  useEffect(() => setSelectedId(null), [sessionId]);

  if (!open) return null;
  const selected = selectedId ? tasks.find((task) => task.id === selectedId) : undefined;
  const runningCount = tasks.filter((task) => task.status === 'running').length;

  return (
    <aside
      className="m-2 flex w-[26rem] max-w-[40vw] shrink-0 flex-col overflow-hidden rounded-md border bg-card shadow-lg"
      aria-label={t('tasks.panelLabel')}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        {selected ? (
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            aria-label={t('tasks.back')}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : (
          <span className="w-1" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {selected ? t('tasks.detailTitle') : t('tasks.title')}
          {!selected && runningCount > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
              {t('tasks.runningCount', { count: runningCount })}
            </span>
          )}
        </span>
        <button
          type="button"
          aria-label={t('tasks.closePanel')}
          onClick={() => setOpen(false)}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {selected ? (
        <TaskDetail key={selected.id} task={selected} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskList tasks={tasks} onOpen={setSelectedId} />
        </div>
      )}
    </aside>
  );
}
