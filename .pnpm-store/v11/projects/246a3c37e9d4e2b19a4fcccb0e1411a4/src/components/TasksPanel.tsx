import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotIcon, CheckIcon, ChevronDownIcon, CopyIcon, LoaderIcon, TerminalIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import type { BgTask } from '@/api/types';
import { cn, copyTextToClipboard, formatDurationMs } from '@/lib/utils';
import { useBgTasks } from '@/lib/useBgTasks';
import { useUi } from '@/state/ui';

/** Elapsed time for one job — live while it runs, frozen at its total once it
 *  has finished. `started_at`/`ended_at` come from the backend as Unix
 *  *seconds*, so both are scaled before they meet Date.now(). */
function TaskElapsed({ task }: { task: BgTask }) {
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

/** Status glyph: a spinner while it runs, a tick or a warning once it lands.
 *  Colour carries the outcome, so the row stays readable at a glance in a list
 *  where every label is a long command line. */
function StatusIcon({ status }: { status: BgTask['status'] }) {
  if (status === 'running') return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />;
  if (status === 'failed') return <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive-foreground" />;
  return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />;
}

/** The captured log, pinned to the bottom while the job is still writing —
 *  a live tail that scrolled away from the newest line would be useless. Once
 *  the job settles the view is left alone so the reader can scroll back. */
function TaskOutput({ task }: { task: BgTask }) {
  const { t } = useTranslation();
  const box = useRef<HTMLPreElement>(null);
  const running = task.status === 'running';
  useEffect(() => {
    if (running && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [task.output, running]);
  if (!task.output.trim()) {
    return (
      <p className="mt-2 text-xs text-muted-foreground italic">
        {running ? t('tasks.noOutputYet') : t('tasks.noOutput')}
      </p>
    );
  }
  return (
    <pre
      ref={box}
      className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground"
    >
      {task.output}
    </pre>
  );
}

function TaskRow({ task, defaultOpen }: { task: BgTask; defaultOpen: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const Icon = task.kind === 'agent' ? BotIcon : TerminalIcon;
  const outcome = task.timed_out
    ? t('tasks.timedOut')
    : task.status === 'failed'
      ? t('tasks.exitCode', { code: task.exit_code ?? -1 })
      : null;

  const copy = async () => {
    await copyTextToClipboard(task.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-md border bg-background/40 p-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
      >
        <StatusIcon status={task.status} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <Icon className="size-3 shrink-0 text-muted-foreground" />
            {/* The whole command, wrapped — a truncated one hides the argument
                that says which of four similar jobs this is. */}
            <span className="min-w-0 break-words">{task.label || t('tasks.untitled')}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{t(task.kind === 'agent' ? 'tasks.kindAgent' : 'tasks.kindShell')}</span>
            <span aria-hidden>·</span>
            <TaskElapsed task={task} />
            {outcome && (
              <>
                <span aria-hidden>·</span>
                <span className="text-destructive-foreground">{outcome}</span>
              </>
            )}
          </span>
        </span>
        <ChevronDownIcon className={cn('mt-0.5 size-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <TaskOutput task={task} />
          {task.output.trim() && (
            <button
              type="button"
              onClick={() => void copy()}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              {copied ? t('messages.copied') : t('tasks.copyOutput')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Right-side drawer listing the session's background jobs — detached shell
 *  commands and nested agent turns — with their live output.
 *
 *  Newest first: a job launched thirty seconds ago is the one being watched,
 *  and finished ones (kept for an hour after the agent has read them) sink
 *  below it. The first running job starts expanded, because opening the tray
 *  while something is running is a request to see that log. */
export function TasksPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.tasksPanelOpen);
  const setOpen = useUi((s) => s.setTasksPanelOpen);
  const tasks = useBgTasks();

  if (!open) return null;
  const ordered = [...tasks].reverse();
  const firstRunning = ordered.find((task) => task.status === 'running')?.id;
  const runningCount = tasks.filter((task) => task.status === 'running').length;

  return (
    <aside
      className="m-2 flex w-[26rem] max-w-[40vw] shrink-0 flex-col overflow-hidden rounded-md border bg-card shadow-lg"
      aria-label={t('tasks.panelLabel')}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <TerminalIcon className="size-4 text-primary" />
          {t('tasks.title')}
          {runningCount > 0 && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              · {t('tasks.runningCount', { count: runningCount })}
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
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {ordered.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">{t('tasks.empty')}</p>
        ) : (
          ordered.map((task) => (
            <TaskRow key={task.id} task={task} defaultOpen={task.id === firstRunning} />
          ))
        )}
      </div>
    </aside>
  );
}
