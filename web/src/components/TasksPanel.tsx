import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  ListChecksIcon,
  CloudSunIcon,
  CodeIcon,
  CopyIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  LoaderIcon,
  type LucideIcon,
  NewspaperIcon,
  PencilIcon,
  SearchIcon,
  SquareIcon,
  TerminalIcon,
  TextSearchIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { stopBgTask } from '@/api/client';
import type { BgTask, ToolCall } from '@/api/types';
import { describeCall, toolFamily } from '@/lib/toolLabels';
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
  // Each part keeps its separator and stays on one line, so a narrow panel
  // wraps between parts ("· großes Modell") rather than inside them.
  const parts: React.ReactNode[] = [
    <span key="state" className={cn(outcome === 'failed' && 'text-destructive-foreground')}>{state}</span>,
  ];
  if (task.kind === 'subagent') {
    // Which model a subagent ran on is a debugging detail — it is in the
    // chat's debug dump, not here.
    parts.push(<span key="type">{t(task.agent_type === 'worker' ? 'tasks.typeWorker' : 'tasks.typeResearch')}</span>);
  }
  parts.push(<Elapsed key="elapsed" task={task} />);
  if (steps > 0) parts.push(<span key="steps">{t('tasks.steps', { count: steps })}</span>);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {i > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
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

/** What a running task is doing right now — its newest step, in the chat's
 *  own wording. A sidebar shows several tasks at once, so this line is what
 *  tells them apart without opening each one. */
function CurrentStep({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  if (task.status !== 'running') return null;
  const steps = task.steps ?? [];
  const step = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];
  if (!step) return null;
  const call: ToolCall = { tool: step.tool, command: step.command, status: step.status };
  const running = step.status === 'running';
  return (
    <span className={cn('mt-0.5 block truncate text-[11.5px] text-muted-foreground', running && 'shimmer-text')}>
      <ToolLabel parts={describeCall(call, t, running ? 'running' : 'past')} failed={step.status === 'error'} />
    </span>
  );
}

function TaskListRow({ task, onOpen }: { task: BgTask; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent/60">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-1.5 text-left">
        <StatusDot task={task} className="mt-[5px]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">{task.label || t('tasks.untitled')}</span>
          <MetaLine task={task} />
          <CurrentStep task={task} />
        </span>
        <ChevronRightIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-muted-foreground" />
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

/** Thin progress bar: finished share of a plan or a subagent group. */
export function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span aria-hidden className="block h-1 w-full overflow-hidden rounded-full bg-muted">
      <span
        className="block h-full rounded-full bg-primary transition-[width] duration-500"
        style={{ width: `${total ? (done / total) * 100 : 0}%` }}
      />
    </span>
  );
}

function TaskList({ tasks, onOpen }: { tasks: BgTask[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  if (tasks.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('tasks.empty')}</p>;
  }
  return (
    <div className="space-y-3 p-1.5">
      {groupTasks(tasks).map((group) => {
        const finished = group.tasks.filter((task) => task.status !== 'running').length;
        return (
          <section key={group.key}>
            <h3 className="flex items-center gap-1 px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
              <span className="min-w-0 truncate">
                {group.subagents ? t('tasks.groupSubagents') : t(group.tasks[0].kind === 'agent' ? 'tasks.kindAgent' : 'tasks.kindShell')}
                {group.startedAt > 0 && <span className="font-normal"> · {clock(group.startedAt)}</span>}
              </span>
              {group.tasks.length > 1 && (
                <span className="ml-auto shrink-0 font-normal tabular-nums">{finished}/{group.tasks.length}</span>
              )}
            </h3>
            {group.tasks.length > 1 && finished < group.tasks.length && (
              <div className="px-2 pb-1.5">
                <Progress done={finished} total={group.tasks.length} />
              </div>
            )}
            {group.tasks.map((task) => (
              <TaskListRow key={task.id} task={task} onOpen={() => onOpen(task.id)} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h4>;
}

/** One glyph per tool family, so the timeline can be scanned by kind. */
const STEP_ICON: Record<string, LucideIcon> = {
  web: SearchIcon,
  fetch: GlobeIcon,
  news: NewspaperIcon,
  weather: CloudSunIcon,
  command: TerminalIcon,
  code: CodeIcon,
  read: FileTextIcon,
  write: PencilIcon,
  edit: PencilIcon,
  document: FileTextIcon,
  ls: FolderIcon,
  grep: TextSearchIcon,
  glob: FolderIcon,
  knowledge: BookOpenIcon,
  knowledgeList: BookOpenIcon,
  knowledgeRead: BookOpenIcon,
  knowledgeGrep: BookOpenIcon,
  sql: DatabaseIcon,
  image: ImageIcon,
};

/** What the subagent did, as a vertical timeline in the chat's own wording. */
function StepTimeline({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const steps = task.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <ol>
      {steps.map((step, i) => {
        const call: ToolCall = { tool: step.tool, command: step.command, status: step.status };
        const running = step.status === 'running';
        const failed = step.status === 'error';
        const Icon = running ? LoaderIcon : (STEP_ICON[toolFamily(step.tool)] ?? WrenchIcon);
        return (
          <li key={i} className="relative flex gap-2.5 pb-3 last:pb-0">
            {i < steps.length - 1 && (
              <span aria-hidden className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border" />
            )}
            <span
              aria-hidden
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border bg-card',
                running ? 'border-primary/40 text-primary'
                : failed ? 'border-destructive-foreground/40 text-destructive-foreground'
                : 'text-muted-foreground',
              )}
            >
              <Icon className={cn('size-3', running && 'animate-spin')} />
            </span>
            <span className={cn('min-w-0 pt-[3px] text-[12.5px] leading-snug break-words text-muted-foreground', running && 'shimmer-text')}>
              <ToolLabel parts={describeCall(call, t, running ? 'running' : 'past')} failed={failed} />
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
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-5">
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

/** The task list as a pane of the right-hand dock (see RightDock): the
 *  chat's background work — delegated subagents, nested agent tasks and
 *  detached shell jobs. A click opens one task on its
 *  own page within the pane. */
export function TasksPane({ className }: { className?: string }) {
  const { t } = useTranslation();
  const setOpen = useUi((s) => s.setTasksPanelOpen);
  const tasks = useBgTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sessionId = useChat((s) => s.sessionId);
  // A different chat has different tasks; never show a stale detail page.
  useEffect(() => setSelectedId(null), [sessionId]);

  const selected = selectedId ? tasks.find((task) => task.id === selectedId) : undefined;
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const iconBtn = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

  return (
    <section className={className} aria-label={t('tasks.panelLabel')}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-1.5">
        {selected ? (
          <button type="button" onClick={() => setSelectedId(null)} aria-label={t('tasks.back')} className={iconBtn}>
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : (
          <ListChecksIcon className="mx-1.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {selected ? t('tasks.detailTitle') : t('tasks.paneTitle')}
          {!selected && runningCount > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
              {t('tasks.runningCount', { count: runningCount })}
            </span>
          )}
        </span>
        <button type="button" aria-label={t('tasks.closePanel')} onClick={() => setOpen(false)} className={iconBtn}>
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
    </section>
  );
}
