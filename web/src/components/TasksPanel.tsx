import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LoaderIcon,
  XIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { stopBgTask } from '@/api/client';
import type { BgTask, ToolCall } from '@/api/types';
import { describeCall } from '@/lib/toolLabels';
import { cn, copyTextToClipboard, formatDurationMs } from '@/lib/utils';
import { useBgTasks } from '@/lib/useBgTasks';
import { useChat } from '@/state/chat';
import { useUi } from '@/state/ui';
import { Markdown } from './Markdown';
import { StatusBadge, StatusDisc } from './TaskRow';
import { ToolLabel } from './ToolLabel';
import { Tooltip } from './ui/misc';

/* The pane reads like Claude's background tasks: two sections, Running and
 * Finished, of task rows — a capsule each, with its state as a disc at the head
 * and spelled out at the end. A card unfolds in place into a plain log of
 * what the task did, with no headings or timeline of its own. */

type Outcome = 'running' | 'done' | 'failed' | 'stopped';

function outcomeOf(task: BgTask): Outcome {
  if (task.stopped) return 'stopped';
  if (task.status === 'running') return 'running';
  return task.status === 'failed' ? 'failed' : 'done';
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

/** What identifies a running task on its second line: its newest step, in the
 *  chat's own wording, or else what kind of job it is. */
function RunningDetail({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const steps = task.steps ?? [];
  const step = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];
  if (!step) {
    const kind =
      task.kind === 'subagent' ? (task.agent_type === 'worker' ? 'tasks.typeWorker' : 'tasks.typeResearch')
      : task.kind === 'agent' ? 'tasks.kindAgent'
      : 'tasks.kindShell';
    return <span className="block truncate text-xs text-muted-foreground">{t(kind)}</span>;
  }
  const call: ToolCall = { tool: step.tool, command: step.command, status: step.status };
  const running = step.status === 'running';
  return (
    <span className={cn('block truncate text-xs text-muted-foreground', running && 'shimmer-text')}>
      <ToolLabel parts={describeCall(call, t, running ? 'running' : 'past')} failed={step.status === 'error'} />
    </span>
  );
}

function TaskCard({ task, open, onToggle }: { task: BgTask; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const running = task.status === 'running';
  const { canStop, stop, stopping, error } = useStop(task);
  const title = task.label || t('tasks.untitled');
  // The body is mounted on first open and stays, so closing can animate and a
  // long finished list doesn't render every result up front.
  const [everOpen, setEverOpen] = useState(open);
  useEffect(() => {
    if (open) setEverOpen(true);
  }, [open]);
  const outcome = outcomeOf(task);
  const steps = task.steps?.length ?? 0;
  // The settled disc pops in only on a card that was seen running: a pane
  // opened on finished work has nothing to announce.
  const sawRunning = useRef(running);
  if (running) sawRunning.current = true;
  return (
    <article
      className={cn(
        // A capsule while closed; opening relaxes the corners into a card.
        'overflow-hidden bg-foreground/[0.045] transition-[border-radius,background-color] duration-300 hover:bg-foreground/[0.07] dark:bg-foreground/[0.055] dark:hover:bg-foreground/[0.08]',
        open ? 'rounded-[14px]' : 'rounded-[22px]',
      )}
    >
      <div className="flex items-center gap-1 pe-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-1.5 ps-2.5 text-left"
        >
          {/* While it runs the ring counts the steps taken so far. */}
          <StatusDisc state={outcome} count={running && steps > 0 ? steps : undefined} animate={sawRunning.current} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-strong">{title}</span>
            {running && <RunningDetail task={task} />}
          </span>
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            <Elapsed task={task} />
          </span>
          {!running && (
            <StatusBadge state={task.timed_out ? 'failed' : outcome}>
              {task.timed_out ? t('tasks.timedOut') : t(`tasks.state.${outcome}`)}
            </StatusBadge>
          )}
          <ChevronDownIcon
            aria-hidden
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
          />
        </button>
        {canStop && (
          <Tooltip label={t('tasks.stop')}>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping}
              aria-label={t('tasks.stopNamed', { name: title })}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/90 transition-colors hover:bg-accent active:scale-95 disabled:opacity-50"
            >
              {stopping ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <svg viewBox="0 0 12 12" aria-hidden="true" className="size-2.5">
                  <rect width="12" height="12" rx="3" fill="currentColor" />
                </svg>
              )}
            </button>
          </Tooltip>
        )}
      </div>
      {error && <p className="px-3 pb-2 text-[11px] text-destructive-foreground">{error}</p>}
      <div className={cn('collapse-grid', open && 'is-open')}>
        <div>{everOpen && <TaskDetail task={task} />}</div>
      </div>
    </article>
  );
}

/** A card's unfolded body, read top to bottom like a terminal: a shell job is
 *  its command and output; a subagent its assignment, the calls it made and
 *  what it came back with. */
function TaskDetail({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const running = task.status === 'running';
  const isShell = task.kind === 'shell';
  const steps = task.steps ?? [];
  // Follow the live end while it runs, like a log tail; leave the reader's
  // scroll position alone once it has settled.
  useEffect(() => {
    if (running && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [steps.length, task.output, running]);

  const copy = async () => {
    await copyTextToClipboard(task.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const output = task.output.replace(/\s+$/, '');
  const log = 'font-mono text-[11.5px] leading-relaxed break-words text-muted-foreground';

  return (
    <div ref={box} className="group/detail relative max-h-96 space-y-2.5 overflow-y-auto px-3 pt-0.5 pb-3">
      {output && (
        <Tooltip label={copied ? t('messages.copied') : t('tasks.copyOutput')}>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t('tasks.copyOutput')}
            className="absolute end-2 top-0 flex size-6 cursor-pointer items-center justify-center rounded-md bg-background/70 text-muted-foreground opacity-0 transition-opacity group-hover/detail:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </button>
        </Tooltip>
      )}
      {isShell ? (
        <pre className={cn(log, 'whitespace-pre-wrap')}>
          <span className="text-foreground/80">$ {task.label}</span>
          {output ? `\n${output}` : running ? `\n${t('tasks.noOutputYet')}` : ''}
          {!running && task.exit_code != null && `\n\n[${t('tasks.exitCode', { code: task.exit_code })}]`}
        </pre>
      ) : (
        <>
          {task.prompt && (
            <button
              type="button"
              onClick={() => setPromptOpen((v) => !v)}
              className={cn(log, 'block w-full cursor-pointer text-left whitespace-pre-wrap', !promptOpen && 'line-clamp-3')}
            >
              {task.prompt}
            </button>
          )}
          {steps.length > 0 && (
            // The calls it made, hung on a rail under the card's status disc.
            <div className="-mx-0.5 grid grid-cols-[24px_1fr] gap-2.5">
              <span aria-hidden className="mx-auto h-full w-px bg-foreground/12" />
              <ol className="flex min-w-0 flex-col gap-1.5 py-0.5 text-xs text-muted-foreground">
                {steps.map((step, i) => {
                  const call: ToolCall = { tool: step.tool, command: step.command, status: step.status };
                  const live = step.status === 'running';
                  return (
                    <li key={i} className={cn('fade-up min-w-0 break-words', live && 'shimmer-text')}>
                      <ToolLabel parts={describeCall(call, t, live ? 'running' : 'past')} failed={step.status === 'error'} />
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {output ? (
            <div className="text-[13px]">
              <Markdown text={task.output} streaming={running} />
            </div>
          ) : (
            !running && <p className={log}>{t('tasks.noOutput')}</p>
          )}
        </>
      )}
    </div>
  );
}

const newestFirst = (at: (task: BgTask) => number | null | undefined) => (a: BgTask, b: BgTask) => (at(b) ?? 0) - (at(a) ?? 0);

/** The chat's background work as a pane of the right-hand dock (see RightDock):
 *  delegated subagents, nested agent tasks and detached shell jobs. */
export function TasksPane({ className }: { className?: string }) {
  const { t } = useTranslation();
  const setOpen = useUi((s) => s.setTasksPanelOpen);
  const tasks = useBgTasks();
  const sessionId = useChat((s) => s.sessionId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [finishedOpen, setFinishedOpen] = useState(true);
  // A different chat has different tasks.
  useEffect(() => setExpanded(new Set()), [sessionId]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const running = tasks.filter((task) => task.status === 'running').sort(newestFirst((task) => task.started_at));
  const finished = tasks.filter((task) => task.status !== 'running').sort(newestFirst((task) => task.ended_at ?? task.started_at));
  const card = (task: BgTask) => (
    <TaskCard key={task.id} task={task} open={expanded.has(task.id)} onToggle={() => toggle(task.id)} />
  );

  return (
    <section className={className} aria-label={t('tasks.panelLabel')}>
      <div className="flex h-11 shrink-0 items-center gap-1 ps-3.5 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-strong">{t('tasks.panelLabel')}</h2>
        <button
          type="button"
          aria-label={t('tasks.closePanel')}
          onClick={() => setOpen(false)}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pb-3">
        {tasks.length === 0 && <p className="px-2 py-8 text-center text-sm text-muted-foreground">{t('tasks.empty')}</p>}
        {running.length > 0 && (
          <section>
            <h3 className="px-1 pb-2 text-xs text-muted-foreground">
              {t('tasks.sectionRunning')} <span className="tabular-nums">{running.length}</span>
            </h3>
            <div className="space-y-1.5">{running.map(card)}</div>
          </section>
        )}
        {finished.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setFinishedOpen((v) => !v)}
              aria-expanded={finishedOpen}
              className="flex cursor-pointer items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDownIcon className={cn('size-3.5 transition-transform duration-200', !finishedOpen && '-rotate-90')} />
              {t('tasks.sectionFinished')} <span className="tabular-nums">{finished.length}</span>
            </button>
            {finishedOpen && <div className="space-y-1.5">{finished.map(card)}</div>}
          </section>
        )}
      </div>
    </section>
  );
}
